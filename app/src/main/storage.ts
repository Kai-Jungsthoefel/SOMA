import fs from 'node:fs';
import path from 'node:path';
import type { StorageArea, StorageEntry, StorageStats } from '../shared/types';
import { backupsDir, previewsDir, thumbnailsDir, userDataDir, userSkillsDir, workspacesDir } from './paths';

/**
 * Speicherplatz in den App-Daten (E81): Größe je Bereich für die Einstellungen. Was dort liegt, legt die App selbst an.
 * Löschen lässt sich hier nur der Vorschau-Cache, der jederzeit neu entsteht. Sicherungen und Arbeitsordner bleiben, wie sie
 * sind (nichts still löschen): Die Einstellungen öffnen nur ihren Ordner.
 */

/** Ordner der Bereiche. Der Renderer nennt nur die Kennung, nie einen Pfad. */
export function areaDir(area: StorageArea): string {
  switch (area) {
    case 'appdata': return userDataDir();
    case 'workspaces': return workspacesDir();
    case 'backups': return backupsDir();
    case 'previews': return previewsDir();
    case 'thumbnails': return thumbnailsDir();
    case 'skills': return userSkillsDir();
  }
}
export const isStorageArea = (a: unknown): a is StorageArea => ['appdata', 'workspaces', 'backups', 'previews', 'thumbnails', 'skills'].includes(a as string);

/**
 * Größe eines Ordners mit allem darin. Verknüpfungen zählen nicht (sie könnten aus den App-Daten hinaus oder im Kreis
 * führen). Unlesbares wird übergangen: Die Zahl ist eine Auskunft, kein Maß für eine Entscheidung.
 */
export async function folderSize(dir: string): Promise<{ bytes: number; files: number }> {
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return { bytes: 0, files: 0 }; }
  let bytes = 0, files = 0;
  // In Portionen, damit große Arbeitsordner (Git, Projektumgebungen) nicht Tausende Dateien gleichzeitig öffnen
  for (let i = 0; i < entries.length; i += 64) {
    const sizes = await Promise.all(entries.slice(i, i + 64).map(async (e) => {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) return { bytes: 0, files: 0 };
      if (e.isDirectory()) return folderSize(p);
      try { return { bytes: (await fs.promises.lstat(p)).size, files: 1 }; } catch { return { bytes: 0, files: 0 }; }
    }));
    for (const s of sizes) { bytes += s.bytes; files += s.files; }
  }
  return { bytes, files };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Größe der App-Daten je Bereich. „other“: alles Übrige (Caches von Chromium, state.json, settings.json …). */
export async function storageStats(): Promise<StorageStats> {
  const dir = userDataDir();
  const ids: StorageArea[] = ['workspaces', 'backups', 'previews', 'thumbnails', 'skills'];
  const [total, ...sizes] = await Promise.all([folderSize(dir), ...ids.map((a) => folderSize(areaDir(a)))]);
  let models = 0;
  try { models = fs.readdirSync(workspacesDir()).filter((n) => UUID.test(n)).length; } catch { /* noch keins */ }
  const areas: StorageEntry[] = ids.map((id, i) => ({ id, path: areaDir(id), ...sizes[i], ...(id === 'workspaces' ? { models } : {}) }));
  const known = sizes.reduce((s, x) => s + x.bytes, 0);
  areas.push({ id: 'other', path: null, bytes: Math.max(0, total.bytes - known), files: Math.max(0, total.files - sizes.reduce((s, x) => s + x.files, 0)) });
  return { dir, total: total.bytes, areas };
}

/**
 * Vorschau-Cache leeren (Vorschauen alter Stände, E66). Die des offenen Modells (`keep`) bleiben: Eine gerade gezeigte oder
 * vermessene Vorschau liest ihre Dateien dort. Rückgabe: frei gewordene Bytes und ob etwas stehen blieb.
 */
export async function clearPreviews(keep: string | null): Promise<{ freed: number; kept: boolean; failed: number }> {
  const root = previewsDir();
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return { freed: 0, kept: false, failed: 0 }; }
  let freed = 0, failed = 0, kept = false;
  for (const n of names) {
    if (keep && n === keep) { kept = true; continue; }
    const p = path.join(root, n);
    const size = (await folderSize(p)).bytes || (await fs.promises.lstat(p).then((s) => s.size, () => 0));
    try { await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); freed += size; } catch { failed++; }
  }
  return { freed, kept, failed };
}
