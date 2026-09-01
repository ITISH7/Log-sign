import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRepository, type ProviderCredentialVault } from '../../src/main/repositories/provider-repository';
import { openEncryptedDatabase, type DsrDatabase } from '../../src/main/storage/database';

const cleanupPaths: string[] = [];
let database: DsrDatabase | undefined;

afterEach(async () => {
  database?.close();
  database = undefined;
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsr-provider-repo-'));
  cleanupPaths.push(directory);
  database = openEncryptedDatabase(join(directory, 'test.db'), Buffer.alloc(32, 8));
  const secrets = new Map<string, string>();
  const vault: ProviderCredentialVault = {
    set: (id, value) => void secrets.set(id, value),
    get: (id) => secrets.get(id),
    delete: (id) => secrets.delete(id)
  };
  return { providers: new ProviderRepository(database, vault), secrets };
}

describe('ProviderRepository', () => {
  it('stores credentials outside profile records and permits later replacement', async () => {
    const { providers, secrets } = await fixture();
    const profile = providers.save({
      name: 'Work OpenAI',
      kind: 'openai-api',
      model: 'gpt-5-mini',
      contextLimit: 128_000,
      credential: 'sk-initial',
      enabled: true,
      makeDefault: true,
      settings: { timeoutMs: 60_000 }
    });

    expect(profile).not.toHaveProperty('credential');
    expect(secrets.get(profile.id)).toBe('sk-initial');

    providers.save({ id: profile.id, name: 'Renamed', credential: 'sk-replaced' });
    expect(providers.get(profile.id)?.name).toBe('Renamed');
    expect(secrets.get(profile.id)).toBe('sk-replaced');
  });

  it('allows only one default and keeps subscription profiles credential-free', async () => {
    const { providers, secrets } = await fixture();
    const first = providers.save({
      name: 'OpenAI', kind: 'openai-api', model: 'gpt-5-mini', credential: 'sk-key', makeDefault: true
    });
    const second = providers.save({
      name: 'Local Codex', kind: 'codex-subscription', model: 'gpt-5', makeDefault: true
    });

    expect(providers.get(first.id)?.isDefault).toBe(false);
    expect(providers.get(second.id)?.isDefault).toBe(true);
    expect(secrets.has(second.id)).toBe(false);
  });

  it('deletes the profile and its credential', async () => {
    const { providers, secrets } = await fixture();
    const profile = providers.save({
      name: 'Anthropic', kind: 'anthropic-api', model: 'claude-sonnet', credential: 'anthropic-key'
    });

    expect(providers.delete(profile.id)).toBe(true);
    expect(providers.get(profile.id)).toBeUndefined();
    expect(secrets.has(profile.id)).toBe(false);
  });
});
