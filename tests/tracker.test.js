import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setStatus, nextAction, isDue, summarize, nextUp, emptyRecord, getRecord } from '../src/tracker.js';

const b = { id: 'x', priority: 1, processingDays: 10, recheckDays: 90 };
const t0 = new Date('2026-01-01T00:00:00Z');
const days = (n) => new Date(t0.getTime() + n * 864e5);

test('setStatus records history immutably', () => {
  const r0 = emptyRecord();
  const r1 = setStatus(r0, 'found', t0);
  assert.equal(r0.status, 'not_started');
  assert.equal(r1.status, 'found');
  assert.equal(r1.history.length, 1);
  assert.throws(() => setStatus(r1, 'bogus'));
});

test('submitted is due after processing days', () => {
  const r = setStatus(emptyRecord(), 'submitted', t0);
  assert.equal(nextAction(b, r).dueAt.toISOString(), days(10).toISOString());
  assert.equal(isDue(b, r, days(9)), false);
  assert.equal(isDue(b, r, days(10)), true);
});

test('removed and not_listed get re-checked', () => {
  for (const st of ['removed', 'not_listed']) {
    const r = setStatus(emptyRecord(), st, t0);
    assert.equal(isDue(b, r, days(89)), false);
    assert.equal(isDue(b, r, days(90)), true);
  }
});

test('found is due immediately; not_started never', () => {
  assert.equal(isDue(b, setStatus(emptyRecord(), 'found', t0), t0), true);
  assert.equal(nextAction(b, emptyRecord()), null);
});

test('defaults apply when broker has no timings', () => {
  const r = setStatus(emptyRecord(), 'submitted', t0);
  assert.equal(nextAction({ id: 'y' }, r).dueAt.toISOString(), days(14).toISOString());
});

test('summarize and nextUp', () => {
  const brokers = [
    { id: 'a', priority: 3 }, { id: 'b', priority: 1 }, { id: 'c', priority: 2 }, { id: 'd', priority: 1 },
  ];
  const state = { tracker: { d: setStatus(emptyRecord(), 'removed', t0), c: setStatus(emptyRecord(), 'submitted', t0) } };
  const s = summarize(brokers, state, days(20));
  assert.equal(s.counts.not_started, 2);
  assert.equal(s.done, 1);
  assert.deepEqual(s.due.map((d) => d.broker.id), ['c']);
  assert.deepEqual(nextUp(brokers, state).map((x) => x.id), ['b', 'a']);
  assert.equal(getRecord({}, 'zzz').status, 'not_started');
});
