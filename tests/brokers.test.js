import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROKERS, CATEGORIES, REQUIREMENTS, DROP } from '../src/brokers.js';

test('catalog entries are well-formed', () => {
  const ids = new Set();
  for (const b of BROKERS) {
    assert.ok(/^[a-z0-9-]+$/.test(b.id), b.id);
    assert.ok(!ids.has(b.id), `duplicate ${b.id}`); ids.add(b.id);
    assert.ok(CATEGORIES[b.category], `${b.id} category`);
    assert.ok([1, 2, 3].includes(b.priority), `${b.id} priority`);
    for (const u of [b.optOutUrl, b.searchUrl].filter(Boolean)) assert.ok(new URL(u).protocol === 'https:', `${b.id} ${u}`);
    for (const r of b.requires) assert.ok(REQUIREMENTS[r], `${b.id} requirement ${r}`);
    assert.ok(b.steps.length > 0, `${b.id} steps`);
    if (b.email) assert.match(b.email, /^[^@\s]+@[^@\s]+\.[a-z]+$/);
  }
  assert.ok(new URL(DROP.url));
});
