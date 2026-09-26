import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, mailtoUrl } from '../src/requests.js';

const profile = { fullName: 'Jane Public', dob: '1990-01-02', currentAddress: '1 Main St\nSan Jose, CA', phones: '555-0100\n555-0101' };

test('includes only selected fields', () => {
  const { subject, body } = buildRequest({ brokerName: 'Acme', profile, fields: ['fullName', 'phones'] });
  assert.match(subject, /Jane Public/);
  assert.match(body, /1798\.105/);
  assert.match(body, /555-0101/);
  assert.doesNotMatch(body, /1990-01-02/);
  assert.doesNotMatch(body, /Main St/);
});

test('mentions DROP only when submitted', () => {
  assert.doesNotMatch(buildRequest({ brokerName: 'A', profile }).body, /DROP/);
  assert.match(buildRequest({ brokerName: 'A', profile, dropSubmitted: true }).body, /DROP/);
});

test('listing URL included when selected', () => {
  const { body } = buildRequest({ brokerName: 'A', profile, listingUrl: 'https://ex.com/p/1', fields: ['listingUrl'] });
  assert.match(body, /https:\/\/ex\.com\/p\/1/);
});

test('mailto encodes subject and body', () => {
  const url = mailtoUrl('support+optout@x.com', { subject: 'Hi & bye', body: 'a\nb' });
  assert.ok(url.startsWith('mailto:support+optout@x.com?'));
  assert.match(url, /subject=Hi%20%26%20bye/);
  assert.match(url, /body=a%0Ab/);
});
