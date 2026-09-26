import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vault, STORAGE_KEY } from '../src/vault.js';

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('create, save, lock, unlock', async () => {
  const s = memStorage();
  const v = new Vault(s);
  assert.equal(v.exists(), false);
  await v.create('passphrase1', 1000);
  await v.update((st) => { st.profile.fullName = 'Jane Q Public'; });
  assert.ok(!s.getItem(STORAGE_KEY).includes('Jane'), 'stored data is encrypted');
  v.lock();
  assert.equal(v.unlocked, false);
  await assert.rejects(v.unlock('nope-nope'), /Wrong passphrase/);
  await v.unlock('passphrase1');
  assert.equal(v.state.profile.fullName, 'Jane Q Public');
});

test('rejects short passphrase', async () => {
  await assert.rejects(new Vault(memStorage()).create('short', 1000));
});

test('change passphrase', async () => {
  const v = new Vault(memStorage());
  await v.create('first-pass', 1000);
  await assert.rejects(v.changePassphrase('bad-guess', 'second-pass'));
  await v.changePassphrase('first-pass', 'second-pass');
  v.lock();
  await assert.rejects(v.unlock('first-pass'));
  await v.unlock('second-pass');
});

test('backup export/import into a fresh browser', async () => {
  const a = new Vault(memStorage());
  await a.create('backup-pass', 1000);
  await a.update((st) => { st.tracker.spokeo = { status: 'removed' }; });
  const b = new Vault(memStorage());
  await assert.rejects(b.importBackup(a.exportBackup(), 'wrong-pass'));
  await assert.rejects(b.importBackup('not json', 'backup-pass'));
  assert.equal(b.exists(), false, 'failed import writes nothing');
  await b.importBackup(a.exportBackup(), 'backup-pass');
  assert.equal(b.state.tracker.spokeo.status, 'removed');
});

test('wipe removes the vault', async () => {
  const v = new Vault(memStorage());
  await v.create('passphrase1', 1000);
  v.wipe();
  assert.equal(v.exists(), false);
  assert.equal(v.unlocked, false);
});
