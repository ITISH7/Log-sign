import { z } from 'zod';

export const exportFormatSchema = z.enum([
  'xlsx',
  'docx',
  'pdf',
  'markdown',
  'csv',
  'json',
  'txt'
]);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDateTimeSchema = z.string().datetime();
const valueRecordSchema = z.record(z.string(), z.unknown());

export const entrySchema = z.object({
  id: z.string().min(1),
  workDate: isoDateSchema,
  note: z.string().trim().min(1, 'A work note is required'),
  standardValues: valueRecordSchema.default({}),
  customValues: valueRecordSchema.default({}),
  tags: z.array(z.string().trim().min(1)).default([]),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});
export type Entry = z.infer<typeof entrySchema>;

export const customFieldSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1),
  type: z.enum(['text', 'number', 'boolean', 'date', 'select']),
  options: z.array(z.string()).default([]),
  active: z.boolean().default(true),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});
export type CustomField = z.infer<typeof customFieldSchema>;

export const reportSectionRuleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(['paragraph', 'bullets', 'table', 'metadata']),
  sourceFields: z.array(z.string()).default([]),
  required: z.boolean().default(false)
});
export type ReportSectionRule = z.infer<typeof reportSectionRuleSchema>;

export const fieldMappingSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  transform: z.enum(['identity', 'join', 'sum', 'duration', 'date']).default('identity')
});
export type FieldMapping = z.infer<typeof fieldMappingSchema>;

export const narrativeRuleSchema = z.object({
  sectionId: z.string().min(1),
  instruction: z.string().trim().min(1)
});
export type NarrativeRule = z.infer<typeof narrativeRuleSchema>;

export const outputLayoutSchema = z.object({
  sheetName: z.string().optional(),
  columns: z.array(z.string()).optional(),
  headingLevel: z.number().int().min(1).max(6).optional(),
  orientation: z.enum(['portrait', 'landscape']).optional()
});
export type OutputLayout = z.infer<typeof outputLayoutSchema>;

export const templateBlueprintSchema = z
  .object({
    schemaVersion: z.literal(1),
    templateVersionId: z.string().min(1),
    sections: z.array(reportSectionRuleSchema),
    fieldMappings: z.array(fieldMappingSchema),
    narrativeRules: z.array(narrativeRuleSchema),
    outputLayouts: z.partialRecord(exportFormatSchema, outputLayoutSchema).default({})
  })
  .refine((value) => value.sections.length > 0 || value.fieldMappings.length > 0, {
    message: 'A template requires at least one section or field mapping'
  });
export type TemplateBlueprint = z.infer<typeof templateBlueprintSchema>;

export const draftSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(['paragraph', 'bullets', 'table', 'metadata']),
  text: z.string().optional(),
  items: z.array(z.string()).optional(),
  columns: z.array(z.string()).optional(),
  rows: z.array(z.record(z.string(), z.string())).optional()
});
export type DraftSection = z.infer<typeof draftSectionSchema>;

export const reportDraftSchema = z.object({
  schemaVersion: z.literal(1),
  metadata: z.object({
    title: z.string().min(1),
    dateFrom: isoDateSchema,
    dateTo: isoDateSchema,
    generatedAt: isoDateTimeSchema
  }),
  sections: z.array(draftSectionSchema),
  warnings: z.array(z.string()).default([])
});
export type ReportDraft = z.infer<typeof reportDraftSchema>;

export const providerKindSchema = z.enum([
  'openai-api',
  'anthropic-api',
  'codex-subscription',
  'claude-subscription'
]);
export type ProviderKind = z.infer<typeof providerKindSchema>;

export interface GenerationRequest {
  entries: Entry[];
  blueprint: TemplateBlueprint;
  dateFrom: string;
  dateTo: string;
  model: string;
  contextLimit: number;
}

export interface TokenEstimate {
  inputTokens: number;
  contextLimit: number;
  requiresChunking: boolean;
}

export interface ProviderHealth {
  ok: boolean;
  message: string;
  runtimeVersion?: string;
}

export interface ProviderAdapter {
  healthCheck(): Promise<ProviderHealth>;
  estimateTokens(request: GenerationRequest): Promise<TokenEstimate>;
  generateStructured(request: GenerationRequest, signal: AbortSignal): Promise<ReportDraft>;
  resetUsage?(): void;
  getUsage?(): { inputTokens: number; outputTokens: number };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface ExportRequest {
  draft: ReportDraft;
  blueprint: TemplateBlueprint;
  targetPath: string;
}

export interface ExportArtifact {
  path: string;
  bytes: number;
  format: ExportFormat;
}

export interface Exporter {
  format: ExportFormat;
  validate(blueprint: TemplateBlueprint): ValidationResult;
  render(request: ExportRequest): Promise<ExportArtifact>;
}
