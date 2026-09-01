import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReportEngine } from '../../src/main/reports/report-engine';
import { openEncryptedDatabase } from '../../src/main/storage/database';
import type {
  GenerationRequest,
  ProviderAdapter,
  ProviderHealth,
  ReportDraft,
  TokenEstimate
} from '../../src/shared/contracts';

const cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function engine(provider: CountingProvider) {
  const directory = await mkdtemp(join(tmpdir(), 'dsr-report-test-'));
  cleanupPaths.push(directory);
  const database = openEncryptedDatabase(join(directory, 'reports.db'), Buffer.alloc(32, 11));
  return { database, reports: new ReportEngine(database, () => provider) };
}

function request(options: { narrative?: boolean; contextLimit?: number; changedNote?: string } = {}): GenerationRequest {
  return {
    entries: [
      {
        id: 'day-1',
        workDate: '2026-08-30',
        note: options.changedNote ?? 'Implemented encrypted persistence',
        standardValues: { project: 'DSR', status: 'done' },
        customValues: {},
        tags: [],
        createdAt: '2026-08-30T10:00:00.000Z',
        updatedAt: '2026-08-30T10:00:00.000Z'
      },
      {
        id: 'day-2',
        workDate: '2026-08-31',
        note: 'Implemented template versioning',
        standardValues: { project: 'DSR', status: 'done' },
        customValues: {},
        tags: [],
        createdAt: '2026-08-31T10:00:00.000Z',
        updatedAt: '2026-08-31T10:00:00.000Z'
      }
    ],
    blueprint: {
      schemaVersion: 1,
      templateVersionId: 'template-v1',
      sections: [{ id: 'done', title: 'Completed', kind: 'bullets', sourceFields: ['note'], required: true }],
      fieldMappings: [],
      narrativeRules: options.narrative
        ? [{ sectionId: 'done', instruction: 'Summarize concisely' }]
        : [],
      outputLayouts: {}
    },
    dateFrom: '2026-08-30',
    dateTo: '2026-08-31',
    model: 'test-model',
    contextLimit: options.contextLimit ?? 32_768
  };
}

class CountingProvider implements ProviderAdapter {
  calls: GenerationRequest[] = [];
  async healthCheck(): Promise<ProviderHealth> {
    return { ok: true, message: 'ready' };
  }
  async estimateTokens(input: GenerationRequest): Promise<TokenEstimate> {
    return {
      inputTokens: input.contextLimit <= 100 ? 90 : 100,
      contextLimit: input.contextLimit,
      requiresChunking: input.contextLimit <= 100
    };
  }
  async generateStructured(input: GenerationRequest): Promise<ReportDraft> {
    this.calls.push(input);
    return {
      schemaVersion: 1,
      metadata: {
        title: 'Daily Status Report',
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        generatedAt: '2026-08-31T18:00:00.000Z'
      },
      sections: [
        {
          id: 'done',
          title: 'Completed',
          kind: 'bullets',
          items: input.entries.map((entry) => entry.note)
        }
      ],
      warnings: []
    };
  }
}

describe('ReportEngine', () => {
  it('creates direct-mapping reports locally without calling AI', async () => {
    const provider = new CountingProvider();
    const { database, reports } = await engine(provider);

    const result = await reports.generate(request(), {
      providerProfileId: undefined,
      exportFormat: 'markdown'
    });

    expect(result.draft.sections[0]?.items).toEqual([
      'Implemented encrypted persistence',
      'Implemented template versioning'
    ]);
    expect(provider.calls).toHaveLength(0);
    database.close();
  });

  it('persists user preview edits independently from the generation cache', async () => {
    const provider = new CountingProvider();
    const { database, reports } = await engine(provider);
    const result = await reports.generate(request(), {
      providerProfileId: undefined,
      exportFormat: 'markdown'
    });
    const edited = structuredClone(result.draft);
    edited.sections[0]!.items = ['Edited and approved update'];

    reports.updateDraft(result.id, edited);

    expect(reports.getDraft(result.id).sections[0]?.items).toEqual(['Edited and approved update']);
    const regenerated = await reports.generate(request(), {
      providerProfileId: undefined,
      exportFormat: 'markdown'
    });
    expect(regenerated.draft.sections[0]?.items).toEqual([
      'Implemented encrypted persistence',
      'Implemented template versioning'
    ]);
    database.close();
  });

  it('returns the cached AI draft for an unchanged request', async () => {
    const provider = new CountingProvider();
    const { database, reports } = await engine(provider);
    const input = request({ narrative: true });

    const first = await reports.generate(input, { providerProfileId: 'provider-1', exportFormat: 'json' });
    const second = await reports.generate(input, { providerProfileId: 'provider-1', exportFormat: 'json' });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(provider.calls).toHaveLength(1);
    database.close();
  });

  it('reuses unchanged daily summaries when one day changes', async () => {
    const provider = new CountingProvider();
    const { database, reports } = await engine(provider);

    await reports.generate(request({ narrative: true, contextLimit: 100 }), {
      providerProfileId: 'provider-1',
      exportFormat: 'docx'
    });
    await reports.generate(
      request({ narrative: true, contextLimit: 100, changedNote: 'Implemented encrypted backup' }),
      { providerProfileId: 'provider-1', exportFormat: 'docx' }
    );

    expect(provider.calls).toHaveLength(5);
    expect(provider.calls.filter((call) => call.dateFrom === '2026-08-31')).toHaveLength(1);
    database.close();
  });
});
