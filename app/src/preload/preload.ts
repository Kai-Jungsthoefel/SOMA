import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { SomaApi } from '../shared/types';

/** Schmale, feste Schnittstelle zwischen Renderer und Hauptprozess. Der Renderer hat keinen Node-Zugriff. */
const api: SomaApi = {
  testMode: process.env.SOMA_TEST === '1',
  startsHome: process.env.SOMA_TEST !== '1' || process.env.SOMA_TEST_START === 'home',
  project: {
    current: () => ipcRenderer.invoke('project:current'),
    create: () => ipcRenderer.invoke('project:create'),
    list: () => ipcRenderer.invoke('project:list'),
    open: (id) => ipcRenderer.invoke('project:open', id),
    onChanged: (cb) => { ipcRenderer.on('project:changed', (_e, p) => cb(p)); },
    saveState: () => ipcRenderer.invoke('project:saveState'),
    save: (saveAs) => ipcRenderer.invoke('project:save', saveAs),
    openZip: () => ipcRenderer.invoke('project:openZip'),
    exportZip: () => ipcRenderer.invoke('project:exportZip'),
    onSaveState: (cb) => { ipcRenderer.on('save:state', (_e, st) => cb(st)); },
    reveal: () => ipcRenderer.invoke('project:reveal'),
    setThumb: (dataUrl) => ipcRenderer.invoke('project:setThumb', dataUrl),
    thumb: (id) => ipcRenderer.invoke('project:thumb', id),
    remove: (id) => ipcRenderer.invoke('project:remove', id),
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
    create: (parent, name, dir) => ipcRenderer.invoke('fs:create', parent, name, dir),
    rename: (rel, name) => ipcRenderer.invoke('fs:rename', rel, name),
    trash: (rel) => ipcRenderer.invoke('fs:trash', rel),
    reveal: (rel) => ipcRenderer.invoke('fs:reveal', rel),
    openExternal: (rel) => ipcRenderer.invoke('fs:openExternal', rel),
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
  measure: {
    query: (source, req) => ipcRenderer.invoke('measure:query', source, req),
    start: () => ipcRenderer.invoke('measure:start'),
    prepare: (source, build) => ipcRenderer.invoke('measure:prepare', source, build),
  },
  params: {
    state: () => ipcRenderer.invoke('params:state'),
    set: (values) => ipcRenderer.invoke('params:set', values),
    resetAll: () => ipcRenderer.invoke('params:resetAll'),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    set: (id, mode) => ipcRenderer.invoke('skills:set', id, mode),
    configure: (id, values) => ipcRenderer.invoke('skills:configure', id, values),
    setDefault: (id, mode) => ipcRenderer.invoke('skills:setDefault', id, mode),
  },
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    read: (id) => ipcRenderer.invoke('library:read', id),
    check: (text) => ipcRenderer.invoke('library:check', text),
    save: (id, text, base) => ipcRenderer.invoke('library:save', id, text, base),
    create: (title, from) => ipcRenderer.invoke('library:create', title, from),
    remove: (id) => ipcRenderer.invoke('library:remove', id),
    import: () => ipcRenderer.invoke('library:import'),
    setDefault: (id, mode) => ipcRenderer.invoke('library:setDefault', id, mode),
    reveal: (id) => ipcRenderer.invoke('library:reveal', id),
  },
  anim: {
    list: () => ipcRenderer.invoke('anim:list'),
    build: (file) => ipcRenderer.invoke('anim:build', file ?? null),
    onChanged: (cb) => { ipcRenderer.on('anim:changed', () => cb()); },
  },
  results: {
    list: () => ipcRenderer.invoke('results:list'),
    rerun: (id) => ipcRenderer.invoke('results:rerun', id),
  },
  render: {
    video: (animId) => ipcRenderer.invoke('render:video', animId),
    onProgress: (cb) => { ipcRenderer.on('render:progress', (_e, f) => cb(f)); },
    onNotice: (cb) => { ipcRenderer.on('render:notice', (_e, n) => cb(n)); },
  },
  dialog: { choose: (o) => ipcRenderer.invoke('dialog:choose', o) },
  openUrl: (url) => ipcRenderer.invoke('app:openUrl', url),
  // Nur im Testmodus: vorbereitete Antworten für native Dialoge
  test: process.env.SOMA_TEST === '1'
    ? { answers: (a) => ipcRenderer.invoke('test:answers', a), screenshot: (f) => ipcRenderer.invoke('test:screenshot', f), bridge: () => ipcRenderer.invoke('test:bridge'), close: () => ipcRenderer.invoke('test:close') }
    : undefined,
};

contextBridge.exposeInMainWorld('soma', api);
