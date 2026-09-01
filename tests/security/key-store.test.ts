import { describe, expect, it } from 'vitest';
import {
  CredentialStore,
  InsecureCredentialBackendError,
  type SafeStoragePort,
  type SecretPersistence
} from '../../src/main/security/credential-store';

class MemoryPersistence implements SecretPersistence {
  readonly values = new Map<string, Buffer>();
  read(name: string) {
    return this.values.get(name);
  }
  write(name: string, value: Buffer) {
    this.values.set(name, value);
  }
  delete(name: string) {
    return this.values.delete(name);
  }
}

function safeStorage(backend = 'gnome_libsecret'): SafeStoragePort {
  return {
    isEncryptionAvailable: () => true,
    backend: () => backend,
    encryptString: (value) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString('utf8')
  };
}

describe('CredentialStore', () => {
  it('refuses Electron basic_text storage on Linux', () => {
    const store = new CredentialStore(
      safeStorage('basic_text'),
      new MemoryPersistence(),
      'linux'
    );

    expect(() => store.assertSecureBackend()).toThrow(InsecureCredentialBackendError);
  });

  it('creates one 32-byte database key and reuses it', () => {
    const persistence = new MemoryPersistence();
    const store = new CredentialStore(safeStorage(), persistence, 'linux');

    const first = store.getOrCreateDatabaseKey();
    const second = store.getOrCreateDatabaseKey();

    expect(first).toHaveLength(32);
    expect(second.equals(first)).toBe(true);
    expect(persistence.values.get('database-key')?.toString()).not.toContain(first.toString('hex'));
  });

  it('can replace a lost database key during authenticated backup recovery', () => {
    const persistence = new MemoryPersistence();
    const store = new CredentialStore(safeStorage(), persistence, 'win32');
    store.getOrCreateDatabaseKey();
    const replacement = Buffer.alloc(32, 12);

    store.replaceDatabaseKey(replacement);

    expect(store.getOrCreateDatabaseKey().equals(replacement)).toBe(true);
  });

  it('stores and removes provider credentials without exposing plaintext', () => {
    const persistence = new MemoryPersistence();
    const store = new CredentialStore(safeStorage(), persistence, 'win32');

    store.setProviderCredential('openai-profile', 'sk-private');

    expect(persistence.values.get('provider:openai-profile')?.toString()).not.toContain('sk-private');
    expect(store.getProviderCredential('openai-profile')).toBe('sk-private');
    expect(store.deleteProviderCredential('openai-profile')).toBe(true);
  });
});
