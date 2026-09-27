import { Vault } from './vault.js';
import { BROKERS, CATEGORIES, REQUIREMENTS, DROP, CATALOG_VERIFIED, getBroker } from './brokers.js';
import { STATUSES, getRecord, setStatus, nextAction, summarize, nextUp, daysUntil } from './tracker.js';
import { buildRequest, mailtoUrl, FIELD_LABELS, DEFAULT_FIELDS } from './requests.js';
import { autopilotProfile } from './autopilot.js';

const vault = new Vault();
const root = document.getElementById('app');
const AUTO_LOCK_MS = 10 * 60 * 1000;
let idleTimer = null;
let brokerFilter = { q: '', category: '', status: '' };

// ---------- tiny DOM helper (never uses innerHTML, so user data can't inject markup) ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function extLink(href, text, cls = '') {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function dueText(date) {
  const n = daysUntil(date);
  if (n < 0) return `overdue ${-n}d`;
  if (n === 0) return 'due today';
  return `in ${n}d`;
}

let toastTimer;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast('Copy failed — select and copy manually');
  }
}

function lines(v) {
  return String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

// ---------- auto-lock ----------
function resetIdle() {
  clearTimeout(idleTimer);
  if (vault.unlocked) idleTimer = setTimeout(() => { lock(); toast('Locked after 10 minutes idle'); }, AUTO_LOCK_MS);
}
['click', 'keydown', 'pointermove', 'scroll'].forEach((e) => window.addEventListener(e, resetIdle, { passive: true }));

function lock() {
  vault.lock();
  clearTimeout(idleTimer);
  location.hash = '#/unlock';
  render();
}

// ---------- layout ----------
function shell(active, ...content) {
  const tab = (href, label) => h('a', { href, class: active === href ? 'tab active' : 'tab' }, label);
  return h('div', { class: 'shell' },
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, '◐'), 'PrivacyBlocker'),
      h('nav', { class: 'tabs' },
        tab('#/dashboard', 'Dashboard'), tab('#/brokers', 'Brokers'),
        tab('#/profile', 'My info'), tab('#/settings', 'Settings')),
      h('button', { class: 'btn ghost small', onclick: lock, title: 'Lock vault' }, 'Lock')),
    h('main', {}, ...content),
    h('footer', { class: 'foot' },
      'Stored only in this browser, encrypted. This page cannot make network requests. ',
      `Broker list checked ${CATALOG_VERIFIED}.`));
}

// ---------- setup / unlock ----------
function viewSetup() {
  const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Passphrase (8+ characters)', required: true });
  const pass2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat passphrase', required: true });
  const err = h('p', { class: 'error' });
  const form = h('form', {
    class: 'card narrow',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (pass.value !== pass2.value) { err.textContent = 'Passphrases don\'t match'; return; }
      const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Creating…';
      try { await vault.create(pass.value); location.hash = '#/profile'; render(); }
      catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Create vault'; }
    },
  },
  h('h1', {}, 'PrivacyBlocker'),
  h('p', {}, 'Get your personal info off data-broker and people-search sites. Everything you enter is encrypted with your passphrase and stays in this browser — there is no server and no account.'),
  h('p', { class: 'muted' }, 'There is no password reset. If you forget the passphrase, the vault cannot be recovered.'),
  h('label', {}, 'Passphrase', pass), h('label', {}, 'Confirm', pass2), err,
  h('button', { class: 'btn primary', type: 'submit' }, 'Create vault'),
  h('hr'),
  restoreControl());
  return h('div', { class: 'center' }, form);
}

function restoreControl() {
  const file = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden' });
  file.addEventListener('change', async () => {
    const f = file.files[0]; if (!f) return;
    const text = await f.text();
    const p = prompt('Passphrase for this backup:');
    if (!p) return;
    try { await vault.importBackup(text, p); toast('Backup restored'); location.hash = '#/dashboard'; render(); }
    catch (x) { alert(x.message); }
    file.value = '';
  });
  return h('div', {}, h('button', { class: 'btn ghost', type: 'button', onclick: () => file.click() }, 'Restore from backup file…'), file);
}

function viewUnlock() {
  const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Passphrase', autofocus: true });
  const err = h('p', { class: 'error' });
  const form = h('form', {
    class: 'card narrow',
    onsubmit: async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Unlocking…';
      try { await vault.unlock(pass.value); location.hash = '#/dashboard'; render(); }
      catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Unlock'; pass.select(); }
    },
  },
  h('h1', {}, 'Unlock'),
  h('label', {}, 'Passphrase', pass), err,
  h('button', { class: 'btn primary', type: 'submit' }, 'Unlock'));
  setTimeout(() => pass.focus(), 0);
  return h('div', { class: 'center' }, form);
}

// ---------- dashboard ----------
function dropCard() {
  const d = vault.state.drop;
  const idInput = h('input', { value: d.dropId, placeholder: 'DROP ID (optional)' });
  idInput.addEventListener('change', () => vault.update((s) => { s.drop.dropId = idInput.value.trim(); }));
  return h('section', { class: `card drop ${d.submitted ? 'done' : ''}` },
    h('div', { class: 'row between' },
      h('h2', {}, '1. California DROP'),
      d.submitted ? h('span', { class: 'pill removed' }, `Submitted ${fmtDate(d.submittedAt)}`) : h('span', { class: 'pill found' }, 'Do this first')),
    h('p', {}, DROP.summary),
    h('p', { class: 'muted' }, 'DROP only covers registered data brokers. Big people-search sites still get opted out one by one below — do both.'),
    h('div', { class: 'row wrap' },
      extLink(DROP.url, 'Open DROP ↗', 'btn primary'),
      extLink(DROP.infoUrl, 'How DROP works', 'btn ghost'),
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: d.submitted,
          onchange: (e) => vault.update((s) => {
            s.drop.submitted = e.target.checked;
            s.drop.submittedAt = e.target.checked ? new Date().toISOString() : null;
          }).then(render),
        }), 'I submitted my DROP request')),
    d.submitted ? h('label', {}, 'DROP ID — use it on the DROP site to check status', idInput) : null);
}

function brokerRow(b, extra) {
  const r = getRecord(vault.state, b.id);
  return h('a', { href: `#/broker/${b.id}`, class: 'item' },
    h('span', { class: `prio p${b.priority}`, title: `Priority ${b.priority}` }),
    h('span', { class: 'item-name' }, b.name),
    extra ?? h('span', { class: `pill ${r.status}` }, STATUSES[r.status].label));
}

function viewDashboard() {
  const s = summarize(BROKERS, vault.state);
  const pct = Math.round((s.done / s.total) * 100);
  const up = nextUp(BROKERS, vault.state);
  const profileEmpty = !vault.state.profile.fullName;
  return shell('#/dashboard',
    profileEmpty ? h('section', { class: 'card notice' }, 'Start by filling in ', h('a', { href: '#/profile' }, 'My info'), ' — it powers the copy buttons and request emails.') : null,
    dropCard(),
    h('section', { class: 'card' },
      h('h2', {}, '2. Opt-out checklist'),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
        h('div', { class: 'bar' })),
      h('div', { class: 'stats' },
        ...['found', 'submitted', 'removed', 'not_listed', 'not_started'].map((k) =>
          h('div', { class: 'stat' }, h('strong', {}, s.counts[k]), h('span', {}, STATUSES[k].label))))),
    h('section', { class: 'card' },
      h('h2', {}, 'Due now'),
      s.due.length
        ? h('div', { class: 'list' }, s.due.map(({ broker, next }) =>
          brokerRow(broker, h('span', { class: 'due' }, `${next.action} · ${dueText(next.dueAt)}`))))
        : h('p', { class: 'muted' }, 'Nothing due. Submitted requests and re-checks show up here when it\'s time.')),
    up.length ? h('section', { class: 'card' },
      h('h2', {}, 'Next up'),
      h('div', { class: 'list' }, up.map((b) => brokerRow(b)))) : null,
  );
}

// ---------- brokers list ----------
function viewBrokers() {
  const listEl = h('div', { class: 'list' });
  const draw = () => {
    const q = brokerFilter.q.toLowerCase();
    const items = BROKERS
      .filter((b) => !brokerFilter.category || b.category === brokerFilter.category)
      .filter((b) => !brokerFilter.status || getRecord(vault.state, b.id).status === brokerFilter.status)
      .filter((b) => !q || b.name.toLowerCase().includes(q) || (b.alsoCovers || []).some((c) => c.toLowerCase().includes(q)))
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    listEl.replaceChildren(...(items.length ? items.map((b) => brokerRow(b)) : [h('p', { class: 'muted' }, 'No matches.')]));
  };
  const search = h('input', { type: 'search', placeholder: 'Search brokers (incl. sister sites)', value: brokerFilter.q });
  search.addEventListener('input', () => { brokerFilter.q = search.value; draw(); });
  const sel = (key, opts) => {
    const s = h('select', {}, ...opts.map(([v, l]) => h('option', { value: v }, l)));
    s.value = brokerFilter[key];
    s.addEventListener('change', () => { brokerFilter[key] = s.value; draw(); });
    return s;
  };
  draw();
  return shell('#/brokers',
    h('section', { class: 'card' },
      h('div', { class: 'filters' }, search,
        sel('category', [['', 'All categories'], ...Object.entries(CATEGORIES)]),
        sel('status', [['', 'Any status'], ...Object.entries(STATUSES).map(([k, v]) => [k, v.label])])),
      h('p', { class: 'muted legend' },
        h('span', { class: 'prio p1' }), ' do first  ', h('span', { class: 'prio p2' }), ' high  ', h('span', { class: 'prio p3' }), ' normal'),
      listEl));
}

// ---------- broker detail ----------
function copyChips() {
  const p = vault.state.profile;
  const chips = [];
  const add = (label, v) => { if (v) chips.push(h('button', { class: 'chip', type: 'button', onclick: () => copy(v, `${label} copied`) }, `${label}: ${v}`)); };
  add('Name', lines(p.fullName)[0]);
  add('Opt-out email', p.optOutEmail);
  add('DOB', p.dob);
  lines(p.currentAddress).length && add('Address', lines(p.currentAddress).join(', '));
  lines(p.phones).forEach((ph) => add('Phone', ph));
  lines(p.otherNames).forEach((n) => add('Alias', n));
  if (!chips.length) return h('p', { class: 'muted' }, 'Add your details in ', h('a', { href: '#/profile' }, 'My info'), ' to get one-tap copy buttons here.');
  return h('div', { class: 'chips' }, chips);
}

function requestSection(b, record) {
  const p = vault.state.profile;
  const to = h('input', { type: 'email', value: b.email || '', placeholder: 'privacy@broker.com' });
  const selected = new Set(DEFAULT_FIELDS);
  const subject = h('input', {});
  const body = h('textarea', { rows: 16, class: 'mono' });
  const regen = () => {
    const req = buildRequest({ brokerName: b.name, profile: p, listingUrl: record.listingUrl, fields: [...selected], dropSubmitted: vault.state.drop.submitted });
    subject.value = req.subject; body.value = req.body;
  };
  const boxes = Object.entries(FIELD_LABELS).map(([k, label]) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: selected.has(k), onchange: (e) => { e.target.checked ? selected.add(k) : selected.delete(k); regen(); } }), label));
  regen();
  return h('details', { class: 'card', open: !!b.email && record.status === 'found' },
    h('summary', {}, h('h2', { class: 'inline' }, 'CCPA request email')),
    h('p', { class: 'muted' }, 'Use this when a broker takes requests by email, or when their form doesn\'t work. Only tick what they need to find you — anything you send may end up in their records.'),
    h('div', { class: 'checks' }, boxes),
    h('label', {}, 'To', to), h('label', {}, 'Subject', subject), h('label', {}, 'Message', body),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => { location.href = mailtoUrl(to.value, { subject: subject.value, body: body.value }); } }, 'Open in email app'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => copy(`${subject.value}\n\n${body.value}`, 'Email copied') }, 'Copy text')));
}

function viewBroker(id) {
  const b = getBroker(id);
  if (!b) return shell('#/brokers', h('section', { class: 'card' }, 'Unknown broker. ', h('a', { href: '#/brokers' }, 'Back')));
  const record = getRecord(vault.state, b.id);
  const next = nextAction(b, record);

  const saveRecord = (patch) => vault.update((s) => { s.tracker[b.id] = { ...getRecord(s, b.id), ...patch }; });
  const listing = h('input', { type: 'url', value: record.listingUrl, placeholder: 'https://… (paste the URL of your listing)' });
  listing.addEventListener('change', () => saveRecord({ listingUrl: listing.value.trim() }).then(() => toast('Saved')));
  const notes = h('textarea', { rows: 3, value: record.notes, placeholder: 'Anything to remember — confirmation numbers, who you emailed…' });
  notes.addEventListener('change', () => saveRecord({ notes: notes.value }).then(() => toast('Saved')));

  const statusBtn = (st, label) => h('button', {
    type: 'button',
    class: `btn status ${record.status === st ? 'active' : ''}`,
    onclick: () => vault.update((s) => { s.tracker[b.id] = setStatus(getRecord(s, b.id), st); }).then(render),
  }, label);

  return shell('#/brokers',
    h('a', { href: '#/brokers', class: 'back' }, '← All brokers'),
    h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h1', {}, b.name), h('span', { class: `pill ${record.status}` }, STATUSES[record.status].label)),
      h('p', { class: 'muted' }, CATEGORIES[b.category], b.priority === 1 ? ' · do first' : b.priority === 2 ? ' · high priority' : ''),
      b.alsoCovers?.length ? h('p', {}, h('strong', {}, 'Also covers: '), b.alsoCovers.join(', ')) : null,
      b.requires.length ? h('div', { class: 'badges' }, b.requires.map((r) => h('span', { class: 'badge' }, REQUIREMENTS[r]))) : null,
      h('div', { class: 'row wrap' },
        b.searchUrl && b.searchUrl !== b.optOutUrl ? extLink(b.searchUrl, '1. Search for yourself ↗', 'btn ghost') : null,
        extLink(b.optOutUrl, b.searchUrl && b.searchUrl !== b.optOutUrl ? '2. Opt-out page ↗' : 'Open opt-out page ↗', 'btn primary')),
      h('ol', { class: 'steps' }, b.steps.map((s) => h('li', {}, s))),
      next?.dueAt ? h('p', { class: 'due' }, `Next: ${next.action} — ${fmtDate(next.dueAt)} (${dueText(next.dueAt)})`) : null),
    h('section', { class: 'card' },
      h('h2', {}, 'Your details'),
      h('p', { class: 'muted' }, 'Only give a broker information it already shows about you.'),
      copyChips()),
    h('section', { class: 'card' },
      h('h2', {}, 'Status'),
      h('div', { class: 'row wrap' },
        statusBtn('not_listed', 'Not listed'), statusBtn('found', 'I\'m listed'),
        statusBtn('submitted', 'Submitted opt-out'), statusBtn('removed', 'Confirmed removed')),
      h('label', {}, 'Listing URL', listing),
      h('label', {}, 'Notes', notes),
      record.history.length ? h('details', {},
        h('summary', {}, `History (${record.history.length})`),
        h('ul', { class: 'history' }, [...record.history].reverse().map((e) => h('li', {}, `${fmtDate(e.at)} — ${STATUSES[e.status]?.label || e.status}`)))) : null),
    requestSection(b, record));
}

// ---------- profile ----------
function viewProfile() {
  const p = vault.state.profile;
  const field = (key, label, { multi = false, type = 'text', help = '' } = {}) => {
    const el = multi ? h('textarea', { rows: 3, value: p[key] }) : h('input', { type, value: p[key] });
    el.dataset.key = key;
    return h('label', {}, label, help ? h('small', { class: 'muted' }, help) : null, el);
  };
  const form = h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      await vault.update((s) => { form.querySelectorAll('[data-key]').forEach((el) => { s.profile[el.dataset.key] = el.value.trim(); }); });
      toast('Saved (encrypted)');
    },
  },
  h('h1', {}, 'My info'),
  h('p', { class: 'muted' }, 'Used to fill copy buttons and request emails. Encrypted with your passphrase; never sent anywhere unless you copy it into a broker form or email.'),
  field('fullName', 'Full legal name'),
  field('otherNames', 'Other names / maiden names / nicknames', { multi: true, help: 'One per line' }),
  field('dob', 'Date of birth', { type: 'date' }),
  field('currentAddress', 'Current address', { multi: true }),
  field('pastAddresses', 'Previous addresses', { multi: true, help: 'One per line — brokers often list old addresses' }),
  field('phones', 'Phone numbers', { multi: true, help: 'One per line' }),
  field('emails', 'Email addresses', { multi: true, help: 'One per line' }),
  field('optOutEmail', 'Email to use for opt-outs', { type: 'email', help: 'Tip: use an alias (iCloud Hide My Email, SimpleLogin, Firefox Relay) so brokers don\'t learn your real address. Some brokers allow one opt-out per email.' }),
  h('button', { class: 'btn primary', type: 'submit' }, 'Save'));
  return shell('#/profile', form);
}

// ---------- settings ----------
function viewSettings() {
  const download = () => {
    const blob = new Blob([vault.exportBackup()], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `privacyblocker-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const cur = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Current passphrase' });
  const nxt = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New passphrase (8+ characters)' });
  return shell('#/settings',
    h('section', { class: 'card' },
      h('h2', {}, 'Backup'),
      h('p', { class: 'muted' }, 'Backups are the same encrypted file this browser stores — useless without your passphrase. Restore one on another device to move your progress there.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', type: 'button', onclick: download }, 'Download encrypted backup'),
        restoreControl())),
    h('section', { class: 'card' },
      h('h2', {}, 'Email autopilot'),
      h('p', { class: 'muted' }, 'The autopilot runs on GitHub and emails brokers for you. It needs your details as a GitHub secret called PROFILE. This copies them in the right format from My info.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => copy(autopilotProfile(vault.state), 'PROFILE copied — paste it into the GitHub secret') }, 'Copy autopilot PROFILE'),
        extLink('https://github.com/Xeoul/privacyblocker/blob/main/autopilot/SETUP.md', 'Setup steps ↗', 'btn ghost'))),
    h('section', { class: 'card' },
      h('h2', {}, 'Change passphrase'),
      h('div', { class: 'row wrap' }, cur, nxt,
        h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            try { await vault.changePassphrase(cur.value, nxt.value); cur.value = nxt.value = ''; toast('Passphrase changed'); }
            catch (x) { alert(x.message); }
          },
        }, 'Change'))),
    h('section', { class: 'card danger' },
      h('h2', {}, 'Delete everything'),
      h('p', {}, 'Removes the encrypted vault from this browser. Download a backup first if you want to keep your progress.'),
      h('button', {
        class: 'btn danger', type: 'button',
        onclick: () => { if (confirm('Delete your vault from this browser? This cannot be undone.')) { vault.wipe(); location.hash = ''; render(); } },
      }, 'Delete vault')));
}

// ---------- router ----------
function render() {
  const hash = location.hash || '#/dashboard';
  let view;
  if (!vault.exists()) view = viewSetup();
  else if (!vault.unlocked) view = viewUnlock();
  else if (hash.startsWith('#/broker/')) view = viewBroker(decodeURIComponent(hash.slice('#/broker/'.length)));
  else if (hash === '#/brokers') view = viewBrokers();
  else if (hash === '#/profile') view = viewProfile();
  else if (hash === '#/settings') view = viewSettings();
  else view = viewDashboard();
  root.replaceChildren(view);
  // CSP forbids inline style attributes, so set dynamic widths via CSSOM.
  const bar = root.querySelector('.progress .bar');
  if (bar) bar.style.width = `${bar.parentElement.getAttribute('aria-valuenow')}%`;
  resetIdle();
}

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
render();
