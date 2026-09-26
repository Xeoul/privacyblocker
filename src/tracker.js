// Pure status logic for opt-out tracking. No DOM, no storage — easy to test.

export const DEFAULT_PROCESSING_DAYS = 14;
export const DEFAULT_RECHECK_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

export const STATUSES = {
  not_started: { label: 'Not started' },
  not_listed: { label: 'Not listed' },
  found: { label: 'Listed — needs opt-out' },
  submitted: { label: 'Submitted' },
  removed: { label: 'Removed' },
};

export function emptyRecord() {
  return { status: 'not_started', changedAt: null, listingUrl: '', notes: '', history: [] };
}

export function getRecord(state, brokerId) {
  return { ...emptyRecord(), ...(state.tracker?.[brokerId] || {}) };
}

// Returns a new record; does not mutate.
export function setStatus(record, status, now = new Date()) {
  if (!STATUSES[status]) throw new Error(`Unknown status: ${status}`);
  const at = now.toISOString();
  const history = [...(record.history || []), { status, at }].slice(-50);
  return { ...record, status, changedAt: at, history };
}

function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * DAY);
}

// What the user should do next for this broker, and when.
// Returns { action, dueAt: Date|null } or null when nothing is scheduled.
export function nextAction(broker, record) {
  const processing = broker.processingDays ?? DEFAULT_PROCESSING_DAYS;
  const recheck = broker.recheckDays ?? DEFAULT_RECHECK_DAYS;
  switch (record.status) {
    case 'found':
      return { action: 'Submit the opt-out', dueAt: record.changedAt ? new Date(record.changedAt) : null };
    case 'submitted':
      return { action: 'Check that the listing is gone', dueAt: addDays(record.changedAt, processing) };
    case 'removed':
    case 'not_listed':
      return { action: 'Re-check for a new listing', dueAt: addDays(record.changedAt, recheck) };
    default:
      return null;
  }
}

export function isDue(broker, record, now = new Date()) {
  const next = nextAction(broker, record);
  return !!next && !!next.dueAt && next.dueAt <= now;
}

export function summarize(brokers, state, now = new Date()) {
  const counts = Object.fromEntries(Object.keys(STATUSES).map((s) => [s, 0]));
  const due = [];
  for (const b of brokers) {
    const r = getRecord(state, b.id);
    counts[r.status]++;
    if (isDue(b, r, now)) due.push({ broker: b, record: r, next: nextAction(b, r) });
  }
  due.sort((a, b) => a.next.dueAt - b.next.dueAt);
  const done = counts.removed + counts.not_listed;
  return { counts, due, done, total: brokers.length };
}

// Highest-priority brokers the user hasn't touched yet.
export function nextUp(brokers, state, limit = 5) {
  return brokers
    .filter((b) => getRecord(state, b.id).status === 'not_started')
    .sort((a, b) => a.priority - b.priority)
    .slice(0, limit);
}

export function daysUntil(date, now = new Date()) {
  return Math.round((date.getTime() - now.getTime()) / DAY);
}
