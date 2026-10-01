import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { SomaApi } from '../shared/types';

/** Schmale, feste Schnittstelle zwischen Renderer und Hauptprozess. Der Renderer hat keinen Node-Zugriff. */
const api: SomaApi = {
  testMode: process.env.SOMA_TEST === '1',
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
    reveal: () => ipcRenderer.invoke('project:reveal'),
    setThumb: (dataUrl) => ipcRenderer.invoke('project:setThumb', dataUrl),
    thumb: (id) => ipcRenderer.invoke('project:thumb', id),
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
    export: (format, part) => ipcRenderer.invoke('build:export', format, part),
  },
  fs: {
    list: () => ipcRenderer.invoke('fs:list'),
    readText: (rel) => ipcRenderer.invoke('fs:readText', rel),
    readBinary: (rel) => ipcRenderer.invoke('fs:readBinary', rel),
    onChanged: (cb) => { ipcRenderer.on('fs:changed', () => cb()); },
    // Der Renderer kennt keine Dateipfade. Nur die Pfade gezogener Dateien gehen an den Hauptprozess, der prüft und kopiert.
    importFiles: (files) => ipcRenderer.invoke('fs:import', files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
    saveFeedback: (png) => ipcRenderer.invoke('fs:saveFeedback', png),
    writeText: (id, rel, text, base, force) => ipcRenderer.invoke('fs:writeText', id, rel, text, base, force),
    backupText: (id, rel, text) => ipcRenderer.invoke('fs:backupText', id, rel, text),
    onEditorRequest: (cb) => {
      ipcRenderer.on('editor:req', async (_e, id: number, action: 'status' | 'save' | 'discard') => ipcRenderer.send('editor:res', id, await cb(action).catch(() => null)));
    },
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
  measure: { query: (source, req) => ipcRenderer.invoke('measure:query', source, req) },
  dialog: { choose: (o) => ipcRenderer.invoke('dialog:choose', o) },
  // Nur im Testmodus: vorbereitete Antworten für native Dialoge
  test: process.env.SOMA_TEST === '1'
    ? { answers: (a) => ipcRenderer.invoke('test:answers', a), screenshot: (f) => ipcRenderer.invoke('test:screenshot', f) }
    : undefined,
};

contextBridge.exposeInMainWorld('soma', api);
