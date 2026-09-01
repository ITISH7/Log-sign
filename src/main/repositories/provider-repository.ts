import { randomUUID } from 'node:crypto';
import { providerKindSchema, type ProviderKind } from '../../shared/contracts';
import type { DsrDatabase } from '../storage/database';

export interface ProviderCredentialVault {
  set(profileId: string, credential: string): void;
  get(profileId: string): string | undefined;
  delete(profileId: string): boolean;
}

/** Used only when the OS vault is unavailable and the user unlocked the SQLCipher database with a passphrase. */
export class DatabaseCredentialVault implements ProviderCredentialVault {
  constructor(private readonly database: DsrDatabase) {}

  set(profileId: string, credential: string): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(`provider-secret:${profileId}`, JSON.stringify(credential), now);
  }

  get(profileId: string): string | undefined {
    const row = this.database
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(`provider-secret:${profileId}`) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as string) : undefined;
  }

  delete(profileId: string): boolean {
    return this.database.prepare('DELETE FROM settings WHERE key = ?').run(`provider-secret:${profileId}`).changes > 0;
  }
}

export interface ProviderProfileRecord {
  id: string;
  name: string;
  kind: ProviderKind;
  model: string;
  contextLimit: number;
  enabled: boolean;
  isDefault: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProfileInput {
  id?: string;
  name?: string;
  kind?: ProviderKind;
  model?: string;
  contextLimit?: number;
  credential?: string;
  enabled?: boolean;
  makeDefault?: boolean;
  settings?: Record<string, unknown>;
}

interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  model: string;
  context_limit: number;
  credential_ref: string | null;
  enabled: number;
  is_default: number;
  settings: string;
  created_at: string;
  updated_at: string;
}

export class ProviderRepository {
  constructor(
    private readonly database: DsrDatabase,
    private readonly credentials: ProviderCredentialVault
  ) {}

  save(input: ProviderProfileInput): ProviderProfileRecord {
    const existing = input.id ? this.get(input.id) : undefined;
    if (input.id && !existing) throw new Error('AI profile not found');

    const id = existing?.id ?? randomUUID();
    const kind = providerKindSchema.parse(input.kind ?? existing?.kind);
    const name = (input.name ?? existing?.name ?? '').trim();
    const model = (input.model ?? existing?.model ?? '').trim();
    if (!name) throw new Error('An AI profile name is required');
    if (!model) throw new Error('A model name is required');
    const contextLimit = input.contextLimit ?? existing?.contextLimit ?? 32_768;
    if (!Number.isInteger(contextLimit) || contextLimit < 1_024) {
      throw new Error('Context limit must be at least 1024 tokens');
    }
    const credential = input.credential?.trim();
    if (isApiProfile(kind) && !credential && !existing && !this.credentials.get(id)) {
      throw new Error('An API key is required for this profile');
    }

    const timestamp = new Date().toISOString();
    const makeDefault = input.makeDefault ?? existing?.isDefault ?? false;
    this.database.transaction(() => {
      if (makeDefault) this.database.prepare('UPDATE provider_profiles SET is_default = 0').run();
      this.database
        .prepare(`
          INSERT INTO provider_profiles(
            id, name, kind, model, context_limit, credential_ref, enabled,
            is_default, settings, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            kind = excluded.kind,
            model = excluded.model,
            context_limit = excluded.context_limit,
            credential_ref = excluded.credential_ref,
            enabled = excluded.enabled,
            is_default = excluded.is_default,
            settings = excluded.settings,
            updated_at = excluded.updated_at
        `)
        .run(
          id,
          name,
          kind,
          model,
          contextLimit,
          isApiProfile(kind) ? `provider:${id}` : null,
          (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
          makeDefault ? 1 : 0,
          JSON.stringify(input.settings ?? existing?.settings ?? {}),
          existing?.createdAt ?? timestamp,
          timestamp
        );
    })();

    if (credential) this.credentials.set(id, credential);
    if (!isApiProfile(kind)) this.credentials.delete(id);
    return this.get(id)!;
  }

  get(id: string): ProviderProfileRecord | undefined {
    const row = this.database.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(id) as
      | ProviderRow
      | undefined;
    return row ? mapProvider(row) : undefined;
  }

  list(): ProviderProfileRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM provider_profiles ORDER BY is_default DESC, updated_at DESC')
        .all() as ProviderRow[]
    ).map(mapProvider);
  }

  getCredential(id: string): string | undefined {
    const profile = this.get(id);
    return profile && isApiProfile(profile.kind) ? this.credentials.get(id) : undefined;
  }

  delete(id: string): boolean {
    const result = this.database.prepare('DELETE FROM provider_profiles WHERE id = ?').run(id);
    this.credentials.delete(id);
    return result.changes > 0;
  }
}

function isApiProfile(kind: ProviderKind): boolean {
  return kind === 'openai-api' || kind === 'anthropic-api';
}

function mapProvider(row: ProviderRow): ProviderProfileRecord {
  return {
    id: row.id,
    name: row.name,
    kind: providerKindSchema.parse(row.kind),
    model: row.model,
    contextLimit: row.context_limit,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    settings: JSON.parse(row.settings) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
