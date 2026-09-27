import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autopilotProfile } from '../src/autopilot.js';

test('formats vault profile for the autopilot secret', () => {
  const text = autopilotProfile({
    profile: { fullName: 'Jane Q Public', currentAddress: '1 Main St\nSan Jose, CA', phones: '555-0100\n555-0101', otherNames: '', dob: '' },
    drop: { submitted: true },
  });
  assert.equal(text, [
    'name: Jane Q Public',
    'address: 1 Main St, San Jose, CA',
    'phone: 555-0100',
    'phone: 555-0101',
    'drop: yes',
    'share: name, address, phone',
  ].join('\n'));
});
