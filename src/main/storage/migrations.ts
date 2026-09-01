export const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        work_date TEXT NOT NULL,
        note TEXT NOT NULL,
        standard_values TEXT NOT NULL,
        custom_values TEXT NOT NULL,
        tags TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_work_date_idx ON entries(work_date);
      CREATE INDEX IF NOT EXISTS entries_updated_at_idx ON entries(updated_at);

      CREATE TABLE IF NOT EXISTS custom_fields (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        type TEXT NOT NULL,
        options TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        active_version_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS template_versions (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        instructions TEXT NOT NULL,
        source_type TEXT,
        source_name TEXT,
        source_blob BLOB,
        blueprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(template_id, version_number)
      );

      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        model TEXT NOT NULL,
        context_limit INTEGER NOT NULL DEFAULT 32768,
        credential_ref TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        settings TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS generation_jobs (
        id TEXT PRIMARY KEY,
        date_from TEXT NOT NULL,
        date_to TEXT NOT NULL,
        template_version_id TEXT NOT NULL,
        provider_profile_id TEXT,
        model TEXT,
        export_format TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        status TEXT NOT NULL,
        draft TEXT,
        warnings TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_hit INTEGER NOT NULL DEFAULT 0,
        chunked INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS generation_cache (
        cache_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  }
] as const;
