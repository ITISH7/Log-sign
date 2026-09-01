import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupService, selectBackupsToKeep } from '../../src/main/backup/backup-service';

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
