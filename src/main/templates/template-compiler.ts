import { templateBlueprintSchema, type ReportSectionRule, type TemplateBlueprint } from '../../shared/contracts';
import type { TextProviderTransport } from '../providers/structured-text-provider';
import type { ParsedTemplateSample } from './sample-parser';

export interface TemplateCompileInput {
  versionId: string;
  instructions: string;
  sample?: ParsedTemplateSample;
  transport?: TextProviderTransport;
  signal?: AbortSignal;
}

export class TemplateCompiler {
  async compile(input: TemplateCompileInput): Promise<TemplateBlueprint> {
    if (!input.transport) return buildLocalBlueprint(input);
    const response = await input.transport.complete(
      buildCompilePrompt(input.versionId, input.instructions, input.sample),
      input.signal ?? new AbortController().signal
    );
    try {
      const parsed = JSON.parse(stripFence(response.text)) as Record<string, unknown>;
      return templateBlueprintSchema.parse({ ...parsed, templateVersionId: input.versionId });
    } catch (error) {
      throw new Error('The AI could not compile this format into a valid template blueprint', { cause: error });
    }
  }
}

function buildCompilePrompt(
  versionId: string,
  instructions: string,
  sample?: ParsedTemplateSample
): string {
  return [
    'DSR_TEMPLATE_BLUEPRINT_SCHEMA_VERSION=1',
    'Compile the format into JSON only. Do not use Markdown fences.',
    'Preserve section order, headings, table columns, sheet names, and basic layout.',
    'Use narrativeRules only when rewriting, summarization, grouping, or prose generation is required.',
    `templateVersionId=${JSON.stringify(versionId)}`,
    `instructions=${JSON.stringify(instructions.trim())}`,
    `parsedStructure=${JSON.stringify(sample ? compactStructure(sample) : { kind: 'written' })}`
  ].join('\n');
}

function compactStructure(sample: ParsedTemplateSample): Record<string, unknown> {
  return {
    kind: sample.kind,
    structure: {
      ...(sample.structure.headings ? { headings: sample.structure.headings } : {}),
      ...(sample.structure.columns ? { columns: sample.structure.columns } : {}),
      ...(sample.structure.sheets ? {
        sheets: sample.structure.sheets.map((sheet) => ({
          name: sheet.name,
          columns: sheet.columns,
          widths: sheet.widths,
          rowCount: sheet.rowCount
        }))
      } : {})
    }
  };
}

function buildLocalBlueprint(input: TemplateCompileInput): TemplateBlueprint {
  const sample = input.sample;
  let sections: ReportSectionRule[];
  if (sample?.structure.sheets?.length) {
    const sheet = sample.structure.sheets[0]!;
    sections = [{ id: 'work-log', title: sheet.name, kind: 'table', sourceFields: normalizeColumns(sheet.columns), required: true }];
  } else if (sample?.structure.columns?.length) {
    sections = [{ id: 'work-log', title: 'Work log', kind: 'table', sourceFields: normalizeColumns(sample.structure.columns), required: true }];
  } else {
    const headings = (sample?.structure.headings ?? []).filter(Boolean);
    const sectionHeadings = headings.length > 1 ? headings.slice(1) : headings;
    sections = (sectionHeadings.length ? sectionHeadings : ['Updates']).map((title, index) => ({
      id: slug(title) || `section-${index + 1}`,
      title,
      kind: inferSectionKind(title),
      sourceFields: inferSourceFields(title),
      required: true
    }));
  }
  const needsNarrative = /summari[sz]|rewrite|narrative|group|executive|concise/i.test(input.instructions);
  const firstSheet = sample?.structure.sheets?.[0];
  return templateBlueprintSchema.parse({
    schemaVersion: 1,
    templateVersionId: input.versionId,
    sections,
    fieldMappings: [],
    narrativeRules: needsNarrative
      ? sections.map((section) => ({ sectionId: section.id, instruction: input.instructions.trim() }))
      : [],
    outputLayouts: {
      ...(firstSheet
        ? { xlsx: { sheetName: firstSheet.name, columns: firstSheet.columns } }
        : {})
    }
  });
}

function normalizeColumns(columns: string[]): string[] {
  return columns.map((column) => {
    const normalized = column.trim().toLowerCase();
    if (/date/.test(normalized)) return 'workDate';
    if (/task|update|work|description|note/.test(normalized)) return 'note';
    if (/project/.test(normalized)) return 'project';
    if (/status/.test(normalized)) return 'status';
    if (/duration|hours|time/.test(normalized)) return 'duration';
    if (/tag/.test(normalized)) return 'tags';
    return column.trim() || 'note';
  });
}

function inferSectionKind(title: string): ReportSectionRule['kind'] {
  return /summary|overview|narrative/i.test(title) ? 'paragraph' : 'bullets';
}

function inferSourceFields(title: string): string[] {
  if (/blocker|impediment|risk/i.test(title)) return ['blockers'];
  if (/link|reference|ticket|pull request|\bpr\b/i.test(title)) return ['links'];
  if (/duration|hours|time spent/i.test(title)) return ['duration'];
  if (/project/i.test(title)) return ['project'];
  if (/status/i.test(title)) return ['status'];
  return ['note'];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function stripFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}
