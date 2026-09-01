import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupService, replaceDatabaseFile, selectBackupsToKeep } from '../../src/main/backup/backup-service';
import { openEncryptedDatabase, rekeyEncryptedDatabase } from '../../src/main/storage/database';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsr-backup-test-'));
  cleanupPaths.push(directory);
  const databasePath = join(directory, 'dsr.db');
  await writeFile(databasePath, Buffer.from('SQLite format 3\0encrypted database fixture'));
  return { directory, databasePath };
}

describe('portable backups', () => {
  it('encrypts database bytes and restores them with the correct password', async () => {
    const { directory, databasePath } = await fixture();
    const target = join(directory, 'portable.dsrbackup');
    const restored = join(directory, 'restored.db');
    const backups = new BackupService({ argonMemoryKiB: 64, argonIterations: 1 });

    await backups.exportPortable(databasePath, target, 'correct horse battery staple');

    const artifact = await readFile(target);
    expect(artifact.subarray(0, 5).toString()).toBe('DSRB1');
    expect(artifact.toString()).not.toContain('SQLite format 3');

    await backups.restorePortable(target, restored, 'correct horse battery staple');
    expect(await readFile(restored)).toEqual(await readFile(databasePath));
  });

  it('rejects a wrong password without replacing an existing database', async () => {
    const { directory, databasePath } = await fixture();
    const target = join(directory, 'portable.dsrbackup');
    const restored = join(directory, 'existing.db');
    const backups = new BackupService({ argonMemoryKiB: 64, argonIterations: 1 });
    await writeFile(restored, 'keep me');
    await backups.exportPortable(databasePath, target, 'right password');

    await expect(backups.restorePortable(target, restored, 'wrong password')).rejects.toThrow(
      'Unable to decrypt backup'
    );
    expect(await readFile(restored, 'utf8')).toBe('keep me');
  });

  it('rejects weak backup passwords', async () => {
    const { directory, databasePath } = await fixture();
    const backups = new BackupService({ argonMemoryKiB: 64, argonIterations: 1 });

    await expect(backups.exportPortable(databasePath, join(directory, 'bad.dsrbackup'), 'short')).rejects.toThrow(
      'at least 12 characters'
    );
  });

  it('rejects hostile unauthenticated Argon2 parameters before deriving a key', async () => {
    const { directory, databasePath } = await fixture();
    const target = join(directory, 'portable.dsrbackup');
    const hostile = join(directory, 'hostile.dsrbackup');
    const backups = new BackupService({ argonMemoryKiB: 64, argonIterations: 1 });
    await backups.exportPortable(databasePath, target, 'correct horse battery staple');
    const artifact = await readFile(target);
    const headerLength = artifact.readUInt32BE(5);
    const headerEnd = 9 + headerLength;
    const header = JSON.parse(artifact.subarray(9, headerEnd).toString('utf8')) as { argon: { m: number } };
    header.argon.m = Number.MAX_SAFE_INTEGER;
    const headerBytes = Buffer.from(JSON.stringify(header));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.byteLength);
    await writeFile(hostile, Buffer.concat([artifact.subarray(0, 5), length, headerBytes, artifact.subarray(headerEnd)]));

    await expect(backups.restorePortable(hostile, join(directory, 'restored.db'), 'correct horse battery staple'))
      .rejects.toThrow('Unable to decrypt backup');
  });

  it('carries the source database key inside the encrypted envelope for cross-device rekeying', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsr-cross-device-backup-'));
    cleanupPaths.push(directory);
    const sourcePath = join(directory, 'source.db');
    const artifactPath = join(directory, 'portable.dsrbackup');
    const restoredPath = join(directory, 'restored.db');
    const sourceKey = Buffer.alloc(32, 4);
    const destinationKey = Buffer.alloc(32, 6);
    const source = openEncryptedDatabase(sourcePath, sourceKey);
    source.prepare('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run('proof', '"restored"', new Date().toISOString());
    source.close();
    const backups = new BackupService({ argonMemoryKiB: 64, argonIterations: 1 });

    await backups.exportPortable(sourcePath, artifactPath, 'portable password', sourceKey);
    const material = await backups.restorePortable(artifactPath, restoredPath, 'portable password');
    rekeyEncryptedDatabase(restoredPath, material.databaseKey!, destinationKey);

    const restored = openEncryptedDatabase(restoredPath, destinationKey);
    expect(restored.prepare('SELECT value FROM settings WHERE key = ?').get('proof')).toEqual({ value: '"restored"' });
    restored.close();
  });
});

describe('automatic backup rotation', () => {
  it('keeps the newest seven daily backups and four older weekly representatives', () => {
    const names = Array.from({ length: 42 }, (_, offset) => {
      const date = new Date(Date.UTC(2026, 7, 31 - offset));
      return `dsr-${date.toISOString().slice(0, 10)}.db`;
    });

    const keep = selectBackupsToKeep(names, 7, 4);

    expect(keep).toHaveLength(11);
    expect(keep).toEqual(expect.arrayContaining(names.slice(0, 7)));
    expect(new Set(keep).size).toBe(11);
  });

  it('creates at most one encrypted database snapshot per day', async () => {
    const { directory, databasePath } = await fixture();
    const backupDirectory = join(directory, 'automatic');
    const backups = new BackupService({ argonMemoryKiB: 64, argonIterations: 1 });
    const snapshot = async (target: string) => writeFile(target, await readFile(databasePath));

    await backups.createAutomatic(backupDirectory, new Date('2026-08-31T08:00:00Z'), snapshot);
    await backups.createAutomatic(backupDirectory, new Date('2026-08-31T18:00:00Z'), snapshot);

    expect(await readdir(backupDirectory)).toEqual(['dsr-2026-08-31.db']);
  });
});

describe('database replacement', () => {
  it('restores the live database when moving the replacement into place fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsr-replace-test-'));
    cleanupPaths.push(directory);
    const livePath = join(directory, 'live.db');
    const missingReplacement = join(directory, 'missing.db');
    const safetyPath = join(directory, 'live.pre-restore.db');
    await writeFile(livePath, 'original database');

    await expect(replaceDatabaseFile(livePath, missingReplacement, safetyPath)).rejects.toThrow();

    expect(await readFile(livePath, 'utf8')).toBe('original database');
    await expect(readFile(safetyPath)).rejects.toThrow();
  });
});
