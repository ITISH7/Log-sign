import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { afterEach, describe, expect, it } from 'vitest';
import { ExportService } from '../../src/main/export/export-service';
import type { ExportFormat, ReportDraft, TemplateBlueprint } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const draft: ReportDraft = {
  schemaVersion: 1,
  metadata: {
    title: 'Daily Status Report',
    dateFrom: '2026-08-31',
    dateTo: '2026-08-31',
    generatedAt: '2026-08-31T18:00:00.000Z'
  },
  sections: [
    { id: 'done', title: 'Completed', kind: 'bullets', items: ['Finished export pipeline', 'Fixed login redirect'] },
    { id: 'blockers', title: 'Blockers', kind: 'paragraph', text: 'No blockers' },
    {
      id: 'table',
      title: 'Work log',
      kind: 'table',
      columns: ['Task', 'Status'],
      rows: [{ Task: 'Export pipeline', Status: 'Done' }]
    }
  ],
  warnings: []
};

const blueprint: TemplateBlueprint = {
  schemaVersion: 1,
  templateVersionId: 'template-v1',
  sections: [
    { id: 'done', title: 'Completed', kind: 'bullets', sourceFields: ['note'], required: true }
  ],
  fieldMappings: [],
  narrativeRules: [],
  outputLayouts: {
    xlsx: { sheetName: 'DSR', columns: ['Section', 'Task', 'Status'] },
    pdf: { orientation: 'portrait' }
  }
};

async function service() {
  const directory = await mkdtemp(join(tmpdir(), 'dsr-export-test-'));
  cleanupPaths.push(directory);
  return {
    directory,
    exports: new ExportService(async (html) =>
      Buffer.from(`%PDF-1.7\n${html.includes('Finished export pipeline') ? 'content-ok' : 'content-missing'}\n%%EOF`)
    )
  };
}

describe('ExportService', () => {
  it.each([
    ['markdown', '# Daily Status Report\n', '## Completed'],
    ['txt', 'DAILY STATUS REPORT\n', 'Completed'],
    ['csv', 'Section,Task,Status', 'Work log,Export pipeline,Done']
  ] as const)('writes valid %s text output', async (format, prefix, content) => {
    const { directory, exports } = await service();
    const target = join(directory, `report.${format}`);

    await exports.export(format, { draft, blueprint, targetPath: target });
    const value = await readFile(target, 'utf8');

    expect(value.startsWith(prefix)).toBe(true);
    expect(value).toContain(content);
  });

  it('writes machine-readable JSON without changing the draft', async () => {
    const { directory, exports } = await service();
    const target = join(directory, 'report.json');

    await exports.export('json', { draft, blueprint, targetPath: target });

    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(draft);
  });

  it('escapes Markdown table cells and neutralizes spreadsheet formulas in CSV', async () => {
    const { directory, exports } = await service();
    const unsafe = structuredClone(draft);
    unsafe.sections[2]!.rows = [{ Task: 'A | B\nnext', Status: '=HYPERLINK("bad")' }];
    const markdownPath = join(directory, 'safe.md');
    const csvPath = join(directory, 'safe.csv');

    await exports.export('markdown', { draft: unsafe, blueprint, targetPath: markdownPath });
    await exports.export('csv', { draft: unsafe, blueprint, targetPath: csvPath });

    expect(await readFile(markdownPath, 'utf8')).toContain('A \\| B<br>next');
    expect(await readFile(csvPath, 'utf8')).toContain("'=HYPERLINK");
  });

  it('writes a readable XLSX workbook with mapped headings', async () => {
    const { directory, exports } = await service();
    const target = join(directory, 'report.xlsx');
    await exports.export('xlsx', { draft, blueprint, targetPath: target });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(target);

    expect(workbook.worksheets[0]?.name).toBe('DSR');
    expect(workbook.worksheets[0]?.getCell('A1').value).toBe('Daily Status Report');
    expect(workbook.worksheets[0]?.getCell('A4').value).toBe('Completed');
  });

  it('writes a readable DOCX with headings and report content', async () => {
    const { directory, exports } = await service();
    const target = join(directory, 'report.docx');
    await exports.export('docx', { draft, blueprint, targetPath: target });

    const extracted = await mammoth.extractRawText({ path: target });

    expect(extracted.value).toContain('Daily Status Report');
    expect(extracted.value).toContain('Finished export pipeline');
    expect(extracted.value).toContain('No blockers');
  });

  it('passes the approved HTML preview to the PDF renderer', async () => {
    const { directory, exports } = await service();
    const target = join(directory, 'report.pdf');

    await exports.export('pdf', { draft, blueprint, targetPath: target });
    const value = await readFile(target, 'utf8');

    expect(value.startsWith('%PDF-1.7')).toBe(true);
    expect(value).toContain('content-ok');
  });

  it('keeps the existing destination intact when rendering fails', async () => {
    const { directory } = await service();
    const target = join(directory, 'report.pdf');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(target, 'previous report');
    const exports = new ExportService(async () => {
      throw new Error('PDF renderer failed');
    });

    await expect(exports.export('pdf' as ExportFormat, { draft, blueprint, targetPath: target })).rejects.toThrow(
      'PDF renderer failed'
    );
    expect(await readFile(target, 'utf8')).toBe('previous report');
  });
});
