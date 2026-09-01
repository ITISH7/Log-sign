import { describe, expect, it } from 'vitest';
import {
  entrySchema,
  reportDraftSchema,
  templateBlueprintSchema
} from '../../src/shared/contracts';

describe('entrySchema', () => {
  it('rejects a work entry without a note', () => {
    const parsed = entrySchema.safeParse({
      id: '018f2d12-8af5-7ca1-9c9a-8d886534c100',
      workDate: '2026-08-31',
      note: '   ',
      standardValues: {},
      customValues: {},
      tags: [],
      createdAt: '2026-08-31T09:00:00.000Z',
      updatedAt: '2026-08-31T09:00:00.000Z'
    });

    expect(parsed.success).toBe(false);
  });

  it('preserves custom values independently of field definitions', () => {
    const parsed = entrySchema.parse({
      id: '018f2d12-8af5-7ca1-9c9a-8d886534c100',
      workDate: '2026-08-31',
      note: 'Finished exporter tests',
      standardValues: { project: 'DSR Creator', status: 'done' },
      customValues: { clientTicket: 'OPS-42' },
      tags: ['release'],
      createdAt: '2026-08-31T09:00:00.000Z',
      updatedAt: '2026-08-31T09:00:00.000Z'
    });

    expect(parsed.customValues).toEqual({ clientTicket: 'OPS-42' });
  });
});

describe('templateBlueprintSchema', () => {
  it('rejects a blueprint that has neither sections nor mappings', () => {
    const parsed = templateBlueprintSchema.safeParse({
      schemaVersion: 1,
      templateVersionId: 'version-1',
      sections: [],
      fieldMappings: [],
      narrativeRules: [],
      outputLayouts: {}
    });

    expect(parsed.success).toBe(false);
  });
});

describe('reportDraftSchema', () => {
  it('accepts an editable provider-neutral report draft', () => {
    const parsed = reportDraftSchema.parse({
      schemaVersion: 1,
      metadata: {
        title: 'Daily Status Report',
        dateFrom: '2026-08-31',
        dateTo: '2026-08-31',
        generatedAt: '2026-08-31T18:00:00.000Z'
      },
      sections: [
        {
          id: 'completed',
          title: 'Completed',
          kind: 'bullets',
          items: ['Finished exporter tests']
        }
      ],
      warnings: []
    });

    expect(parsed.sections[0]?.title).toBe('Completed');
  });
});
