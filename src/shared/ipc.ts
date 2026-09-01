import type { CustomField, Entry, ExportFormat, ProviderKind, ReportDraft, TemplateBlueprint } from './contracts';

export interface EntryCreateInput {
  workDate: string;
  note: string;
  standardValues: Record<string, unknown>;
  customValues: Record<string, unknown>;
  tags: string[];
}

export interface TemplateSummary {
  id: string;
  name: string;
  isDefault: boolean;
  activeVersionId: string;
  versionNumber: number;
  blueprint: TemplateBlueprint;
  versions: Array<{
    id: string;
    versionNumber: number;
    instructions: string;
    sourceName?: string;
    createdAt: string;
  }>;
}

export interface TemplateImportInput {
  templateId?: string;
  name: string;
  instructions: string;
  sourceName?: string;
  sourceBase64?: string;
  providerProfileId?: string;
  makeDefault?: boolean;
}

export interface ProviderProfileView {
  id: string;
  name: string;
  kind: string;
  model: string;
  contextLimit: number;
  enabled: boolean;
  isDefault: boolean;
}

export interface ProviderProfileSaveInput {
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

export interface ReportGenerationInput {
  dateFrom: string;
  dateTo: string;
  templateId: string;
  templateVersionId?: string;
  providerProfileId?: string;
  model?: string;
  format: ExportFormat;
}

export interface GenerationView {
  id: string;
  draft: ReportDraft;
  estimatedTokens: number;
  cacheHit: boolean;
  chunked: boolean;
}

export interface DsrApi {
  security: {
    status(): Promise<{ locked: boolean; requiresPassphrase: boolean }>;
    unlock(passphrase: string): Promise<{ unlocked: boolean }>;
  };
  entries: {
    list(filter?: Record<string, unknown>): Promise<Entry[]>;
    create(input: EntryCreateInput): Promise<Entry | { id: string }>;
    update(id: string, patch: Partial<EntryCreateInput>): Promise<Entry | undefined>;
    delete(id: string): Promise<boolean>;
    listCustomFields(activeOnly?: boolean): Promise<CustomField[]>;
    createCustomField(input: { label: string; type: CustomField['type']; options: string[] }): Promise<CustomField>;
    updateCustomField(id: string, patch: Partial<Pick<CustomField, 'label' | 'type' | 'options' | 'active'>>): Promise<CustomField | undefined>;
  };
  templates: {
    list(): Promise<TemplateSummary[]>;
    import(input: TemplateImportInput): Promise<TemplateSummary>;
    setDefault(id: string): Promise<void>;
    activateVersion(templateId: string, versionId: string): Promise<void>;
  };
  providers: {
    list(): Promise<ProviderProfileView[]>;
    save(input: ProviderProfileSaveInput): Promise<ProviderProfileView>;
    test(id: string): Promise<{ ok: boolean; message: string }>;
    login(id: string): Promise<{ ok: boolean; message: string }>;
    delete(id: string): Promise<boolean>;
  };
  reports: {
    estimate(input: ReportGenerationInput): Promise<{ inputTokens: number; requiresChunking: boolean; contextLimit: number }>;
    generate(input: ReportGenerationInput): Promise<GenerationView>;
    export(id: string, format: ExportFormat): Promise<{ path: string; bytes: number }>;
    updateDraft(id: string, draft: ReportDraft): Promise<void>;
  };
  settings: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  backup: {
    create(input?: { password?: string }): Promise<{ path: string }>;
    restore(input?: { password?: string }): Promise<void>;
  };
}

declare global {
  interface Window {
    dsr: DsrApi;
  }
}
