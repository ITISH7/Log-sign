import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretPersistence } from './credential-store';

export class FileSecretPersistence implements SecretPersistence {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  read(name: string): Buffer | undefined {
    try {
      return readFileSync(this.pathFor(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  write(name: string, value: Buffer): void {
    writeFileSync(this.pathFor(name), value, { mode: 0o600 });
  }

  delete(name: string): boolean {
    try {
      rmSync(this.pathFor(name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private pathFor(name: string): string {
    if (!/^[a-z0-9:_-]+$/i.test(name)) throw new Error('Invalid secret name');
    return join(this.directory, `${name.replace(/:/g, '__')}.bin`);
  }
}
