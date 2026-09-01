import { randomUUID } from 'node:crypto';
import {
  customFieldSchema,
  entrySchema,
  type CustomField,
  type Entry
} from '../../shared/contracts';
import type { DsrDatabase } from '../storage/database';

export interface EntryInput {
  workDate: string;
  note: string;
  standardValues: Record<string, unknown>;
  customValues: Record<string, unknown>;
  tags: string[];
}

export interface EntryListFilter {
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  tag?: string;
}

interface EntryRow {
  id: string;
  work_date: string;
  note: string;
  standard_values: string;
  custom_values: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

interface CustomFieldRow {
  id: string;
  label: string;
  type: CustomField['type'];
  options: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export class EntryRepository {
  constructor(private readonly database: DsrDatabase) {}

  create(input: EntryInput): Entry {
    const timestamp = new Date().toISOString();
    const entry = entrySchema.parse({
      id: randomUUID(),
      ...input,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    this.database
      .prepare(`
        INSERT INTO entries(
          id, work_date, note, standard_values, custom_values, tags, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.id,
        entry.workDate,
        entry.note,
        JSON.stringify(entry.standardValues),
        JSON.stringify(entry.customValues),
        JSON.stringify(entry.tags),
        entry.createdAt,
        entry.updatedAt
      );
    return entry;
  }

  get(id: string): Entry | undefined {
    const row = this.database.prepare('SELECT * FROM entries WHERE id = ?').get(id) as
      | EntryRow
      | undefined;
    return row ? mapEntry(row) : undefined;
  }

  list(filter: EntryListFilter = {}): Entry[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (filter.dateFrom) {
      clauses.push('work_date >= ?');
      parameters.push(filter.dateFrom);
    }
    if (filter.dateTo) {
      clauses.push('work_date <= ?');
      parameters.push(filter.dateTo);
    }
    if (filter.search?.trim()) {
      clauses.push('(note LIKE ? OR standard_values LIKE ? OR custom_values LIKE ?)');
      const query = `%${filter.search.trim()}%`;
      parameters.push(query, query, query);
    }
    if (filter.tag?.trim()) {
      clauses.push('tags LIKE ?');
      parameters.push(`%"${filter.tag.trim()}"%`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return (
      this.database
        .prepare(`SELECT * FROM entries ${where} ORDER BY work_date DESC, created_at DESC`)
        .all(...parameters) as EntryRow[]
    ).map(mapEntry);
  }

  update(id: string, patch: Partial<EntryInput>): Entry | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = entrySchema.parse({ ...current, ...patch, id, updatedAt: new Date().toISOString() });
    this.database
      .prepare(`
        UPDATE entries SET
          work_date = ?, note = ?, standard_values = ?, custom_values = ?, tags = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.workDate,
        next.note,
        JSON.stringify(next.standardValues),
        JSON.stringify(next.customValues),
        JSON.stringify(next.tags),
        next.updatedAt,
        id
      );
    return next;
  }

  delete(id: string): boolean {
    return this.database.prepare('DELETE FROM entries WHERE id = ?').run(id).changes > 0;
  }

  createCustomField(input: {
    label: string;
    type: CustomField['type'];
    options: string[];
  }): CustomField {
    const timestamp = new Date().toISOString();
    const field = customFieldSchema.parse({
      id: randomUUID(),
      ...input,
      active: true,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.database
      .prepare(`
        INSERT INTO custom_fields(id, label, type, options, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `)
      .run(
        field.id,
        field.label,
        field.type,
        JSON.stringify(field.options),
        field.createdAt,
        field.updatedAt
      );
    return field;
  }

  disableCustomField(id: string): boolean {
    return (
      this.database
        .prepare('UPDATE custom_fields SET active = 0, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id).changes > 0
    );
  }

  updateCustomField(
    id: string,
    patch: Partial<Pick<CustomField, 'label' | 'type' | 'options' | 'active'>>
  ): CustomField | undefined {
    const current = this.listCustomFields().find((field) => field.id === id);
    if (!current) return undefined;
    const next = customFieldSchema.parse({ ...current, ...patch, id, updatedAt: new Date().toISOString() });
    this.database
      .prepare(`
        UPDATE custom_fields SET label = ?, type = ?, options = ?, active = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(next.label, next.type, JSON.stringify(next.options), next.active ? 1 : 0, next.updatedAt, id);
    return next;
  }

  listCustomFields(filter: { activeOnly?: boolean } = {}): CustomField[] {
    const sql = filter.activeOnly
      ? 'SELECT * FROM custom_fields WHERE active = 1 ORDER BY created_at'
      : 'SELECT * FROM custom_fields ORDER BY created_at';
    return (this.database.prepare(sql).all() as CustomFieldRow[]).map((row) =>
      customFieldSchema.parse({
        id: row.id,
        label: row.label,
        type: row.type,
        options: JSON.parse(row.options),
        active: row.active === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })
    );
  }
}

function mapEntry(row: EntryRow): Entry {
  return entrySchema.parse({
    id: row.id,
    workDate: row.work_date,
    note: row.note,
    standardValues: JSON.parse(row.standard_values),
    customValues: JSON.parse(row.custom_values),
    tags: JSON.parse(row.tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
