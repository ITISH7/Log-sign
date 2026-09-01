import Database from 'better-sqlite3-multiple-ciphers';
import { migrations } from './migrations';

export type DsrDatabase = InstanceType<typeof Database>;

export function openEncryptedDatabase(path: string, key: Buffer): DsrDatabase {
  if (key.byteLength !== 32) {
    throw new Error('The database encryption key must be exactly 32 bytes');
  }

  const database = new Database(path);
  try {
    database.pragma("cipher='sqlcipher'");
    database.pragma('legacy=4');
    database.pragma(`key="x'${key.toString('hex')}'"`);
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');
    database.prepare('SELECT count(*) AS count FROM sqlite_master').get();

    applyMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function rekeyEncryptedDatabase(path: string, currentKey: Buffer, nextKey: Buffer): void {
  if (currentKey.byteLength !== 32 || nextKey.byteLength !== 32) {
    throw new Error('Database encryption keys must be exactly 32 bytes');
  }
  const database = new Database(path);
  try {
    database.pragma("cipher='sqlcipher'");
    database.pragma('legacy=4');
    database.pragma(`key="x'${currentKey.toString('hex')}'"`);
    database.prepare('SELECT count(*) AS count FROM sqlite_master').get();
    database.pragma(`rekey="x'${nextKey.toString('hex')}'"`);
  } finally {
    database.close();
  }
}

function applyMigrations(database: DsrDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    (database.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (row) => row.version
    )
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
    })();
  }
}
