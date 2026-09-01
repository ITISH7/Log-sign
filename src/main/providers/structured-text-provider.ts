import {
  reportDraftSchema,
  type GenerationRequest,
  type ProviderAdapter,
  type ProviderHealth,
  type ReportDraft,
  type TokenEstimate
} from '../../shared/contracts';

export interface TextCompletion {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TextProviderTransport {
  healthCheck(): Promise<ProviderHealth>;
  complete(prompt: string, signal: AbortSignal): Promise<TextCompletion>;
}

export class StructuredTextProvider implements ProviderAdapter {
  constructor(private readonly transport: TextProviderTransport) {}

  healthCheck(): Promise<ProviderHealth> {
    return this.transport.healthCheck();
  }

  async estimateTokens(request: GenerationRequest): Promise<TokenEstimate> {
    const inputTokens = Math.ceil(buildGenerationPrompt(request).length / 4);
    return {
      inputTokens,
      contextLimit: request.contextLimit,
      requiresChunking: inputTokens >= Math.floor(request.contextLimit * 0.75)
    };
  }

  async generateStructured(
    request: GenerationRequest,
    signal: AbortSignal
  ): Promise<ReportDraft> {
    throwIfAborted(signal);
    const first = await this.transport.complete(buildGenerationPrompt(request), signal);
    const parsed = parseDraft(first.text);
    if (parsed) return parsed;

    throwIfAborted(signal);
    const repaired = await this.transport.complete(buildRepairPrompt(first.text, request), signal);
    const repairedDraft = parseDraft(repaired.text);
    if (repairedDraft) return repairedDraft;
    throw new Error('Provider returned invalid structured report data after one repair attempt');
  }
}

export function buildGenerationPrompt(request: GenerationRequest): string {
  return [
    'DSR_REPORT_SCHEMA_VERSION=1',
    'Create a report draft as JSON only. Do not use Markdown fences.',
    'The output must contain schemaVersion, metadata, sections, and warnings.',
    `Date range: ${request.dateFrom} through ${request.dateTo}`,
    `Template blueprint: ${JSON.stringify(request.blueprint)}`,
    `Selected normalized entries: ${JSON.stringify(request.entries)}`
  ].join('\n');
}

function buildRepairPrompt(invalid: string, request: GenerationRequest): string {
  return [
    'Repair the invalid response below into valid DSR_REPORT_SCHEMA_VERSION=1 JSON.',
    'Return JSON only and preserve factual content. Do not add facts.',
    `Required date range: ${request.dateFrom} through ${request.dateTo}`,
    `Invalid response: ${invalid}`
  ].join('\n');
}

function parseDraft(text: string): ReportDraft | undefined {
  try {
    const candidate = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = reportDraftSchema.safeParse(JSON.parse(candidate));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Generation cancelled', 'AbortError');
}
