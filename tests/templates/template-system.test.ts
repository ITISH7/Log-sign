import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { TemplateRepository } from '../../src/main/repositories/template-repository';
import { openEncryptedDatabase } from '../../src/main/storage/database';
import { parseTemplateSample } from '../../src/main/templates/sample-parser';
import { TemplateCompiler } from '../../src/main/templates/template-compiler';
import type { TextProviderTransport } from '../../src/main/providers/structured-text-provider';
import type { TemplateBlueprint } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'dsr-template-test-'));
  cleanupPaths.push(directory);
  const database = openEncryptedDatabase(join(directory, 'templates.db'), Buffer.alloc(32, 9));
  return { database, templates: new TemplateRepository(database) };
}

function blueprint(versionId: string, title = 'Completed'): TemplateBlueprint {
  return {
    schemaVersion: 1,
    templateVersionId: versionId,
    sections: [{ id: 'completed', title, kind: 'bullets', sourceFields: ['note'], required: true }],
    fieldMappings: [],
    narrativeRules: [],
    outputLayouts: {}
  };
}

describe('parseTemplateSample', () => {
  it('extracts headings and instructions from Markdown without AI', async () => {
    const parsed = await parseTemplateSample({
      name: 'manager-dsr.md',
      data: Buffer.from('# Daily Report\n\n## Completed\n- Example item\n\n## Blockers')
    });

    expect(parsed.kind).toBe('markdown');
    expect(parsed.structure.headings).toEqual(['Daily Report', 'Completed', 'Blockers']);
    expect(parsed.text).toContain('Example item');
  });

  it('extracts workbook sheets, columns, and widths without sending the file', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Daily Status');
    sheet.columns = [
      { header: 'Task', key: 'task', width: 30 },
      { header: 'Status', key: 'status', width: 14 }
    ];
    sheet.addRow({ task: 'Example', status: 'Done' });
    const data = Buffer.from(await workbook.xlsx.writeBuffer());

    const parsed = await parseTemplateSample({ name: 'status.xlsx', data });

    expect(parsed.kind).toBe('xlsx');
    expect(parsed.structure.sheets).toEqual([
      expect.objectContaining({ name: 'Daily Status', columns: ['Task', 'Status'], widths: [30, 14] })
    ]);
  });
});

describe('TemplateRepository', () => {
  it('keeps immutable versions and lets the user activate an older version', async () => {
    const { database, templates } = await repository();
    const created = templates.create({
      name: 'Manager DSR',
      instructions: 'Use concise bullet points',
      sourceType: 'markdown',
      sourceName: 'manager.md',
      sourceBlob: Buffer.from('# DSR'),
      makeDefault: true,
      buildBlueprint: (versionId) => blueprint(versionId)
    });
    const version2 = templates.addVersion(created.id, {
      instructions: 'Include blockers after completed work',
      buildBlueprint: (versionId) => blueprint(versionId, 'Work completed')
    });

    templates.activateVersion(created.id, created.activeVersionId);
    const result = templates.get(created.id);

    expect(result?.versions.map((version) => version.versionNumber)).toEqual([2, 1]);
    expect(result?.activeVersionId).toBe(created.activeVersionId);
    expect(version2.blueprint.sections[0]?.title).toBe('Work completed');
    expect(result?.versions[1]?.sourceBlob?.toString()).toBe('# DSR');
    database.close();
  });

  it('enforces only one default template', async () => {
    const { database, templates } = await repository();
    const first = templates.create({
      name: 'Daily',
      instructions: '',
      makeDefault: true,
      buildBlueprint: (versionId) => blueprint(versionId)
    });
    const second = templates.create({
      name: 'Weekly',
      instructions: '',
      makeDefault: false,
      buildBlueprint: (versionId) => blueprint(versionId)
    });

    templates.setDefault(second.id);

    expect(templates.get(first.id)?.isDefault).toBe(false);
    expect(templates.get(second.id)?.isDefault).toBe(true);
    database.close();
  });
});

describe('TemplateCompiler', () => {
  it('builds a deterministic blueprint from headings when AI is unnecessary', async () => {
    const sample = await parseTemplateSample({
      name: 'simple.md',
      data: Buffer.from('# Daily Report\n## Completed\n## Blockers')
    });

    const result = await new TemplateCompiler().compile({
      versionId: 'version-1',
      instructions: '',
      sample
    });

    expect(result.sections.map((section) => section.title)).toEqual(['Completed', 'Blockers']);
    expect(result.narrativeRules).toEqual([]);
  });

  it('sends only compact parsed structure to the selected AI once', async () => {
    const prompts: string[] = [];
    const transport: TextProviderTransport = {
      healthCheck: async () => ({ ok: true, message: 'ready' }),
      complete: async (prompt) => {
        prompts.push(prompt);
        return {
          text: JSON.stringify({
            schemaVersion: 1,
            templateVersionId: 'provider-invented-id',
            sections: [{ id: 'summary', title: 'Executive summary', kind: 'paragraph', sourceFields: ['note'], required: true }],
            fieldMappings: [],
            narrativeRules: [{ sectionId: 'summary', instruction: 'Summarize for leadership' }],
            outputLayouts: {}
          })
        };
      }
    };
    const sample = {
      kind: 'txt' as const,
      text: 'SENSITIVE EXAMPLE CONTENT THAT MUST NOT BE REPEATED',
      structure: {}
    };

    const result = await new TemplateCompiler().compile({
      versionId: 'version-2',
      instructions: 'Create a concise executive summary',
      sample,
      transport
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(sample.text);
    expect(result.templateVersionId).toBe('version-2');
    expect(result.narrativeRules).toHaveLength(1);
  });
});
