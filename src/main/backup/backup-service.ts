import { gcm } from '@noble/ciphers/aes.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const MAGIC = Buffer.from('DSRB1');
const MINIMUM_PASSWORD_LENGTH = 12;

interface BackupHeader {
  schemaVersion: 1;
  salt: string;
  nonce: string;
  createdAt: string;
  argon: { t: number; m: number; p: number; dkLen: 32 };
}

interface BackupOptions {
  argonMemoryKiB?: number;
  argonIterations?: number;
  argonParallelism?: number;
}

export type DatabaseSnapshot = (targetPath: string) => Promise<unknown>;

export class BackupService {
  private readonly argon: BackupHeader['argon'];

  constructor(options: BackupOptions = {}) {
    this.argon = {
      t: options.argonIterations ?? 3,
      m: options.argonMemoryKiB ?? 64 * 1024,
      p: options.argonParallelism ?? 1,
      dkLen: 32
    };
  }

  async exportPortable(sourcePath: string, targetPath: string, password: string): Promise<void> {
    assertStrongPassword(password);
    const plaintext = await readFile(sourcePath);
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const header: BackupHeader = {
      schemaVersion: 1,
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      createdAt: new Date().toISOString(),
      argon: this.argon
    };
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.byteLength);
    const authenticatedHeader = Buffer.concat([MAGIC, length, headerBytes]);
    const key = await deriveKey(password, salt, header.argon);
    const ciphertext = Buffer.from(gcm(key, nonce, authenticatedHeader).encrypt(plaintext));

    await atomicWrite(targetPath, Buffer.concat([authenticatedHeader, ciphertext]));
  }

  async restorePortable(sourcePath: string, targetPath: string, password: string): Promise<void> {
    assertStrongPassword(password);
    const artifact = await readFile(sourcePath);
    try {
      const { header, authenticatedHeader, ciphertext } = parseArtifact(artifact);
      const key = await deriveKey(password, Buffer.from(header.salt, 'base64'), header.argon);
      const plaintext = Buffer.from(
        gcm(key, Buffer.from(header.nonce, 'base64'), authenticatedHeader).decrypt(ciphertext)
      );
      await atomicWrite(targetPath, plaintext);
    } catch (error) {
      throw new Error('Unable to decrypt backup. Check the password and backup file.', { cause: error });
    }
  }

  async createAutomatic(
    backupDirectory: string,
    now: Date,
    snapshot: DatabaseSnapshot,
    dailyRetention = 7,
    weeklyRetention = 4
  ): Promise<string> {
    await mkdir(backupDirectory, { recursive: true });
    const filename = `dsr-${now.toISOString().slice(0, 10)}.db`;
    const targetPath = join(backupDirectory, filename);
    if (await exists(targetPath)) return targetPath;

    const temporaryPath = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await snapshot(temporaryPath);
      await rename(temporaryPath, targetPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }

    const names = (await readdir(backupDirectory)).filter((name) => /^dsr-\d{4}-\d{2}-\d{2}\.db$/.test(name));
    const keep = new Set(selectBackupsToKeep(names, dailyRetention, weeklyRetention));
    await Promise.all(names.filter((name) => !keep.has(name)).map((name) => rm(join(backupDirectory, name))));
    return targetPath;
  }
}

export function selectBackupsToKeep(names: string[], dailyRetention = 7, weeklyRetention = 4): string[] {
  const sorted = [...names]
    .filter((name) => /^dsr-\d{4}-\d{2}-\d{2}\.db$/.test(basename(name)))
    .sort((a, b) => b.localeCompare(a));
  const daily = sorted.slice(0, dailyRetention);
  const dailySet = new Set(daily);
  const weekly: string[] = [];
  const weeks = new Set<string>();

  for (const name of sorted) {
    if (dailySet.has(name)) continue;
    const date = new Date(`${basename(name).slice(4, 14)}T00:00:00Z`);
    const key = isoWeekKey(date);
    if (!weeks.has(key)) {
      weeks.add(key);
      weekly.push(name);
    }
    if (weekly.length === weeklyRetention) break;
  }
  return [...daily, ...weekly];
}

async function deriveKey(password: string, salt: Uint8Array, argon: BackupHeader['argon']): Promise<Uint8Array> {
  return argon2idAsync(password, salt, {
    ...argon,
    maxmem: Math.max(argon.m * 1024 + 1024 * 1024, 2 * 1024 * 1024),
    asyncTick: 8
  });
}

function parseArtifact(artifact: Buffer): {
  header: BackupHeader;
  authenticatedHeader: Buffer;
  ciphertext: Buffer;
} {
  if (artifact.byteLength < 10 || !artifact.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    throw new Error('Unsupported backup file');
  }
  const headerLength = artifact.readUInt32BE(MAGIC.byteLength);
  const bodyOffset = MAGIC.byteLength + 4 + headerLength;
  if (headerLength < 1 || bodyOffset >= artifact.byteLength) throw new Error('Invalid backup header');
  const header = JSON.parse(artifact.subarray(MAGIC.byteLength + 4, bodyOffset).toString('utf8')) as BackupHeader;
  if (header.schemaVersion !== 1 || !header.salt || !header.nonce || header.argon?.dkLen !== 32) {
    throw new Error('Invalid backup metadata');
  }
  return {
    header,
    authenticatedHeader: artifact.subarray(0, bodyOffset),
    ciphertext: artifact.subarray(bodyOffset)
  };
}

async function atomicWrite(targetPath: string, data: Buffer): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, data, { mode: 0o600 });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function assertStrongPassword(password: string): void {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new Error(`Backup passwords must contain at least ${MINIMUM_PASSWORD_LENGTH} characters`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isoWeekKey(date: Date): string {
  const thursday = new Date(date);
  const day = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}
