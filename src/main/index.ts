import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell
} from 'electron';
import { BackupService, replaceDatabaseFile } from './backup/backup-service';
import { ExportService } from './export/export-service';
import { ProviderFactory } from './providers/provider-factory';
import { CodexAppServerTransport } from './providers/codex-app-server-transport';
import { EntryRepository } from './repositories/entry-repository';
import {
  DatabaseCredentialVault,
  ProviderRepository,
  type ProviderCredentialVault
} from './repositories/provider-repository';
import { SettingsRepository } from './repositories/settings-repository';
import { TemplateRepository, type TemplateRecord } from './repositories/template-repository';
import { ReportEngine } from './reports/report-engine';
import { CredentialStore, InsecureCredentialBackendError } from './security/credential-store';
import { FileSecretPersistence } from './security/file-secret-persistence';
import { openEncryptedDatabase, rekeyEncryptedDatabase, type DsrDatabase } from './storage/database';
import { ReminderScheduler, type ReminderSettings } from './reminders/reminder-scheduler';
import { TemplateCompiler } from './templates/template-compiler';
import { parseTemplateSample } from './templates/sample-parser';
import { exportFormatSchema, reportDraftSchema, type ExportFormat, type GenerationRequest } from '../shared/contracts';
import type {
  ProviderProfileSaveInput,
  ProviderProfileView,
  ReportGenerationInput,
  TemplateImportInput,
  TemplateSummary
} from '../shared/ipc';

let mainWindow: BrowserWindow | undefined;
let database: DsrDatabase | undefined;
let entries: EntryRepository | undefined;
let settings: SettingsRepository | undefined;
let templates: TemplateRepository | undefined;
let providers: ProviderRepository | undefined;
let providerFactory: ProviderFactory | undefined;
let reports: ReportEngine | undefined;
let exporter: ExportService | undefined;
let databaseKey: Buffer | undefined;
let credentialStore: CredentialStore | undefined;
let requiresPassphrase = false;
let startupError: string | undefined;
let backupTimer: NodeJS.Timeout | undefined;
const reminders = new ReminderScheduler();
const backups = new BackupService();
const templateCompiler = new TemplateCompiler();

function requireEntries(): EntryRepository {
  if (!entries) throw new Error('The encrypted workspace is locked');
  return entries;
}

function requireSettings(): SettingsRepository {
  if (!settings) throw new Error('The encrypted workspace is locked');
  return settings;
}

function requireTemplates(): TemplateRepository {
  if (!templates) throw new Error('The encrypted workspace is locked');
  return templates;
}

function requireProviders(): ProviderRepository {
  if (!providers) throw new Error('The encrypted workspace is locked');
  return providers;
}

function requireProviderFactory(): ProviderFactory {
  if (!providerFactory) throw new Error('The encrypted workspace is locked');
  return providerFactory;
}

function requireReports(): ReportEngine {
  if (!reports) throw new Error('The encrypted workspace is locked');
  return reports;
}

function openToday(): void {
  mainWindow?.show();
  mainWindow?.focus();
  mainWindow?.webContents.send('navigation:open', 'today');
}

function osCredentialVault(store: CredentialStore): ProviderCredentialVault {
  return {
    set: (id, value) => store.setProviderCredential(id, value),
    get: (id) => store.getProviderCredential(id),
    delete: (id) => store.deleteProviderCredential(id)
  };
}

function initializeDatabase(key: Buffer): void {
  if (database) return;
  const dataDirectory = app.getPath('userData');
  database = openEncryptedDatabase(join(dataDirectory, 'dsr-creator.db'), key);
  databaseKey = Buffer.from(key);
  entries = new EntryRepository(database);
  settings = new SettingsRepository(database);
  templates = new TemplateRepository(database);
  const vault = requiresPassphrase || !credentialStore
    ? new DatabaseCredentialVault(database)
    : osCredentialVault(credentialStore);
  providers = new ProviderRepository(database, vault);
  providerFactory = new ProviderFactory(providers);
  reports = new ReportEngine(database, (profileId) => requireProviderFactory().resolve(profileId));
  exporter = new ExportService(renderPdf);
  const reminder = settings.get<ReminderSettings>('reminder') ?? { enabled: false, time: '17:30' };
  reminders.schedule(reminder, openToday);
  scheduleAutomaticBackups();
}

function scheduleAutomaticBackups(): void {
  if (backupTimer) clearTimeout(backupTimer);
  void runAutomaticBackup();
  const now = new Date();
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 5, 0, 0);
  backupTimer = setTimeout(scheduleAutomaticBackups, next.getTime() - now.getTime());
}

async function runAutomaticBackup(): Promise<void> {
  if (!database || !settings) return;
  try {
    const path = await backups.createAutomatic(
      join(app.getPath('userData'), 'backups'),
      new Date(),
      (targetPath) => database!.backup(targetPath)
    );
    settings.set('backup-health', { lastSuccess: new Date().toISOString(), path });
  } catch (error) {
    const previous = settings.get<{ lastSuccess?: string }>('backup-health') ?? {};
    settings.set('backup-health', {
      ...previous,
      lastError: error instanceof Error ? error.message : 'Automatic backup failed'
    });
  }
}

function closeDatabase(): void {
  database?.close();
  database = undefined;
  entries = undefined;
  settings = undefined;
  templates = undefined;
  providers = undefined;
  providerFactory = undefined;
  reports = undefined;
  exporter = undefined;
}

function derivePassphraseKey(passphrase: string): Buffer {
  if (passphrase.length < 12) throw new Error('Use at least 12 characters for the database passphrase');
  const dataDirectory = app.getPath('userData');
  const saltPath = join(dataDirectory, 'database.salt');
  let salt: Buffer;
  try {
    salt = readFileSync(saltPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    salt = randomBytes(16);
    writeFileSync(saltPath, salt, { mode: 0o600 });
  }
  return scryptSync(passphrase, salt, 32);
}

function registerIpc(): void {
  ipcMain.handle('security:status', () => ({ locked: !database, requiresPassphrase, recoveryError: startupError }));
  ipcMain.handle('security:unlock', (_event, passphrase: string) => {
    try {
      initializeDatabase(derivePassphraseKey(passphrase));
      return { unlocked: true };
    } catch (error) {
      throw new Error(error instanceof Error ? `Could not unlock workspace: ${error.message}` : 'Could not unlock workspace');
    }
  });

  ipcMain.handle('entries:list', (_event, filter) => requireEntries().list(filter));
  ipcMain.handle('entries:create', (_event, input) => requireEntries().create(input));
  ipcMain.handle('entries:update', (_event, id, patch) => requireEntries().update(id, patch));
  ipcMain.handle('entries:delete', (_event, id) => requireEntries().delete(id));
  ipcMain.handle('entries:custom-fields:list', (_event, activeOnly) =>
    requireEntries().listCustomFields({ activeOnly })
  );
  ipcMain.handle('entries:custom-fields:create', (_event, input) =>
    requireEntries().createCustomField(input)
  );
  ipcMain.handle('entries:custom-fields:update', (_event, id, patch) =>
    requireEntries().updateCustomField(id, patch)
  );

  ipcMain.handle('templates:list', () => requireTemplates().list().map(toTemplateSummary));
  ipcMain.handle('templates:import', async (_event, input: TemplateImportInput) => {
    const source = input.sourceBase64 ? Buffer.from(input.sourceBase64, 'base64') : undefined;
    const parsed = source && input.sourceName
      ? await parseTemplateSample({ name: input.sourceName, data: source })
      : undefined;
    const transport = input.providerProfileId
      ? requireProviderFactory().resolveTransport(input.providerProfileId)
      : undefined;
    const compiled = await templateCompiler.compile({
      versionId: 'pending',
      instructions: input.instructions,
      sample: parsed,
      transport
    });
    if (input.templateId) {
      requireTemplates().addVersion(input.templateId, {
        instructions: input.instructions,
        sourceType: parsed?.kind,
        sourceName: input.sourceName,
        sourceBlob: source,
        buildBlueprint: (versionId) => ({ ...compiled, templateVersionId: versionId })
      });
      return toTemplateSummary(requireTemplates().get(input.templateId)!);
    }
    return toTemplateSummary(requireTemplates().create({
      name: input.name,
      instructions: input.instructions,
      sourceType: parsed?.kind,
      sourceName: input.sourceName,
      sourceBlob: source,
      makeDefault: input.makeDefault ?? requireTemplates().list().length === 0,
      buildBlueprint: (versionId) => ({ ...compiled, templateVersionId: versionId })
    }));
  });
  ipcMain.handle('templates:set-default', (_event, id: string) => requireTemplates().setDefault(id));
  ipcMain.handle('templates:activate-version', (_event, templateId: string, versionId: string) =>
    requireTemplates().activateVersion(templateId, versionId)
  );

  ipcMain.handle('providers:list', () => requireProviders().list().map(toProviderView));
  ipcMain.handle('providers:save', (_event, input: ProviderProfileSaveInput) =>
    toProviderView(requireProviders().save(input))
  );
  ipcMain.handle('providers:test', async (_event, id: string) => {
    const health = await requireProviderFactory().resolve(id).healthCheck();
    return { ok: health.ok, message: health.message };
  });
  ipcMain.handle('providers:login', async (_event, id: string) => {
    const profile = requireProviders().get(id);
    if (!profile || profile.kind !== 'codex-subscription') throw new Error('Browser login is available for Codex subscription profiles');
    await new CodexAppServerTransport(profile.model).login((url) => shell.openExternal(url));
    return { ok: true, message: 'Codex subscription connected' };
  });
  ipcMain.handle('providers:delete', (_event, id: string) => requireProviders().delete(id));

  ipcMain.handle('reports:estimate', async (_event, input: ReportGenerationInput) => {
    const request = buildGenerationRequest(input);
    return requireReports().estimate(request, input.providerProfileId);
  });
  ipcMain.handle('reports:generate', async (_event, input: ReportGenerationInput) => {
    const request = buildGenerationRequest(input);
    return requireReports().generate(request, {
      providerProfileId: input.providerProfileId,
      exportFormat: exportFormatSchema.parse(input.format)
    });
  });
  ipcMain.handle('reports:update-draft', (_event, id: string, draft: unknown) =>
    requireReports().updateDraft(id, reportDraftSchema.parse(draft))
  );
  ipcMain.handle('reports:export', async (_event, id: string, requestedFormat: ExportFormat) => {
    if (!exporter) throw new Error('The encrypted workspace is locked');
    const format = exportFormatSchema.parse(requestedFormat);
    const generation = requireReports().getGeneration(id);
    const blueprint = findTemplateVersion(generation.templateVersionId).blueprint;
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export Daily Status Report',
      defaultPath: `DSR-${generation.draft.metadata.dateFrom}-to-${generation.draft.metadata.dateTo}.${extensionFor(format)}`,
      filters: [{ name: format.toUpperCase(), extensions: [extensionFor(format)] }]
    });
    if (result.canceled || !result.filePath) throw new Error('Export cancelled');
    return exporter.export(format, { draft: generation.draft, blueprint, targetPath: result.filePath });
  });

  ipcMain.handle('settings:reminder:get', () => requireSettings().get<ReminderSettings>('reminder'));
  ipcMain.handle('settings:reminder:set', (_event, value: ReminderSettings) => {
    if (typeof value?.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) {
      throw new Error('Invalid reminder settings');
    }
    requireSettings().set('reminder', value);
    reminders.schedule(value, openToday);
  });

  ipcMain.handle('backup:create', async (_event, input?: { password?: string }) => {
    if (!database) throw new Error('The encrypted workspace is locked');
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Create encrypted DSR backup',
      defaultPath: `DSR-Backup-${new Date().toISOString().slice(0, 10)}.dsrbackup`,
      filters: [{ name: 'DSR encrypted backup', extensions: ['dsrbackup'] }]
    });
    if (result.canceled || !result.filePath) throw new Error('Backup cancelled');
    const directory = await mkdtemp(join(tmpdir(), 'dsr-backup-export-'));
    try {
      const snapshot = join(directory, 'snapshot.db');
      await database.backup(snapshot);
      await backups.exportPortable(snapshot, result.filePath, input?.password ?? '', databaseKey);
      return { path: result.filePath };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  ipcMain.handle('backup:status', () => requireSettings().get('backup-health') ?? {});
  ipcMain.handle('backup:restore', async (_event, input?: { password?: string }) => {
    if (!database || !databaseKey) throw new Error('The encrypted workspace is locked');
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Restore encrypted DSR backup',
      properties: ['openFile'],
      filters: [{ name: 'DSR encrypted backup', extensions: ['dsrbackup'] }]
    });
    const source = result.filePaths[0];
    if (result.canceled || !source) throw new Error('Restore cancelled');
    const directory = await mkdtemp(join(app.getPath('userData'), '.dsr-backup-restore-'));
    const restored = join(directory, 'restored.db');
    const livePath = join(app.getPath('userData'), 'dsr-creator.db');
    try {
      const material = await backups.restorePortable(source, restored, input?.password ?? '');
      if (material.databaseKey && !material.databaseKey.equals(databaseKey)) {
        rekeyEncryptedDatabase(restored, material.databaseKey, databaseKey);
      }
      const validation = openEncryptedDatabase(restored, databaseKey);
      validation.close();
      const safetyPath = `${livePath}.pre-restore-${Date.now()}-${randomBytes(4).toString('hex')}`;
      closeDatabase();
      try {
        await replaceDatabaseFile(livePath, restored, safetyPath);
      } catch (error) {
        initializeDatabase(databaseKey);
        throw error;
      }
      app.relaunch();
      app.exit(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  ipcMain.handle('dialog:save', async (_event, options) => {
    const result = await dialog.showSaveDialog(mainWindow!, options);
    return result.canceled ? undefined : result.filePath;
  });
  ipcMain.handle('shell:open-external', (_event, url: string) => {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Unsupported URL protocol');
    return shell.openExternal(parsed.toString());
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#f3f2ed',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function buildGenerationRequest(input: ReportGenerationInput): GenerationRequest {
  const template = requireTemplates().get(input.templateId);
  if (!template) throw new Error('Template not found');
  const versionId = input.templateVersionId ?? template.activeVersionId;
  const version = template.versions.find((candidate) => candidate.id === versionId);
  if (!version) throw new Error('Template version not found');
  const profile = input.providerProfileId
    ? requireProviderFactory().resolveProfile(input.providerProfileId)
    : requireProviders().list().find((candidate) => candidate.isDefault && candidate.enabled);
  return {
    entries: requireEntries().list({ dateFrom: input.dateFrom, dateTo: input.dateTo }),
    blueprint: version.blueprint,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    model: input.model ?? profile?.model ?? 'local-deterministic',
    contextLimit: profile?.contextLimit ?? 32_768
  };
}

function findTemplateVersion(versionId: string) {
  for (const template of requireTemplates().list()) {
    const version = template.versions.find((candidate) => candidate.id === versionId);
    if (version) return version;
  }
  throw new Error('Template version not found');
}

function toTemplateSummary(template: TemplateRecord): TemplateSummary {
  const active = template.versions.find((version) => version.id === template.activeVersionId)!;
  return {
    id: template.id,
    name: template.name,
    isDefault: template.isDefault,
    activeVersionId: template.activeVersionId,
    versionNumber: active.versionNumber,
    blueprint: active.blueprint,
    versions: template.versions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      instructions: version.instructions,
      sourceName: version.sourceName,
      createdAt: version.createdAt
    }))
  };
}

function toProviderView(profile: ReturnType<ProviderRepository['save']>): ProviderProfileView {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    model: profile.model,
    contextLimit: profile.contextLimit,
    enabled: profile.enabled,
    isDefault: profile.isDefault
  };
}

function extensionFor(format: ExportFormat): string {
  return format === 'markdown' ? 'md' : format;
}

async function renderPdf(html: string, options: { landscape: boolean }): Promise<Buffer> {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await window.webContents.printToPDF({ landscape: options.landscape, printBackground: true });
  } finally {
    window.destroy();
  }
}

app.whenReady().then(async () => {
  const dataDirectory = app.getPath('userData');
  mkdirSync(dataDirectory, { recursive: true });
  const secrets = new FileSecretPersistence(join(dataDirectory, 'secrets'));
  credentialStore = new CredentialStore(
    {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      backend: () => (process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os'),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    },
    secrets,
    process.platform
  );
  try {
    initializeDatabase(credentialStore.getOrCreateDatabaseKey());
  } catch (error) {
    if (error instanceof InsecureCredentialBackendError) {
      requiresPassphrase = true;
      credentialStore = undefined;
    }
    else startupError = error instanceof Error ? error.message : 'The encrypted database could not be opened';
  }
  registerIpc();
  await createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  reminders.cancel();
  if (backupTimer) clearTimeout(backupTimer);
  closeDatabase();
});
