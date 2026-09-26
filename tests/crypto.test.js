import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, encryptJSON, decryptJSON, openEnvelope, randomBytes, toBase64, fromBase64 } from '../src/crypto.js';

const ITER = 1000; // keep tests fast; the app uses 600k

test('base64 round-trips arbitrary bytes', () => {
  const b = randomBytes(64);
  assert.deepEqual(fromBase64(toBase64(b)), b);
});

test('encrypt/decrypt round-trip', async () => {
  const salt = randomBytes(16);
  const key = await deriveKey('correct horse', salt, ITER);
  const env = await encryptJSON(key, salt, ITER, { hello: 'world', n: 1 });
  assert.equal(env.v, 1);
  assert.ok(!env.ct.includes('world'));
  assert.deepEqual(await decryptJSON(key, env), { hello: 'world', n: 1 });
});

test('wrong passphrase is rejected', async () => {
  const salt = randomBytes(16);
  const key = await deriveKey('right one', salt, ITER);
  const env = await encryptJSON(key, salt, ITER, { secret: true });
  await assert.rejects(openEnvelope('wrong one', env));
  const ok = await openEnvelope('right one', env);
  assert.deepEqual(ok.data, { secret: true });
});

test('fresh IV per encryption', async () => {
  const salt = randomBytes(16);
  const key = await deriveKey('pw', salt, ITER);
  const a = await encryptJSON(key, salt, ITER, 1);
  const b = await encryptJSON(key, salt, ITER, 1);
  assert.notEqual(a.iv, b.iv);
});
