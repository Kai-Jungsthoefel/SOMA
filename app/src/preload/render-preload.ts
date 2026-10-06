import { contextBridge, ipcRenderer } from 'electron';
import type { RenderApi } from '../shared/types';

/** Unsichtbares Render-Fenster (E58): bekommt Aufträge mit allen Daten und gibt Bilder zurück. Kein Dateizugriff. */
const api: RenderApi = {
  onJob: (cb) => { ipcRenderer.on('render:job', (_e, job) => cb(job)); },
  done: (id, out) => ipcRenderer.send('render:done', id, out),
  progress: (id, f) => ipcRenderer.send('render:progress', id, f),
  ready: () => ipcRenderer.send('render:ready'),
};

contextBridge.exposeInMainWorld('somaRender', api);
