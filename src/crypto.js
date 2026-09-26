// Passphrase-based encryption for the local vault.
// PBKDF2-SHA256 derives an AES-256-GCM key; nothing here ever leaves the device.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const DEFAULT_ITERATIONS = 600_000;

export function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function deriveKey(passphrase, salt, iterations = DEFAULT_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Returns a serialisable envelope: { v, kdf, iterations, salt, iv, ct }.
export async function encryptJSON(key, salt, iterations, value) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ct)),
  };
}

export async function decryptJSON(key, envelope) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(envelope.iv) },
    key,
    fromBase64(envelope.ct),
  );
  return JSON.parse(dec.decode(pt));
}

export function isEnvelope(x) {
  return !!x && x.v === 1 && typeof x.salt === 'string' && typeof x.iv === 'string'
    && typeof x.ct === 'string' && Number.isInteger(x.iterations) && x.iterations > 0;
}

// Throws on a wrong passphrase (AES-GCM authentication fails).
export async function openEnvelope(passphrase, envelope) {
  if (!isEnvelope(envelope)) throw new Error('Not a PrivacyBlocker vault file');
  const salt = fromBase64(envelope.salt);
  const key = await deriveKey(passphrase, salt, envelope.iterations);
  const data = await decryptJSON(key, envelope);
  return { key, salt, iterations: envelope.iterations, data };
}
