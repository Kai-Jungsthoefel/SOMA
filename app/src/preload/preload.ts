import { contextBridge, ipcRenderer } from 'electron';
import type { CadideApi } from '../shared/types';

/** Schmale, feste Schnittstelle zwischen Renderer und Hauptprozess. Der Renderer hat keinen Node-Zugriff. */
const api: CadideApi = {
  testMode: process.env.CADIDE_TEST === '1',
  project: {
    current: () => ipcRenderer.invoke('project:current'),
    create: () => ipcRenderer.invoke('project:create'),
    list: () => ipcRenderer.invoke('project:list'),
    open: (id) => ipcRenderer.invoke('project:open', id),
    onChanged: (cb) => { ipcRenderer.on('project:changed', (_e, p) => cb(p)); },
    saveState: () => ipcRenderer.invoke('project:saveState'),
    save: (saveAs) => ipcRenderer.invoke('project:save', saveAs),
    openZip: () => ipcRenderer.invoke('project:openZip'),
    onSaveState: (cb) => { ipcRenderer.on('save:state', (_e, st) => cb(st)); },
  },
  versions: {
    log: () => ipcRenderer.invoke('versions:log'),
    preview: (hash) => ipcRenderer.invoke('versions:preview', hash),
    restore: (hash) => ipcRenderer.invoke('versions:restore', hash),
    onChanged: (cb) => { ipcRenderer.on('versions:changed', () => cb()); },
  },
  build: {
    run: () => ipcRenderer.invoke('build:run'),
    cancel: () => ipcRenderer.invoke('build:cancel'),
    setAuto: (on) => ipcRenderer.invoke('build:setAuto', on),
    status: () => ipcRenderer.invoke('build:status'),
    onStatus: (cb) => { ipcRenderer.on('build:status', (_e, s) => cb(s)); },
  },
  fs: {
    list: () => ipcRenderer.invoke('fs:list'),
    readText: (rel) => ipcRenderer.invoke('fs:readText', rel),
    readBinary: (rel) => ipcRenderer.invoke('fs:readBinary', rel),
    onChanged: (cb) => { ipcRenderer.on('fs:changed', () => cb()); },
  },
  term: {
    create: (opts) => ipcRenderer.invoke('term:create', opts),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('term:kill', id),
    onData: (cb) => { ipcRenderer.on('term:data', (_e, id, data) => cb(id, data)); },
    onExit: (cb) => { ipcRenderer.on('term:exit', (_e, id, code) => cb(id, code)); },
  },
  agents: { detect: () => ipcRenderer.invoke('agents:detect') },
  // Nur im Testmodus: vorbereitete Antworten für native Dialoge
  test: process.env.CADIDE_TEST === '1'
    ? { answers: (a) => ipcRenderer.invoke('test:answers', a), screenshot: (f) => ipcRenderer.invoke('test:screenshot', f) }
    : undefined,
};

contextBridge.exposeInMainWorld('cadide', api);
