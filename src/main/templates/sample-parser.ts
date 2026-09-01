import { extname } from 'node:path';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';

export interface ParsedTemplateSample {
  kind: 'docx' | 'xlsx' | 'markdown' | 'txt' | 'csv';
  text: string;
  structure: {
    headings?: string[];
    sheets?: Array<{ name: string; columns: string[]; widths: number[]; rowCount: number }>;
    columns?: string[];
  };
}

export async function parseTemplateSample(input: {
  name: string;
  data: Buffer;
}): Promise<ParsedTemplateSample> {
  const extension = extname(input.name).toLowerCase();
  if (extension === '.xlsx') return parseWorkbook(input.data);
  if (extension === '.docx') return parseDocx(input.data);

  const text = input.data.toString('utf8').replace(/^\uFEFF/, '');
  if (extension === '.md' || extension === '.markdown') {
    return {
      kind: 'markdown',
      text,
      structure: {
        headings: text
          .split(/\r?\n/)
          .map((line) => line.match(/^#{1,6}\s+(.+?)\s*$/)?.[1])
          .filter((heading): heading is string => Boolean(heading))
      }
    };
  }
  if (extension === '.csv') {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
    return {
      kind: 'csv',
      text,
      structure: { columns: parseCsvLine(firstLine) }
    };
  }
  if (extension === '.txt') return { kind: 'txt', text, structure: {} };
  throw new Error('Supported template samples are DOCX, XLSX, Markdown, TXT, and CSV');
}

async function parseWorkbook(data: Buffer): Promise<ParsedTemplateSample> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as never);
  const sheets = workbook.worksheets.map((sheet) => {
    const header = sheet.getRow(1);
    const columns = Array.from({ length: Math.max(sheet.columnCount, header.cellCount) }, (_, index) =>
      String(header.getCell(index + 1).value ?? '').trim()
    );
    const widths = columns.map((_, index) => sheet.getColumn(index + 1).width ?? 10);
    return { name: sheet.name, columns, widths, rowCount: sheet.rowCount };
  });
  return {
    kind: 'xlsx',
    text: sheets.map((sheet) => `${sheet.name}: ${sheet.columns.join(', ')}`).join('\n'),
    structure: { sheets }
  };
}

async function parseDocx(data: Buffer): Promise<ParsedTemplateSample> {
  const [{ value: text }, { value: html }] = await Promise.all([
    mammoth.extractRawText({ buffer: data }),
    mammoth.convertToHtml({ buffer: data })
  ]);
  const headings = Array.from(html.matchAll(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi)).map((match) =>
    match[1]!.replace(/<[^>]+>/g, '').trim()
  );
  return { kind: 'docx', text, structure: { headings } };
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"' && line[index + 1] === '"' && quoted) {
      current += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) {
      values.push(current.trim());
      current = '';
    } else current += character;
  }
  values.push(current.trim());
  return values;
}
