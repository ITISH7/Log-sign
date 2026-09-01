import { randomBytes } from 'node:crypto';

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  backend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface SecretPersistence {
  read(name: string): Buffer | undefined;
  write(name: string, value: Buffer): void;
  delete(name: string): boolean;
}

export class InsecureCredentialBackendError extends Error {
  constructor() {
    super('Secure OS credential storage is unavailable; a database passphrase is required');
    this.name = 'InsecureCredentialBackendError';
  }
}

export class CredentialStore {
  constructor(
    private readonly safeStorage: SafeStoragePort,
    private readonly persistence: SecretPersistence,
    private readonly platform: NodeJS.Platform
  ) {}

  assertSecureBackend(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new InsecureCredentialBackendError();
    }
    if (this.platform === 'linux' && this.safeStorage.backend() === 'basic_text') {
      throw new InsecureCredentialBackendError();
    }
  }

  getOrCreateDatabaseKey(): Buffer {
    this.assertSecureBackend();
    const existing = this.persistence.read('database-key');
    if (existing) {
      return Buffer.from(this.safeStorage.decryptString(existing), 'hex');
    }
    const key = randomBytes(32);
    this.persistence.write('database-key', this.safeStorage.encryptString(key.toString('hex')));
    return key;
  }

  setProviderCredential(profileId: string, credential: string): void {
    this.assertSecureBackend();
    if (!credential.trim()) throw new Error('A provider credential cannot be empty');
    this.persistence.write(
      `provider:${profileId}`,
      this.safeStorage.encryptString(credential.trim())
    );
  }

  getProviderCredential(profileId: string): string | undefined {
    this.assertSecureBackend();
    const encrypted = this.persistence.read(`provider:${profileId}`);
    return encrypted ? this.safeStorage.decryptString(encrypted) : undefined;
  }

  deleteProviderCredential(profileId: string): boolean {
    return this.persistence.delete(`provider:${profileId}`);
  }
}
