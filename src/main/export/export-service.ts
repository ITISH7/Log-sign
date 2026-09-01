import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx';
import ExcelJS from 'exceljs';
import type {
  ExportArtifact,
  ExportFormat,
  ExportRequest,
  ReportDraft,
  TemplateBlueprint
} from '../../shared/contracts';

type PdfRenderer = (html: string, options: { landscape: boolean }) => Promise<Buffer>;

export class ExportService {
  constructor(private readonly renderPdf: PdfRenderer) {}

  async export(format: ExportFormat, request: ExportRequest): Promise<ExportArtifact> {
    const validation = validateRequest(request);
    if (validation.length > 0) throw new Error(validation.join('; '));
    await mkdir(dirname(request.targetPath), { recursive: true });
    const temporaryPath = `${request.targetPath}.tmp-${randomUUID()}`;
    try {
      const data = await this.render(format, request.draft, request.blueprint);
      if (data.byteLength === 0) throw new Error('Exporter produced an empty file');
      await writeFile(temporaryPath, data, { mode: 0o600 });
      await rename(temporaryPath, request.targetPath);
      return { path: request.targetPath, bytes: data.byteLength, format };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async render(
    format: ExportFormat,
    draft: ReportDraft,
    blueprint: TemplateBlueprint
  ): Promise<Buffer> {
    switch (format) {
      case 'markdown':
        return Buffer.from(toMarkdown(draft));
      case 'txt':
        return Buffer.from(toText(draft));
      case 'csv':
        return Buffer.from(toCsv(draft));
      case 'json':
        return Buffer.from(`${JSON.stringify(draft, null, 2)}\n`);
      case 'xlsx':
        return toXlsx(draft, blueprint);
      case 'docx':
        return toDocx(draft);
      case 'pdf':
        return this.renderPdf(toHtml(draft), {
          landscape: blueprint.outputLayouts.pdf?.orientation === 'landscape'
        });
    }
  }
}

function validateRequest(request: ExportRequest): string[] {
  const errors: string[] = [];
  if (!request.targetPath.trim()) errors.push('An export destination is required');
  if (request.draft.sections.length === 0) errors.push('The report draft has no sections');
  return errors;
}

function toMarkdown(draft: ReportDraft): string {
  const lines = [
    `# ${draft.metadata.title}`,
    '',
    `_${draft.metadata.dateFrom} to ${draft.metadata.dateTo}_`,
    ''
  ];
  for (const section of draft.sections) {
    lines.push(`## ${section.title}`, '');
    if (section.text) lines.push(section.text, '');
    if (section.items) lines.push(...section.items.map((item) => `- ${item}`), '');
    if (section.columns && section.rows) {
      lines.push(`| ${section.columns.map(markdownCell).join(' | ')} |`);
      lines.push(`| ${section.columns.map(() => '---').join(' | ')} |`);
      for (const row of section.rows) {
        lines.push(`| ${section.columns.map((column) => markdownCell(row[column] ?? '')).join(' | ')} |`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n').trim()}\n`;
}

function toText(draft: ReportDraft): string {
  const lines = [draft.metadata.title.toUpperCase(), `${draft.metadata.dateFrom} to ${draft.metadata.dateTo}`, ''];
  for (const section of draft.sections) {
    lines.push(section.title, '-'.repeat(section.title.length));
    if (section.text) lines.push(section.text);
    if (section.items) lines.push(...section.items.map((item) => `• ${item}`));
    if (section.columns && section.rows) {
      lines.push(section.columns.join(' | '));
      for (const row of section.rows) lines.push(section.columns.map((column) => row[column] ?? '').join(' | '));
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

function toCsv(draft: ReportDraft): string {
  const rows: Array<Record<string, string>> = [];
  for (const section of draft.sections) {
    for (const item of section.items ?? []) rows.push({ Section: section.title, Task: item, Status: '' });
    if (section.text) rows.push({ Section: section.title, Task: section.text, Status: '' });
    for (const row of section.rows ?? []) rows.push({ Section: section.title, ...row });
  }
  const columns = ['Section', 'Task', 'Status', ...new Set(rows.flatMap((row) => Object.keys(row)))]
    .filter((column, index, all) => all.indexOf(column) === index);
  return `${[
    columns.map(csvCell).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(row[column] ?? '')).join(','))
  ].join('\n')}\n`;
}

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function markdownCell(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
}

async function toXlsx(draft: ReportDraft, blueprint: TemplateBlueprint): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DSR Creator';
  const sheet = workbook.addWorksheet(blueprint.outputLayouts.xlsx?.sheetName ?? 'Daily Status Report');
  sheet.getCell('A1').value = draft.metadata.title;
  sheet.getCell('A1').font = { bold: true, size: 18, color: { argb: 'FF20382B' } };
  sheet.getCell('A2').value = `${draft.metadata.dateFrom} to ${draft.metadata.dateTo}`;
  sheet.getCell('A2').font = { italic: true, color: { argb: 'FF6B756F' } };
  let rowNumber = 4;
  for (const section of draft.sections) {
    const heading = sheet.getCell(rowNumber, 1);
    heading.value = section.title;
    heading.font = { bold: true, color: { argb: 'FF20382B' } };
    heading.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7EDDD' } };
    rowNumber += 1;
    for (const item of section.items ?? []) sheet.getCell(rowNumber++, 1).value = `• ${item}`;
    if (section.text) sheet.getCell(rowNumber++, 1).value = section.text;
    if (section.columns && section.rows) {
      section.columns.forEach((column, index) => {
        const cell = sheet.getCell(rowNumber, index + 1);
        cell.value = column;
        cell.font = { bold: true };
      });
      rowNumber += 1;
      for (const row of section.rows) {
        section.columns.forEach((column, index) => (sheet.getCell(rowNumber, index + 1).value = row[column] ?? ''));
        rowNumber += 1;
      }
    }
    rowNumber += 1;
  }
  const configuredWidths = blueprint.outputLayouts.xlsx?.columns ?? [];
  const maxColumns = Math.max(1, ...draft.sections.map((section) => section.columns?.length ?? 1));
  for (let index = 1; index <= maxColumns; index += 1) {
    sheet.getColumn(index).width = configuredWidths[index - 1] ? 24 : index === 1 ? 42 : 20;
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function toDocx(draft: ReportDraft): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({ text: draft.metadata.title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({
      children: [new TextRun({ text: `${draft.metadata.dateFrom} to ${draft.metadata.dateTo}`, italics: true })],
      alignment: AlignmentType.CENTER
    })
  ];
  for (const section of draft.sections) {
    children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_1 }));
    if (section.text) children.push(new Paragraph({ text: section.text }));
    for (const item of section.items ?? []) children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
    if (section.columns && section.rows) {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: section.columns.map(
                (column) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: column, bold: true })] })] })
              )
            }),
            ...section.rows.map(
              (row) =>
                new TableRow({
                  children: section.columns!.map(
                    (column) => new TableCell({ children: [new Paragraph(row[column] ?? '')] })
                  )
                })
            )
          ]
        })
      );
    }
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

function toHtml(draft: ReportDraft): string {
  const sections = draft.sections
    .map((section) => {
      const text = section.text ? `<p>${escapeHtml(section.text)}</p>` : '';
      const list = section.items
        ? `<ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : '';
      const table = section.columns && section.rows
        ? `<table><thead><tr>${section.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${section.rows.map((row) => `<tr>${section.columns!.map((column) => `<td>${escapeHtml(row[column] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`
        : '';
      return `<section><h2>${escapeHtml(section.title)}</h2>${text}${list}${table}</section>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px Arial,sans-serif;color:#1c241f;margin:42px}h1{font-size:26px}h2{margin-top:26px;color:#20382b;border-bottom:1px solid #ccd4ce;padding-bottom:6px}li{margin:6px 0}table{border-collapse:collapse;width:100%}th,td{border:1px solid #cfd4d0;padding:7px;text-align:left}th{background:#e7eddd}.date{color:#657069}</style></head><body><h1>${escapeHtml(draft.metadata.title)}</h1><p class="date">${draft.metadata.dateFrom} to ${draft.metadata.dateTo}</p>${sections}</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
