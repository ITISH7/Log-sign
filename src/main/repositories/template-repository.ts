import { randomUUID } from 'node:crypto';
import { templateBlueprintSchema, type TemplateBlueprint } from '../../shared/contracts';
import type { DsrDatabase } from '../storage/database';

export interface TemplateVersionRecord {
  id: string;
  versionNumber: number;
  instructions: string;
  sourceType?: string;
  sourceName?: string;
  sourceBlob?: Buffer;
  blueprint: TemplateBlueprint;
  createdAt: string;
}

export interface TemplateRecord {
  id: string;
  name: string;
  isDefault: boolean;
  activeVersionId: string;
  createdAt: string;
  updatedAt: string;
  versions: TemplateVersionRecord[];
}

interface VersionInput {
  instructions: string;
  sourceType?: string;
  sourceName?: string;
  sourceBlob?: Buffer;
  buildBlueprint(versionId: string): TemplateBlueprint;
}

interface TemplateRow {
  id: string;
  name: string;
  is_default: number;
  active_version_id: string;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  version_number: number;
  instructions: string;
  source_type: string | null;
  source_name: string | null;
  source_blob: Buffer | null;
  blueprint: string;
  created_at: string;
}

export class TemplateRepository {
  constructor(private readonly database: DsrDatabase) {}

  create(input: VersionInput & { name: string; makeDefault: boolean }): TemplateRecord {
    const templateId = randomUUID();
    const versionId = randomUUID();
    const timestamp = new Date().toISOString();
    const blueprint = templateBlueprintSchema.parse(input.buildBlueprint(versionId));
    this.database.transaction(() => {
      if (input.makeDefault) this.database.prepare('UPDATE templates SET is_default = 0').run();
      this.database
        .prepare(`
          INSERT INTO templates(id, name, is_default, active_version_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(templateId, input.name.trim(), input.makeDefault ? 1 : 0, versionId, timestamp, timestamp);
      this.insertVersion(templateId, versionId, 1, input, blueprint, timestamp);
    })();
    return this.get(templateId)!;
  }

  addVersion(templateId: string, input: VersionInput): TemplateVersionRecord {
    const template = this.get(templateId);
    if (!template) throw new Error('Template not found');
    const versionId = randomUUID();
    const versionNumber = Math.max(...template.versions.map((version) => version.versionNumber)) + 1;
    const timestamp = new Date().toISOString();
    const blueprint = templateBlueprintSchema.parse(input.buildBlueprint(versionId));
    this.database.transaction(() => {
      this.insertVersion(templateId, versionId, versionNumber, input, blueprint, timestamp);
      this.database
        .prepare('UPDATE templates SET active_version_id = ?, updated_at = ? WHERE id = ?')
        .run(versionId, timestamp, templateId);
    })();
    return this.get(templateId)!.versions.find((version) => version.id === versionId)!;
  }

  get(id: string): TemplateRecord | undefined {
    const row = this.database.prepare('SELECT * FROM templates WHERE id = ?').get(id) as
      | TemplateRow
      | undefined;
    if (!row) return undefined;
    const versions = this.database
      .prepare('SELECT * FROM template_versions WHERE template_id = ? ORDER BY version_number DESC')
      .all(id) as VersionRow[];
    return {
      id: row.id,
      name: row.name,
      isDefault: row.is_default === 1,
      activeVersionId: row.active_version_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      versions: versions.map(mapVersion)
    };
  }

  list(): TemplateRecord[] {
    const rows = this.database
      .prepare('SELECT id FROM templates ORDER BY is_default DESC, updated_at DESC')
      .all() as Array<{ id: string }>;
    return rows.map((row) => this.get(row.id)!);
  }

  setDefault(id: string): void {
    if (!this.get(id)) throw new Error('Template not found');
    this.database.transaction(() => {
      this.database.prepare('UPDATE templates SET is_default = 0').run();
      this.database
        .prepare('UPDATE templates SET is_default = 1, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
    })();
  }

  activateVersion(templateId: string, versionId: string): void {
    const owned = this.database
      .prepare('SELECT 1 FROM template_versions WHERE id = ? AND template_id = ?')
      .get(versionId, templateId);
    if (!owned) throw new Error('Template version not found');
    this.database
      .prepare('UPDATE templates SET active_version_id = ?, updated_at = ? WHERE id = ?')
      .run(versionId, new Date().toISOString(), templateId);
  }

  private insertVersion(
    templateId: string,
    versionId: string,
    versionNumber: number,
    input: VersionInput,
    blueprint: TemplateBlueprint,
    timestamp: string
  ): void {
    this.database
      .prepare(`
        INSERT INTO template_versions(
          id, template_id, version_number, instructions, source_type, source_name,
          source_blob, blueprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        versionId,
        templateId,
        versionNumber,
        input.instructions,
        input.sourceType ?? null,
        input.sourceName ?? null,
        input.sourceBlob ?? null,
        JSON.stringify(blueprint),
        timestamp
      );
  }
}

function mapVersion(row: VersionRow): TemplateVersionRecord {
  return {
    id: row.id,
    versionNumber: row.version_number,
    instructions: row.instructions,
    sourceType: row.source_type ?? undefined,
    sourceName: row.source_name ?? undefined,
    sourceBlob: row.source_blob ?? undefined,
    blueprint: templateBlueprintSchema.parse(JSON.parse(row.blueprint)),
    createdAt: row.created_at
  };
}
