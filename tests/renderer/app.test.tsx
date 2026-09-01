// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/src/App';
import type { DsrApi } from '../../src/shared/ipc';

const createEntry = vi.fn();
const listEntries = vi.fn();
const securityStatus = vi.fn();
const unlock = vi.fn();
const listTemplates = vi.fn();
const importTemplate = vi.fn();
const listProviders = vi.fn();
const generateReport = vi.fn();
const exportReport = vi.fn();
let navigationListener: ((page: 'today') => void) | undefined;

function api(): DsrApi {
  return {
    navigation: {
      onOpen: vi.fn((listener) => { navigationListener = listener; return vi.fn(); })
    },
    security: {
      status: securityStatus,
      unlock
    },
    entries: {
      list: listEntries,
      create: createEntry,
      update: vi.fn(),
      delete: vi.fn(),
      listCustomFields: vi.fn().mockResolvedValue([]),
      createCustomField: vi.fn(),
      updateCustomField: vi.fn()
    },
    templates: {
      list: listTemplates,
      import: importTemplate,
      setDefault: vi.fn(),
      activateVersion: vi.fn()
    },
    providers: {
      list: listProviders,
      save: vi.fn(),
      test: vi.fn(),
      login: vi.fn(),
      delete: vi.fn()
    },
    reports: {
      estimate: vi.fn(),
      generate: generateReport,
      export: exportReport,
      updateDraft: vi.fn()
    },
    settings: {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn()
    },
    backup: {
      status: vi.fn().mockResolvedValue({}),
      create: vi.fn(),
      restore: vi.fn()
    }
  };
}

beforeEach(() => {
  createEntry.mockReset();
  listEntries.mockReset().mockResolvedValue([]);
  securityStatus.mockReset().mockResolvedValue({ locked: false, requiresPassphrase: false });
  unlock.mockReset().mockResolvedValue({ unlocked: true });
  listTemplates.mockReset().mockResolvedValue([]);
  importTemplate.mockReset();
  listProviders.mockReset().mockResolvedValue([]);
  generateReport.mockReset();
  exportReport.mockReset();
  navigationListener = undefined;
  Object.defineProperty(window, 'dsr', { value: api(), configurable: true });
});

describe('Workspace security', () => {
  it('requires the launch passphrase before reading private entries', async () => {
    securityStatus.mockResolvedValue({ locked: true, requiresPassphrase: true });
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText('Database passphrase'), 'a secure local passphrase');
    expect(listEntries).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Unlock workspace' }));

    await waitFor(() => expect(unlock).toHaveBeenCalledWith('a secure local passphrase'));
    await waitFor(() => expect(listEntries).toHaveBeenCalled());
  });
});

describe('Reminder navigation', () => {
  it('opens the Today screen when the main process sends a reminder navigation event', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Settings/ }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();

    navigationListener?.('today');

    expect(await screen.findByRole('heading', { name: 'What moved forward today?' })).toBeInTheDocument();
  });
});

afterEach(cleanup);

describe('Today entry flow', () => {
  it('records a quick work update and clears the note', async () => {
    createEntry.mockResolvedValue({ id: 'entry-1' });
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText('What did you work on?'), 'Finished DSR entry flow');
    await user.type(screen.getByLabelText('Project'), 'DSR Creator');
    await user.click(screen.getByRole('button', { name: 'Save update' }));

    await waitFor(() =>
      expect(createEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          note: 'Finished DSR entry flow',
          standardValues: expect.objectContaining({ project: 'DSR Creator' })
        })
      )
    );
    expect(screen.getByLabelText('What did you work on?')).toHaveValue('');
  });

  it('shows saved entries returned by the local API', async () => {
    listEntries.mockResolvedValue([
      {
        id: 'entry-1',
        workDate: new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10),
        note: 'Validated encrypted storage',
        standardValues: { project: 'DSR Creator', status: 'done' },
        customValues: {},
        tags: ['security'],
        createdAt: '2026-08-31T09:00:00.000Z',
        updatedAt: '2026-08-31T09:00:00.000Z'
      }
    ]);

    render(<App />);

    const note = await screen.findByText('Validated encrypted storage');
    expect(note).toBeInTheDocument();
    expect(within(note.closest('article')!).getByText('DSR Creator')).toBeInTheDocument();
  });
});

describe('Template and report flow', () => {
  it('saves written format instructions for reuse', async () => {
    importTemplate.mockResolvedValue({ id: 'template-1' });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /Templates/ }));
    await user.type(screen.getByLabelText('Template name'), 'Team DSR');
    await user.type(screen.getByLabelText('Format instructions'), 'Completed work followed by blockers');
    await user.click(screen.getByRole('button', { name: 'Save template' }));

    await waitFor(() => expect(importTemplate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Team DSR',
      instructions: 'Completed work followed by blockers'
    })));
  });

  it('shows an editable generated preview and exports it without regenerating', async () => {
    listTemplates.mockResolvedValue([{
      id: 'template-1',
      name: 'Team DSR',
      isDefault: true,
      activeVersionId: 'version-1',
      versionNumber: 1,
      blueprint: {
        schemaVersion: 1,
        templateVersionId: 'version-1',
        sections: [{ id: 'done', title: 'Completed', kind: 'bullets', sourceFields: ['note'], required: true }],
        fieldMappings: [], narrativeRules: [], outputLayouts: {}
      },
      versions: [{ id: 'version-1', versionNumber: 1, instructions: '', createdAt: '2026-08-31T00:00:00.000Z' }]
    }]);
    generateReport.mockResolvedValue({
      id: 'report-1', estimatedTokens: 0, cacheHit: false, chunked: false,
      draft: {
        schemaVersion: 1,
        metadata: { title: 'Daily Status Report', dateFrom: '2026-08-31', dateTo: '2026-08-31', generatedAt: '2026-08-31T18:00:00.000Z' },
        sections: [{ id: 'done', title: 'Completed', kind: 'bullets', items: ['Initial result'] }],
        warnings: []
      }
    });
    exportReport.mockResolvedValue({ path: '/tmp/report.md', bytes: 42 });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /Generate/ }));
    await user.click(await screen.findByRole('button', { name: 'Generate preview' }));
    expect(await screen.findByDisplayValue('Initial result')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Export report' }));

    await waitFor(() => expect(exportReport).toHaveBeenCalledWith('report-1', 'markdown'));
    expect(generateReport).toHaveBeenCalledTimes(1);
  });
});
