"""PrivacyBlocker autopilot.

Runs on a schedule (GitHub Actions) against your opt-out Gmail account:

1. Sends a California privacy-law deletion / opt-out request to every broker in
   brokers.json that hasn't had one from you in RESEND_DAYS.
2. Finds broker emails in the mailbox, opens their confirmation links, and
   labels them so they're handled once.
3. Emails you a summary of what it did and what needs your attention.

The mailbox itself is the state (sent requests are found by searching Sent
mail), so nothing personal is ever written to the repository.

Logs are public on a public repo: this script prints counts only, never
names, addresses or email contents.

Standard library only. Gmail only (it uses Gmail's IMAP search extensions).
"""

from __future__ import annotations

import datetime as dt
import email
import email.policy
import html
import imaplib
import json
import os
import re
import smtplib
import sys
import time
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.utils import formataddr, parseaddr
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
DONE_LABEL = 'privacyblocker-done'
SUBJECT_PREFIX = 'CCPA Request to Delete and Opt-Out of Sale/Sharing'
USER_AGENT = ('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
              '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')

FIELD_LABELS = {
    'name': 'Full name',
    'other_name': 'Other names I have used',
    'address': 'Current address',
    'past_address': 'Previous addresses',
    'phone': 'Phone numbers',
    'email': 'Email addresses',
    'dob': 'Date of birth',
}
DEFAULT_SHARE = ['name', 'address', 'phone']

CONFIRM_WORDS = re.compile(r'confirm|verif|validat|opt-?out|optout|remov|suppress', re.I)
AVOID_WORDS = re.compile(r'unsubscrib|login|log-in|signin|sign-in|upgrade|checkout|pricing|subscribe|'
                         r'report|search\?|facebook|twitter|instagram|/terms|/tos\b|/help\b', re.I)


# ---------------------------------------------------------------- pure logic

def parse_profile(text: str) -> dict:
    """Parse the PROFILE secret: `key: value` lines, keys may repeat."""
    profile: dict[str, list[str]] = {}
    for raw in (text or '').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or ':' not in line:
            continue
        key, value = line.split(':', 1)
        key = key.strip().lower().replace(' ', '_').replace('-', '_')
        value = value.strip()
        if value:
            profile.setdefault(key, []).append(value)
    drop = profile.pop('drop', [''])[0].lower()
    profile['_drop'] = drop in ('yes', 'y', 'true', 'submitted')
    share = profile.pop('share', None)
    if share:
        fields = [f.strip().lower().replace(' ', '_') for f in ','.join(share).split(',') if f.strip()]
        profile['_share'] = [f for f in fields if f in FIELD_LABELS]
    else:
        profile['_share'] = list(DEFAULT_SHARE)
    if not profile.get('name'):
        raise ValueError('PROFILE needs at least a "name:" line')
    return profile


def build_request(broker_name: str, profile: dict, today: dt.date) -> tuple[str, str]:
    name = profile['name'][0]
    id_lines = []
    for field in profile['_share']:
        values = profile.get(field) or []
        if not values:
            continue
        label = FIELD_LABELS[field]
        if len(values) == 1:
            id_lines.append(f'- {label}: {values[0]}')
        else:
            id_lines.append(f'- {label}:\n' + '\n'.join(f'    {v}' for v in values))
    subject = f'{SUBJECT_PREFIX} — {name}'
    body = '\n'.join([
        f'To the privacy team at {broker_name},',
        '',
        'I am a California resident. Under the California Consumer Privacy Act, as amended by the CPRA, I request that you:',
        '',
        '1. Delete all personal information you hold about me (Cal. Civ. Code § 1798.105), and direct your service providers and contractors to do the same.',
        '2. Stop selling or sharing my personal information (Cal. Civ. Code § 1798.120).',
        '3. Limit any use of my sensitive personal information (Cal. Civ. Code § 1798.121).',
        '',
        'The following is provided solely to locate my records. Under Cal. Civ. Code § 1798.130(a)(7) it may be used only to process this request; do not add it to your database:',
        '',
        *(id_lines or ['- (see my name above)']),
        '',
        'Please confirm receipt within 10 business days and complete this request within 45 calendar days, as required by Cal. Civ. Code § 1798.130 and its regulations. If you need more information to verify this request, reply to this email. If you deny any part of it, please explain the legal basis.',
        '',
        *([
            'I have also submitted a deletion request through the California Delete Request and Opt-out Platform (DROP). If you are a registered data broker, you are separately required to process it under the Delete Act (Cal. Civ. Code § 1798.99.86).',
            '',
        ] if profile.get('_drop') else []),
        'Thank you,',
        name,
        today.isoformat(),
    ])
    return subject, body


def host_matches(host: str, domains: list[str]) -> bool:
    host = (host or '').lower().rstrip('.')
    return any(host == d or host.endswith('.' + d) for d in domains)


def sender_domain(from_header: str) -> str:
    addr = parseaddr(from_header or '')[1].lower()
    return addr.rsplit('@', 1)[-1] if '@' in addr else ''


def extract_links(html_body: str, text_body: str) -> list[str]:
    links = [html.unescape(u) for u in re.findall(r'href\s*=\s*["\']([^"\']+)["\']', html_body or '', re.I)]
    links += re.findall(r'https?://[^\s<>"\')\]]+', text_body or '')
    seen, out = set(), []
    for u in links:
        u = u.strip().rstrip('.,;')
        if u.lower().startswith('https://') and u not in seen:
            seen.add(u)
            out.append(u)
    return out


def confirmation_links(links: list[str], domains: list[str]) -> list[str]:
    """Links on the broker's own domain that look like confirm/verify/opt-out actions."""
    return [u for u in links
            if host_matches(urlparse(u).hostname or '', domains)
            and CONFIRM_WORDS.search(u) and not AVOID_WORDS.search(u)]


def load_brokers(path: Path = HERE / 'brokers.json') -> tuple[list[dict], list[str]]:
    data = json.loads(path.read_text())
    return data['brokers'], data.get('confirm_only_domains', [])


def all_domains(brokers: list[dict], extra: list[str]) -> list[str]:
    return sorted({d for b in brokers for d in b['domains']} | set(extra))


def broker_for_domain(domain: str, brokers: list[dict]) -> dict | None:
    for b in brokers:
        if host_matches(domain, b['domains']):
            return b
    return None


# ---------------------------------------------------------------- mailbox IO

def _find_folder(imap: imaplib.IMAP4_SSL, flag: str, fallback: str) -> str:
    typ, rows = imap.list()
    for row in rows or []:
        line = row.decode(errors='replace')
        if flag in line:
            m = re.search(r'"([^"]+)"\s*$', line) or re.search(r'(\S+)\s*$', line)
            if m:
                return m.group(1)
    return fallback


def _q(folder: str) -> str:
    return '"' + folder.replace('"', '\\"') + '"'


class Mailbox:
    def __init__(self, user: str, password: str, host: str = 'imap.gmail.com'):
        self.imap = imaplib.IMAP4_SSL(host)
        self.imap.login(user, password)
        self.all_mail = _find_folder(self.imap, '\\All', '[Gmail]/All Mail')
        self.spam = _find_folder(self.imap, '\\Junk', '[Gmail]/Spam')

    def gm_search(self, folder: str, query: str) -> list[bytes]:
        self.imap.select(_q(folder), readonly=False)
        typ, data = self.imap.uid('SEARCH', 'X-GM-RAW', '"' + query.replace('"', '\\"') + '"')
        return data[0].split() if typ == 'OK' and data and data[0] else []

    def sent_recently(self, to_addr: str, days: int) -> bool:
        return bool(self.gm_search(self.all_mail, f'in:sent to:{to_addr} subject:"{SUBJECT_PREFIX}" newer_than:{days}d'))

    def broker_messages(self, domains: list[str], days: int = 30):
        """Yield (folder, uid, message) for unhandled mail from broker domains."""
        from_q = ' OR '.join(domains)
        query = f'from:({from_q}) newer_than:{days}d -label:{DONE_LABEL}'
        for folder in (self.all_mail, self.spam):
            for uid in self.gm_search(folder, query):
                typ, data = self.imap.uid('FETCH', uid, '(BODY.PEEK[])')
                if typ == 'OK' and data and isinstance(data[0], tuple):
                    yield folder, uid, email.message_from_bytes(data[0][1], policy=email.policy.default)

    def mark_done(self, folder: str, uid: bytes):
        self.imap.select(_q(folder), readonly=False)
        self.imap.uid('STORE', uid, '+X-GM-LABELS', f'({DONE_LABEL})')

    def close(self):
        try:
            self.imap.logout()
        except Exception:
            pass


def message_bodies(msg) -> tuple[str, str]:
    html_body = text_body = ''
    for part in msg.walk():
        ctype = part.get_content_type()
        if part.get_content_maintype() == 'multipart' or part.get_filename():
            continue
        try:
            content = part.get_content()
        except Exception:
            continue
        if ctype == 'text/html':
            html_body += content
        elif ctype == 'text/plain':
            text_body += content
    return html_body, text_body


def open_link(url: str) -> tuple[bool, str]:
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'text/html,*/*'})
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            page = resp.read(200_000).decode('utf-8', 'replace').lower()
            # A page that still shows a form/button usually needs a human tap.
            needs_tap = '<form' in page and ('confirm' in page or 'submit' in page)
            return (not needs_tap), f'HTTP {resp.status}' + (' — page has a button to press' if needs_tap else '')
    except urllib.error.HTTPError as e:
        return False, f'HTTP {e.code}'
    except Exception as e:  # network errors: report the type only
        return False, type(e).__name__


class Sender:
    def __init__(self, user: str, password: str, display_name: str, host: str = 'smtp.gmail.com'):
        self.user, self.display_name = user, display_name
        self.smtp = smtplib.SMTP_SSL(host, 465, timeout=60)
        self.smtp.login(user, password)

    def send(self, to: str, subject: str, body: str):
        msg = EmailMessage()
        msg['From'] = formataddr((self.display_name, self.user))
        msg['To'] = to
        msg['Subject'] = subject
        msg.set_content(body)
        self.smtp.send_message(msg)

    def close(self):
        try:
            self.smtp.quit()
        except Exception:
            pass


# ---------------------------------------------------------------- run

def summary_text(mode: str, sent: list, drafts: list, clicked: list, manual: list, replies: list, errors: list) -> str:
    out = [f'PrivacyBlocker autopilot — {mode} run, {dt.date.today().isoformat()}', '']
    if mode == 'preview':
        out += ['PREVIEW ONLY: nothing was sent to brokers and no links were opened.',
                'When this looks right, set the repository variable AUTOPILOT_MODE to "live".', '']
    if sent:
        out += [f'Requests sent ({len(sent)}):', *[f'  - {n}' for n in sent], '']
    if clicked:
        out += [f'Confirmation links opened ({len(clicked)}):', *[f'  - {n}: {s}' for n, s in clicked], '']
    if manual:
        out += [f'Please tap these yourself ({len(manual)}) — the page needs a button press or blocked the robot:',
                *[f'  - {n} ({s}): {u}' for n, s, u in manual], '']
    if replies:
        out += [f'Broker replies to read ({len(replies)}) — search your inbox for these subjects:',
                *[f'  - {n}: "{s}"' for n, s in replies], '']
    if errors:
        out += [f'Problems ({len(errors)}):', *[f'  - {e}' for e in errors], '']
    if drafts:
        out += ['=' * 60, f'Drafts ({len(drafts)}) that live mode would send:', '']
        for to, name, subject, body in drafts:
            out += [f'--- To: {name} <{to}>', f'Subject: {subject}', '', body, '']
    return '\n'.join(out)


def run(env=os.environ) -> int:
    mode = (env.get('AUTOPILOT_MODE') or 'off').strip().lower()
    if mode not in ('off', 'preview', 'live'):
        print('AUTOPILOT_MODE must be off, preview or live')
        return 1
    if mode == 'off':
        print('Autopilot is off. Set the repository variable AUTOPILOT_MODE to "live" to turn it on.')
        return 0
    user, password, profile_text = env.get('OPTOUT_EMAIL'), env.get('OPTOUT_APP_PASSWORD'), env.get('PROFILE')
    missing = [k for k, v in (('OPTOUT_EMAIL', user), ('OPTOUT_APP_PASSWORD', password), ('PROFILE', profile_text)) if not v]
    if len(missing) == 3:
        print('Autopilot is not set up yet (no secrets). See autopilot/SETUP.md.')
        return 0
    if missing:
        print('Missing repository secrets: ' + ', '.join(missing))
        return 1
    try:
        profile = parse_profile(profile_text)
    except ValueError as e:
        print(str(e))
        return 1
    resend_days = int(env.get('RESEND_DAYS') or 180)
    brokers, confirm_only = load_brokers()
    domains = all_domains(brokers, confirm_only)
    today = dt.date.today()

    sent, drafts, clicked, manual, replies, errors = [], [], [], [], [], []
    mailbox = Mailbox(user, password.replace(' ', ''))
    sender = Sender(user, password.replace(' ', ''), profile['name'][0])
    try:
        # 1. Handle broker mail: confirmation links and replies.
        for folder, uid, msg in list(mailbox.broker_messages(domains)):
            dom = sender_domain(msg.get('From', ''))
            broker = broker_for_domain(dom, brokers)
            label = broker['name'] if broker else dom
            link_domains = broker['domains'] if broker else [d for d in confirm_only if host_matches(dom, [d])]
            html_body, text_body = message_bodies(msg)
            links = confirmation_links(extract_links(html_body, text_body), link_domains)
            subject = str(msg.get('Subject', ''))[:120]
            if links and mode == 'live':
                for url in links[:3]:
                    ok, status = open_link(url)
                    (clicked.append((label, status)) if ok else manual.append((label, status, url)))
                    time.sleep(1)
            elif links:
                manual.extend((label, 'preview — not opened', u) for u in links[:3])
            else:
                replies.append((label, subject))
            if mode == 'live':
                mailbox.mark_done(folder, uid)

        # 2. Send requests that are due.
        for b in brokers:
            try:
                if mailbox.sent_recently(b['email'], resend_days):
                    continue
                subject, body = build_request(b['name'], profile, today)
                if mode == 'live':
                    sender.send(b['email'], subject, body)
                    sent.append(b['name'])
                    time.sleep(2)
                else:
                    drafts.append((b['email'], b['name'], subject, body))
            except Exception as e:
                errors.append(f"{b['name']}: {type(e).__name__}")

        # 3. Summary to yourself when anything happened (always in preview).
        if mode == 'preview' or sent or clicked or manual or replies or errors:
            n_attention = len(manual) + len(replies) + len(errors)
            subj = (f'PrivacyBlocker autopilot preview: {len(drafts)} requests ready'
                    if mode == 'preview' else
                    f'PrivacyBlocker autopilot: {len(sent)} sent, {len(clicked)} confirmed, {n_attention} need you')
            sender.send(user, subj, summary_text(mode, sent, drafts, clicked, manual, replies, errors))
    finally:
        mailbox.close()
        sender.close()

    # Counts only — these logs can be public.
    print(f'mode={mode} sent={len(sent)} drafts={len(drafts)} confirmed={len(clicked)} '
          f'manual={len(manual)} replies={len(replies)} errors={len(errors)}')
    return 0


def main() -> int:
    try:
        return run()
    except imaplib.IMAP4.error:
        print('Gmail login or IMAP failed. Check OPTOUT_EMAIL / OPTOUT_APP_PASSWORD and that IMAP is on.')
        return 1
    except smtplib.SMTPAuthenticationError:
        print('Gmail rejected the app password. Create a new one and update OPTOUT_APP_PASSWORD.')
        return 1
    except Exception as e:  # never print the message: it can contain personal data
        print(f'Autopilot failed: {type(e).__name__}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
