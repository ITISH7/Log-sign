import { contextBridge, ipcRenderer } from 'electron';
import type { DsrApi } from '../shared/ipc';

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: DsrApi = {
  navigation: {
    onOpen: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, page: 'today') => listener(page);
      ipcRenderer.on('navigation:open', handler);
      return () => ipcRenderer.removeListener('navigation:open', handler);
    }
  },
  security: {
    status: () => invoke('security:status'),
    unlock: (passphrase) => invoke('security:unlock', passphrase)
  },
  entries: {
    list: (filter) => invoke('entries:list', filter),
    create: (input) => invoke('entries:create', input),
    update: (id, patch) => invoke('entries:update', id, patch),
    delete: (id) => invoke('entries:delete', id),
    listCustomFields: (activeOnly) => invoke('entries:custom-fields:list', activeOnly),
    createCustomField: (input) => invoke('entries:custom-fields:create', input),
    updateCustomField: (id, patch) => invoke('entries:custom-fields:update', id, patch)
  },
  templates: {
    list: () => invoke('templates:list'),
    import: (input) => invoke('templates:import', input),
    setDefault: (id) => invoke('templates:set-default', id),
    activateVersion: (templateId, versionId) => invoke('templates:activate-version', templateId, versionId)
  },
  providers: {
    list: () => invoke('providers:list'),
    save: (input) => invoke('providers:save', input),
    test: (id) => invoke('providers:test', id),
    login: (id) => invoke('providers:login', id),
    delete: (id) => invoke('providers:delete', id)
  },
  reports: {
    estimate: (input) => invoke('reports:estimate', input),
    generate: (input) => invoke('reports:generate', input),
    export: (id, format) => invoke('reports:export', id, format),
    updateDraft: (id, draft) => invoke('reports:update-draft', id, draft)
  },
  settings: {
    get: () => invoke('settings:reminder:get'),
    set: (_key, value) => invoke('settings:reminder:set', value)
  },
  backup: {
    status: () => invoke('backup:status'),
    create: (input) => invoke('backup:create', input),
    restore: (input) => invoke('backup:restore', input)
  }
};

contextBridge.exposeInMainWorld('dsr', api);
