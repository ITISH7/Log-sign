import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openEncryptedDatabase } from '../../src/main/storage/database';
import { EntryRepository } from '../../src/main/repositories/entry-repository';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'dsr-entry-test-'));
  cleanupPaths.push(directory);
  const databasePath = join(directory, 'dsr.db');
  const database = openEncryptedDatabase(databasePath, Buffer.alloc(32, 7));
  return { database, databasePath, repository: new EntryRepository(database) };
}

describe('encrypted database', () => {
  it('does not expose a plaintext SQLite file header', async () => {
    const { database, databasePath } = await createRepository();
    database.close();

    const header = (await readFile(databasePath)).subarray(0, 16).toString('utf8');

    expect(header).not.toBe('SQLite format 3\u0000');
  });
});

describe('EntryRepository', () => {
  it('stores entries and filters them by date and search text', async () => {
    const { database, repository } = await createRepository();
    repository.create({
      workDate: '2026-08-30',
      note: 'Prepared deployment notes',
      standardValues: { project: 'Portal', status: 'done' },
      customValues: {},
      tags: ['release']
    });
    const target = repository.create({
      workDate: '2026-08-31',
      note: 'Fixed authentication redirect',
      standardValues: { project: 'Portal', status: 'done' },
      customValues: { ticket: 'AUTH-42' },
      tags: ['backend']
    });

    const results = repository.list({
      dateFrom: '2026-08-31',
      dateTo: '2026-08-31',
      search: 'authentication'
    });

    expect(results.map((entry) => entry.id)).toEqual([target.id]);
    expect(results[0]?.customValues).toEqual({ ticket: 'AUTH-42' });
    database.close();
  });

  it('updates an entry without changing its creation timestamp', async () => {
    const { database, repository } = await createRepository();
    const original = repository.create({
      workDate: '2026-08-31',
      note: 'Started report exporter',
      standardValues: {},
      customValues: {},
      tags: []
    });

    const updated = repository.update(original.id, {
      note: 'Finished report exporter',
      tags: ['done']
    });

    expect(updated?.createdAt).toBe(original.createdAt);
    expect(updated?.note).toBe('Finished report exporter');
    expect(updated?.tags).toEqual(['done']);
    database.close();
  });

  it('deleting a custom field does not remove historical entry values', async () => {
    const { database, repository } = await createRepository();
    const field = repository.createCustomField({ label: 'Ticket', type: 'text', options: [] });
    const entry = repository.create({
      workDate: '2026-08-31',
      note: 'Resolved issue',
      standardValues: {},
      customValues: { [field.id]: 'OPS-7' },
      tags: []
    });

    repository.disableCustomField(field.id);

    expect(repository.get(entry.id)?.customValues[field.id]).toBe('OPS-7');
    expect(repository.listCustomFields({ activeOnly: true })).toEqual([]);
    database.close();
  });

  it('renames a custom field without changing the stable key stored in historical entries', async () => {
    const { database, repository } = await createRepository();
    const field = repository.createCustomField({ label: 'Ticket', type: 'text', options: [] });
    const entry = repository.create({
      workDate: '2026-08-31', note: 'Resolved issue', standardValues: {},
      customValues: { [field.id]: 'OPS-8' }, tags: []
    });

    const renamed = repository.updateCustomField(field.id, { label: 'Issue key' });

    expect(renamed?.label).toBe('Issue key');
    expect(repository.get(entry.id)?.customValues[field.id]).toBe('OPS-8');
    database.close();
  });
});
