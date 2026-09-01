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
      try {
        assertDraftMatchesRequest(cached, request);
        return this.recordJob(request, options, cacheKey, cached, {
          inputTokens: 0,
          cacheHit: true,
          chunked: false
        });
      } catch {
        this.database.prepare('DELETE FROM generation_cache WHERE cache_key = ?').run(cacheKey);
      }
    }

    let draft: ReportDraft;
    let inputTokens = 0;
    let chunked = false;
    let providerInputTokens: number | undefined;
    let outputTokens: number | undefined;
    if (request.blueprint.narrativeRules.length === 0) {
      draft = buildDeterministicDraft(request);
    } else {
      const provider = this.resolveProvider(options.providerProfileId);
      provider.resetUsage?.();
      const estimate = await provider.estimateTokens(request);
      inputTokens = estimate.inputTokens;
      chunked = estimate.requiresChunking;
      draft = chunked
        ? await this.generateChunked(provider, request, options.providerProfileId, options.signal)
        : await provider.generateStructured(request, options.signal ?? new AbortController().signal);
      const usage = provider.getUsage?.();
      providerInputTokens = usage?.inputTokens;
      outputTokens = usage?.outputTokens;
    }
    draft = reportDraftSchema.parse(draft);
    assertDraftMatchesRequest(draft, request);
    this.writeCache(cacheKey, 'report', draft);
    return this.recordJob(request, options, cacheKey, draft, {
      inputTokens,
      providerInputTokens,
      outputTokens,
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

    const summaries: Entry[] = [];
    for (const [date, entries] of [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const chunks = await this.splitEntriesToFit(provider, { ...request, dateFrom: date, dateTo: date }, entries);
      for (let index = 0; index < chunks.length; index += 1) {
        const dailyRequest: GenerationRequest = { ...request, entries: chunks[index]!, dateFrom: date, dateTo: date };
        const draft = await this.generateCachedSummary(provider, dailyRequest, providerProfileId, signal, `day-${index}`);
        summaries.push(summaryEntry(date, draft, `summary-${date}-${index}`));
      }
    }

    let current = summaries;
    for (let level = 0; level < 8; level += 1) {
      const finalRequest = { ...request, entries: current };
      const estimate = await provider.estimateTokens(finalRequest);
      if (!estimate.requiresChunking) return provider.generateStructured(finalRequest, signal);
      const groups = await this.splitEntriesToFit(provider, finalRequest, current);
      if (groups.length === 1 && groups[0]!.length === current.length) {
        throw new Error('The selected model context limit is too small to reduce this report safely');
      }
      const reduced: Entry[] = [];
      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index]!;
        const from = group[0]!.workDate;
        const to = group[group.length - 1]!.workDate;
        const draft = await this.generateCachedSummary(
          provider,
          { ...request, entries: group, dateFrom: from, dateTo: to },
          providerProfileId,
          signal,
          `reduce-${level}-${index}`
        );
        reduced.push(summaryEntry(from, draft, `summary-reduce-${level}-${index}`));
      }
      current = reduced;
    }
    throw new Error('The report could not be reduced within the selected model context limit');
  }

  private async splitEntriesToFit(
    provider: ProviderAdapter,
    request: GenerationRequest,
    entries: Entry[]
  ): Promise<Entry[][]> {
    const candidate = { ...request, entries };
    if (!(await provider.estimateTokens(candidate)).requiresChunking) return [entries];
    if (entries.length > 1) {
      const middle = Math.ceil(entries.length / 2);
      return [
        ...await this.splitEntriesToFit(provider, request, entries.slice(0, middle)),
        ...await this.splitEntriesToFit(provider, request, entries.slice(middle))
      ];
    }
    const entry = entries[0];
    const payload = entry ? providerPayload(entry) : '';
    if (!entry || payload.length < 2) {
      throw new Error('A single entry exceeds the selected model context limit');
    }
    const middle = Math.ceil(payload.length / 2);
    const parts = [payload.slice(0, middle), payload.slice(middle)].map((note, index) => ({
      ...entry,
      id: `${entry.id}-part-${index + 1}`,
      note,
      standardValues: { source: 'chunked-entry-fragment', originalEntryId: entry.id },
      customValues: {},
      tags: []
    }));
    return [
      ...await this.splitEntriesToFit(provider, request, [parts[0]!]),
      ...await this.splitEntriesToFit(provider, request, [parts[1]!])
    ];
  }

  private async generateCachedSummary(
    provider: ProviderAdapter,
    request: GenerationRequest,
    providerProfileId: string | undefined,
    signal: AbortSignal,
    stage: string
  ): Promise<ReportDraft> {
    const key = hashValue({ kind: 'summary', stage, promptVersion: PROMPT_VERSION, providerProfileId, request });
    const cached = this.readCache(key);
    if (cached) return cached;
    const draft = reportDraftSchema.parse(await provider.generateStructured(request, signal));
    this.writeCache(key, 'summary', draft);
    return draft;
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
    metrics: { inputTokens: number; providerInputTokens?: number; outputTokens?: number; cacheHit: boolean; chunked: boolean }
  ): GenerationResult {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO generation_jobs(
          id, date_from, date_to, template_version_id, provider_profile_id, model,
          export_format, cache_key, status, draft, warnings, input_tokens,
          provider_input_tokens, output_tokens, cache_hit, chunked, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        metrics.providerInputTokens ?? null,
        metrics.outputTokens ?? null,
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
            Object.fromEntries(columns.map((column) => [column, readMappedField(entry, column, request.blueprint)]))
          )
        };
      }
      const sourceFields = section.sourceFields.length > 0 ? section.sourceFields : ['note'];
      const items = request.entries.flatMap((entry) =>
        sourceFields.map((field) => readMappedField(entry, field, request.blueprint)).filter((value) => value.trim().length > 0)
      );
      if (section.kind === 'metadata') {
        return { id: section.id, title: section.title, kind: 'metadata' as const, items };
      }
      return section.kind === 'paragraph'
        ? { id: section.id, title: section.title, kind: 'paragraph' as const, text: items.join('\n') }
        : { id: section.id, title: section.title, kind: 'bullets' as const, items };
    }),
    warnings: []
  });
}

function readMappedField(entry: Entry, target: string, blueprint: TemplateBlueprint): string {
  const mapping = blueprint.fieldMappings.find((candidate) => candidate.target === target);
  const source = mapping?.source ?? target;
  const raw = readEntryValue(entry, source);
  switch (mapping?.transform ?? 'identity') {
    case 'join':
      return Array.isArray(raw) ? raw.map(String).join(', ') : String(raw ?? '');
    case 'sum': {
      const values = Array.isArray(raw) ? raw : [raw];
      return String(values.reduce<number>((total, value) => total + (Number(value) || 0), 0));
    }
    case 'duration':
      return formatDurationHours(raw);
    case 'date': {
      const date = raw instanceof Date ? raw : new Date(String(raw ?? ''));
      return Number.isNaN(date.getTime()) ? String(raw ?? '') : date.toISOString().slice(0, 10);
    }
    case 'identity':
      return Array.isArray(raw) ? raw.map(String).join(', ') : String(raw ?? '');
  }
}

function readEntryValue(entry: Entry, field: string): unknown {
  if (field === 'note') return entry.note;
  if (field === 'workDate') return entry.workDate;
  if (field === 'tags') return entry.tags;
  return entry.standardValues[field] ?? entry.customValues[field];
}

function formatDurationHours(value: unknown): string {
  if (typeof value === 'number') return String(value);
  const text = String(value ?? '').trim();
  if (!text) return '';
  const hours = Number(text.match(/(\d+(?:\.\d+)?)\s*h/i)?.[1] ?? 0);
  const minutes = Number(text.match(/(\d+(?:\.\d+)?)\s*m/i)?.[1] ?? 0);
  if (hours || minutes) return String(Number((hours + minutes / 60).toFixed(2)));
  const numeric = Number(text);
  return Number.isFinite(numeric) ? String(numeric) : text;
}

function summaryEntry(date: string, draft: ReportDraft, id: string): Entry {
  const note = draft.sections
    .flatMap((section) => [
      ...(section.items ?? []),
      ...(section.text ? [section.text] : []),
      ...(section.rows ? [JSON.stringify(section.rows)] : [])
    ])
    .join('\n');
  return {
    id,
    workDate: date,
    note,
    standardValues: { source: 'cached-summary' },
    customValues: {},
    tags: [],
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T00:00:00.000Z`
  };
}

function assertDraftMatchesRequest(draft: ReportDraft, request: GenerationRequest): void {
  if (draft.metadata.dateFrom !== request.dateFrom || draft.metadata.dateTo !== request.dateTo) {
    throw new Error('Generated report dates do not match the selected date range');
  }
  const matches = draft.sections.length === request.blueprint.sections.length &&
    draft.sections.every((section, index) => {
      const rule = request.blueprint.sections[index];
      if (!rule || section.id !== rule.id || section.title !== rule.title || section.kind !== rule.kind) return false;
      if (rule.kind === 'table') {
        return Boolean(section.columns && section.rows) &&
          (rule.sourceFields.length === 0 || JSON.stringify(section.columns) === JSON.stringify(rule.sourceFields));
      }
      if (rule.kind === 'paragraph') return section.text !== undefined;
      return section.items !== undefined;
    });
  if (!matches) throw new Error('Generated report structure does not match the selected template version');
}

function providerPayload(entry: Entry): string {
  if (entry.standardValues.source === 'chunked-entry-fragment') return entry.note;
  return JSON.stringify({
    note: entry.note,
    standardValues: entry.standardValues,
    customValues: entry.customValues,
    tags: entry.tags
  });
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
