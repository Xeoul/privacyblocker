import datetime as dt
import unittest
from email.message import EmailMessage
from unittest import mock

import autopilot as ap

PROFILE = """
# comment
name: Jane Q Public
other name: Jane Smith
address: 1 Main St, San Jose, CA 95112
phone: 408-555-0100
phone: 408-555-0101
dob: 1990-01-02
drop: yes
"""


class ProfileTests(unittest.TestCase):
    def test_parse(self):
        p = ap.parse_profile(PROFILE)
        self.assertEqual(p['name'], ['Jane Q Public'])
        self.assertEqual(p['other_name'], ['Jane Smith'])
        self.assertEqual(len(p['phone']), 2)
        self.assertEqual(p['_share'], ap.DEFAULT_SHARE)
        self.assertTrue(p['_drop'])

    def test_share_list_filters_unknown(self):
        p = ap.parse_profile('name: A\nshare: name, dob, bogus')
        self.assertEqual(p['_share'], ['name', 'dob'])
        self.assertFalse(p['_drop'])

    def test_name_required(self):
        with self.assertRaises(ValueError):
            ap.parse_profile('address: x')


class RequestTests(unittest.TestCase):
    def test_only_shared_fields(self):
        p = ap.parse_profile(PROFILE)
        subject, body = ap.build_request('Acme', p, dt.date(2026, 9, 27))
        self.assertTrue(subject.startswith(ap.SUBJECT_PREFIX))
        self.assertIn('Jane Q Public', subject)
        self.assertIn('1798.105', body)
        self.assertIn('408-555-0101', body)
        self.assertNotIn('1990-01-02', body)  # dob not shared by default
        self.assertIn('DROP', body)

    def test_no_drop_line_unless_submitted(self):
        p = ap.parse_profile('name: A')
        self.assertNotIn('DROP', ap.build_request('Acme', p, dt.date.today())[1])


class LinkTests(unittest.TestCase):
    def test_extract_and_filter(self):
        html = ('<a href="https://www.spokeo.com/optout/confirm?t=1&amp;x=2">Confirm</a>'
                '<a href="https://www.spokeo.com/unsubscribe?t=1">unsub</a>'
                '<a href="https://evil.example/confirm">phish</a>'
                '<a href="http://www.spokeo.com/confirm">insecure</a>'
                '<a href="https://www.spokeo.com/privacy-policy">policy</a>')
        links = ap.extract_links(html, 'or visit https://spokeo.com/verify/abc.')
        got = ap.confirmation_links(links, ['spokeo.com'])
        self.assertEqual(got, ['https://www.spokeo.com/optout/confirm?t=1&x=2', 'https://spokeo.com/verify/abc'])

    def test_host_matching(self):
        self.assertTrue(ap.host_matches('mail.spokeo.com', ['spokeo.com']))
        self.assertFalse(ap.host_matches('notspokeo.com', ['spokeo.com']))
        self.assertEqual(ap.sender_domain('Spokeo <noreply@Mail.Spokeo.com>'), 'mail.spokeo.com')


class CatalogTests(unittest.TestCase):
    def test_brokers_well_formed(self):
        brokers, extra = ap.load_brokers()
        ids = set()
        for b in brokers:
            self.assertNotIn(b['id'], ids)
            ids.add(b['id'])
            self.assertRegex(b['email'], r'^[^@\s]+@[^@\s]+\.[a-z]+$')
            self.assertNotIn('gmail.com', b['email'])
            self.assertTrue(b['domains'])
        self.assertGreater(len(brokers), 20)


def broker_mail(frm, subject, html):
    m = EmailMessage()
    m['From'], m['Subject'] = frm, subject
    m.set_content('plain')
    m.add_alternative(html, subtype='html')
    return m


class FakeMailbox:
    def __init__(self, *a, **k):
        self.done = []
        FakeMailbox.inst = self

    def broker_messages(self, domains):
        yield 'All', b'1', broker_mail('Spokeo <privacy@spokeo.com>', 'Confirm your opt-out',
                                       '<a href="https://www.spokeo.com/optout/confirm/xyz">Confirm</a>')
        yield 'All', b'2', broker_mail('Radaris <customer-service@radaris.com>', 'Re: your request', '<p>Please use our form</p>')

    def sent_recently(self, to_addr, days):
        return to_addr == 'privacy@ltvco.com'  # pretend BeenVerified was done recently

    def mark_done(self, folder, uid):
        self.done.append(uid)

    def close(self):
        pass


class FakeSender:
    def __init__(self, *a, **k):
        self.sent = []
        FakeSender.inst = self

    def send(self, to, subject, body):
        self.sent.append((to, subject, body))

    def close(self):
        pass


ENV = {'OPTOUT_EMAIL': 'me@gmail.com', 'OPTOUT_APP_PASSWORD': 'abcd efgh', 'PROFILE': PROFILE, 'AUTOPILOT_MODE': 'preview'}


class RunTests(unittest.TestCase):
    def setUp(self):
        for target, fake in (('Mailbox', FakeMailbox), ('Sender', FakeSender)):
            p = mock.patch.object(ap, target, fake)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(ap.time, 'sleep', lambda s: None)
        p.start()
        self.addCleanup(p.stop)

    def test_preview_sends_only_to_self(self):
        with mock.patch.object(ap, 'open_link') as ol:
            self.assertEqual(ap.run({**ENV}), 0)
            ol.assert_not_called()
        sent = FakeSender.inst.sent
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0], 'me@gmail.com')
        self.assertIn('PREVIEW ONLY', sent[0][2])
        self.assertEqual(FakeMailbox.inst.done, [])

    def test_live_sends_due_requests_and_confirms(self):
        with mock.patch.object(ap, 'open_link', return_value=(True, 'HTTP 200')) as ol:
            self.assertEqual(ap.run({**ENV, 'AUTOPILOT_MODE': 'live', 'MAX_SENDS_PER_RUN': '100'}), 0)
            ol.assert_called_once_with('https://www.spokeo.com/optout/confirm/xyz')
        brokers, _ = ap.load_brokers()
        sent = FakeSender.inst.sent
        to_brokers = [s for s in sent if s[0] != 'me@gmail.com']
        self.assertEqual(len(to_brokers), len(brokers) - 1)  # BeenVerified skipped
        summary = sent[-1]
        self.assertEqual(summary[0], 'me@gmail.com')
        self.assertIn('1 confirmed', summary[1])
        self.assertIn('Re: your request', summary[2])
        self.assertEqual(FakeMailbox.inst.done, [b'1', b'2'])

    def test_live_caps_sends_per_run(self):
        with mock.patch.object(ap, 'open_link', return_value=(True, 'HTTP 200')):
            self.assertEqual(ap.run({**ENV, 'AUTOPILOT_MODE': 'live'}), 0)
        sent = FakeSender.inst.sent
        self.assertEqual(len([s for s in sent if s[0] != 'me@gmail.com']), 8)
        self.assertIn('more requests will go out on the next daily runs', sent[-1][2])

    def test_off_and_missing_secrets(self):
        with mock.patch.object(ap, 'Mailbox', side_effect=AssertionError('should not connect')):
            self.assertEqual(ap.run({**ENV, 'AUTOPILOT_MODE': 'off'}), 0)
            self.assertEqual(ap.run({k: v for k, v in ENV.items() if k != 'AUTOPILOT_MODE'}), 0)  # default off
            self.assertEqual(ap.run({'AUTOPILOT_MODE': 'live'}), 0)  # not set up yet
            self.assertEqual(ap.run({'AUTOPILOT_MODE': 'live', 'OPTOUT_EMAIL': 'x@gmail.com'}), 1)
        self.assertEqual(ap.run({**ENV, 'AUTOPILOT_MODE': 'bogus'}), 1)


if __name__ == '__main__':
    unittest.main()


class FakeIMAP:
    def __init__(self, host):
        self.calls = []

    def login(self, u, p):
        self.calls.append(('login', u))

    def list(self):
        return 'OK', [b'(\\HasNoChildren) "/" "INBOX"',
                      b'(\\All \\HasNoChildren) "/" "[Gmail]/All Mail"',
                      b'(\\HasNoChildren \\Junk) "/" "[Gmail]/Spam"']

    def select(self, box, readonly=False):
        self.calls.append(('select', box))
        return 'OK', [b'1']

    def uid(self, cmd, *args):
        self.calls.append(('uid', cmd) + args)
        if cmd == 'SEARCH':
            return 'OK', [b'7' if 'spokeo' in args[1] else b'']
        if cmd == 'FETCH':
            return 'OK', [(b'7 (UID 7 BODY[] {10}', bytes(broker_mail('a@spokeo.com', 'x', '<p>x</p>')))]
        return 'OK', [None]


class MailboxTests(unittest.TestCase):
    def test_commands(self):
        with mock.patch.object(ap.imaplib, 'IMAP4_SSL', FakeIMAP):
            mb = ap.Mailbox('me@gmail.com', 'pw')
        self.assertEqual((mb.all_mail, mb.spam), ('[Gmail]/All Mail', '[Gmail]/Spam'))
        self.assertFalse(mb.sent_recently('privacy@ltvco.com', 180))
        search = [c for c in mb.imap.calls if c[:2] == ('uid', 'SEARCH')][-1]
        self.assertEqual(search[2], 'X-GM-RAW')
        self.assertEqual(search[3], '"in:sent to:privacy@ltvco.com subject:\\"%s\\" newer_than:180d"' % ap.SUBJECT_PREFIX)
        msgs = list(mb.broker_messages(['spokeo.com', 'radaris.com']))
        self.assertEqual(len(msgs), 2)  # one hit each in All Mail and Spam
        self.assertEqual(msgs[0][0], '[Gmail]/All Mail')
        mb.mark_done('[Gmail]/Spam', b'7')
        self.assertIn(('select', '"[Gmail]/Spam"'), mb.imap.calls)
        self.assertEqual(mb.imap.calls[-1], ('uid', 'STORE', b'7', '+X-GM-LABELS', '(privacyblocker-done)'))
