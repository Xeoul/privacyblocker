// The encrypted vault: one AES-GCM envelope in localStorage.
// The derived key lives only in memory and is dropped on lock.

import { DEFAULT_ITERATIONS, deriveKey, encryptJSON, openEnvelope, randomBytes, isEnvelope } from './crypto.js';

export const STORAGE_KEY = 'privacyblocker.vault.v1';

export function emptyState() {
  return {
    profile: {
      fullName: '', otherNames: '', dob: '', currentAddress: '',
      pastAddresses: '', phones: '', emails: '', optOutEmail: '',
    },
    drop: { submitted: false, submittedAt: null, dropId: '' },
    tracker: {},
    createdAt: new Date().toISOString(),
  };
}

function safeGet(storage) {
  try { return storage.getItem(STORAGE_KEY); } catch { return null; }
}

export class Vault {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.session = null; // { key, salt, iterations }
    this.state = null;
  }

  exists() {
    return !!safeGet(this.storage);
  }

  get unlocked() {
    return !!this.session;
  }

  readEnvelope() {
    const raw = safeGet(this.storage);
    return raw ? JSON.parse(raw) : null;
  }

  async create(passphrase, iterations = DEFAULT_ITERATIONS) {
    if (!passphrase || passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters');
    const salt = randomBytes(16);
    const key = await deriveKey(passphrase, salt, iterations);
    this.session = { key, salt, iterations };
    this.state = emptyState();
    await this.save();
  }

  async unlock(passphrase) {
    const env = this.readEnvelope();
    if (!env) throw new Error('No vault on this device');
    let opened;
    try {
      opened = await openEnvelope(passphrase, env);
    } catch {
      throw new Error('Wrong passphrase');
    }
    this.session = { key: opened.key, salt: opened.salt, iterations: opened.iterations };
    this.state = { ...emptyState(), ...opened.data };
  }

  lock() {
    this.session = null;
    this.state = null;
  }

  async save() {
    if (!this.session) throw new Error('Vault is locked');
    const { key, salt, iterations } = this.session;
    const env = await encryptJSON(key, salt, iterations, this.state);
    this.storage.setItem(STORAGE_KEY, JSON.stringify(env));
    return env;
  }

  async update(fn) {
    fn(this.state);
    await this.save();
  }

  async changePassphrase(current, next) {
    const env = this.readEnvelope();
    await openEnvelope(current, env).catch(() => { throw new Error('Current passphrase is wrong'); });
    if (!next || next.length < 8) throw new Error('Use a passphrase of at least 8 characters');
    const salt = randomBytes(16);
    const iterations = this.session.iterations;
    this.session = { key: await deriveKey(next, salt, iterations), salt, iterations };
    await this.save();
  }

  // Backups are the same encrypted envelope — safe to store in cloud drives.
  exportBackup() {
    return safeGet(this.storage);
  }

  async importBackup(text, passphrase) {
    let env;
    try { env = JSON.parse(text); } catch { throw new Error('Not a PrivacyBlocker backup file'); }
    if (!isEnvelope(env)) throw new Error('Not a PrivacyBlocker backup file');
    const opened = await openEnvelope(passphrase, env).catch(() => { throw new Error('Wrong passphrase for this backup'); });
    this.storage.setItem(STORAGE_KEY, JSON.stringify(env));
    this.session = { key: opened.key, salt: opened.salt, iterations: opened.iterations };
    this.state = { ...emptyState(), ...opened.data };
  }

  wipe() {
    try { this.storage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    this.lock();
  }
}
