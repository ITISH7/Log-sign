import type { DsrDatabase } from '../storage/database';

export class SettingsRepository {
  constructor(private readonly database: DsrDatabase) {}

  get<T>(key: string): T | undefined {
    const row = this.database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(key: string, value: unknown): void {
    this.database
      .prepare(`
        INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
}
