import { createHash, randomUUID } from 'node:crypto';
import {
  reportDraftSchema,
  type Entry,
  type ExportFormat,
  type GenerationRequest,
  type ProviderAdapter,
  type ReportDraft,
  type TemplateBlueprint,
  type TokenEstimate
} from '../../shared/contracts';
import type { DsrDatabase } from '../storage/database';

const PROMPT_VERSION = 1;

export interface GenerationOptions {
  providerProfileId?: string;
  exportFormat: ExportFormat;
  signal?: AbortSignal;
}

export interface GenerationResult {
  id: string;
  draft: ReportDraft;
  estimatedTokens: number;
  cacheHit: boolean;
  chunked: boolean;
}

export interface StoredGeneration {
  id: string;
  templateVersionId: string;
  exportFormat: ExportFormat;
  draft: ReportDraft;
}

type ProviderResolver = (profileId: string | undefined) => ProviderAdapter;

export class ReportEngine {
  constructor(
    private readonly database: DsrDatabase,
    private readonly resolveProvider: ProviderResolver
  ) {}

  async estimate(request: GenerationRequest, providerProfileId?: string): Promise<TokenEstimate> {
    if (request.blueprint.narrativeRules.length === 0) {
      return {
        inputTokens: 0,
        contextLimit: request.contextLimit,
        requiresChunking: false
      };
    }
    return this.resolveProvider(providerProfileId).estimateTokens(request);
  }

  async generate(
    request: GenerationRequest,
    options: GenerationOptions
  ): Promise<GenerationResult> {
    const cacheKey = hashValue({
      kind: 'report',
      promptVersion: PROMPT_VERSION,
      providerProfileId: options.providerProfileId,
      request
    });
    const cached = this.readCache(cacheKey);
    if (cached) {
      return this.recordJob(request, options, cacheKey, cached, {
        inputTokens: 0,
        cacheHit: true,
        chunked: false
      });
    }

    let draft: ReportDraft;
    let inputTokens = 0;
    let chunked = false;
    if (request.blueprint.narrativeRules.length === 0) {
      draft = buildDeterministicDraft(request);
    } else {
      const provider = this.resolveProvider(options.providerProfileId);
      const estimate = await provider.estimateTokens(request);
      inputTokens = estimate.inputTokens;
      chunked = estimate.requiresChunking;
      draft = chunked
        ? await this.generateChunked(provider, request, options.providerProfileId, options.signal)
        : await provider.generateStructured(request, options.signal ?? new AbortController().signal);
    }
    draft = reportDraftSchema.parse(draft);
    this.writeCache(cacheKey, 'report', draft);
    return this.recordJob(request, options, cacheKey, draft, {
      inputTokens,
      cacheHit: false,
      chunked
    });
  }

  getDraft(id: string): ReportDraft {
    return this.getGeneration(id).draft;
  }

  getGeneration(id: string): StoredGeneration {
    const row = this.database
      .prepare('SELECT id, template_version_id, export_format, draft FROM generation_jobs WHERE id = ?')
      .get(id) as
      | { id: string; template_version_id: string; export_format: ExportFormat; draft: string | null }
      | undefined;
    if (!row?.draft) throw new Error('Report draft not found');
    return {
      id: row.id,
      templateVersionId: row.template_version_id,
      exportFormat: row.export_format,
      draft: reportDraftSchema.parse(JSON.parse(row.draft))
    };
  }

  updateDraft(id: string, draft: ReportDraft): void {
    const validated = reportDraftSchema.parse(draft);
    const result = this.database
      .prepare('UPDATE generation_jobs SET draft = ?, warnings = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(validated), JSON.stringify(validated.warnings), new Date().toISOString(), id);
    if (result.changes === 0) throw new Error('Report draft not found');
  }

  private async generateChunked(
    provider: ProviderAdapter,
    request: GenerationRequest,
    providerProfileId: string | undefined,
    signal = new AbortController().signal
  ): Promise<ReportDraft> {
    const byDate = new Map<string, Entry[]>();
    for (const entry of request.entries) {
      const day = byDate.get(entry.workDate) ?? [];
      day.push(entry);
      byDate.set(entry.workDate, day);
    }

    const summaries: Array<{ date: string; draft: ReportDraft }> = [];
    for (const [date, entries] of [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const dailyRequest: GenerationRequest = {
        ...request,
        entries,
        dateFrom: date,
        dateTo: date,
        contextLimit: Math.max(request.contextLimit, 32_768)
      };
      const dailyKey = hashValue({
        kind: 'day-summary',
        promptVersion: PROMPT_VERSION,
        providerProfileId,
        request: dailyRequest
      });
      let dailyDraft = this.readCache(dailyKey);
      if (!dailyDraft) {
        dailyDraft = reportDraftSchema.parse(await provider.generateStructured(dailyRequest, signal));
        this.writeCache(dailyKey, 'day-summary', dailyDraft);
      }
      summaries.push({ date, draft: dailyDraft });
    }

    const summaryEntries = summaries.map(({ date, draft }) => ({
      id: `summary-${date}`,
      workDate: date,
      note: draft.sections
        .flatMap((section) => section.items ?? (section.text ? [section.text] : []))
        .join('\n'),
      standardValues: { source: 'cached-daily-summary' },
      customValues: {},
      tags: [],
      createdAt: `${date}T00:00:00.000Z`,
      updatedAt: `${date}T00:00:00.000Z`
    }));

    return provider.generateStructured({ ...request, entries: summaryEntries }, signal);
  }

  private readCache(key: string): ReportDraft | undefined {
    const row = this.database
      .prepare('SELECT payload FROM generation_cache WHERE cache_key = ?')
      .get(key) as { payload: string } | undefined;
    if (!row) return undefined;
    const parsed = reportDraftSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? parsed.data : undefined;
  }

  private writeCache(key: string, kind: string, draft: ReportDraft): void {
    this.database
      .prepare(`
        INSERT INTO generation_cache(cache_key, kind, payload, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at
      `)
      .run(key, kind, JSON.stringify(draft), new Date().toISOString());
  }

  private recordJob(
    request: GenerationRequest,
    options: GenerationOptions,
    cacheKey: string,
    draft: ReportDraft,
    metrics: { inputTokens: number; cacheHit: boolean; chunked: boolean }
  ): GenerationResult {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO generation_jobs(
          id, date_from, date_to, template_version_id, provider_profile_id, model,
          export_format, cache_key, status, draft, warnings, input_tokens,
          cache_hit, chunked, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        request.dateFrom,
        request.dateTo,
        request.blueprint.templateVersionId,
        options.providerProfileId ?? null,
        request.model,
        options.exportFormat,
        cacheKey,
        JSON.stringify(draft),
        JSON.stringify(draft.warnings),
        metrics.inputTokens,
        metrics.cacheHit ? 1 : 0,
        metrics.chunked ? 1 : 0,
        timestamp,
        timestamp
      );
    return {
      id,
      draft,
      estimatedTokens: metrics.inputTokens,
      cacheHit: metrics.cacheHit,
      chunked: metrics.chunked
    };
  }
}

function buildDeterministicDraft(request: GenerationRequest): ReportDraft {
  return reportDraftSchema.parse({
    schemaVersion: 1,
    metadata: {
      title: 'Daily Status Report',
      dateFrom: request.dateFrom,
      dateTo: request.dateTo,
      generatedAt: new Date().toISOString()
    },
    sections: request.blueprint.sections.map((section) => {
      if (section.kind === 'table') {
        const columns = section.sourceFields.length > 0 ? section.sourceFields : ['note'];
        return {
          id: section.id,
          title: section.title,
          kind: 'table' as const,
          columns,
          rows: request.entries.map((entry) =>
            Object.fromEntries(columns.map((column) => [column, readEntryField(entry, column)]))
          )
        };
      }
      const items = request.entries.map((entry) => entry.note);
      return section.kind === 'paragraph'
        ? { id: section.id, title: section.title, kind: 'paragraph' as const, text: items.join('\n') }
        : { id: section.id, title: section.title, kind: 'bullets' as const, items };
    }),
    warnings: []
  });
}

function readEntryField(entry: Entry, field: string): string {
  if (field === 'note') return entry.note;
  if (field === 'workDate') return entry.workDate;
  if (field === 'tags') return entry.tags.join(', ');
  return String(entry.standardValues[field] ?? entry.customValues[field] ?? '');
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
