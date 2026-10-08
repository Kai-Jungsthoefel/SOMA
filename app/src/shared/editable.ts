// Regeln für Dateien, die Renderer und Hauptprozess gleich anwenden müssen: welche der Editor nur zeigt (der Renderer
// sperrt das Bearbeiten, der Hauptprozess lehnt das Schreiben ab) und welche das Modell betreffen (nur dann wird gebaut).

/** Grund, warum eine Datei (Pfad relativ zum Projekt) nur lesbar ist, sonst null. */
export function readOnlyReason(rel: string): string | null {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^(AGENTS|CLAUDE)\.md$/i.test(p)) return 'Managed by the app and replaced on updates. Your own wishes and rules belong in NOTES.md.';
  if (/^parameters\.json$/i.test(p)) return 'Your values from the Parameters panel. Change them there, on the left under “Parameters”.';
  if (/^\.gitignore$/i.test(p)) return 'Managed by the app.';
  if (/^(output|exports)\//i.test(p)) return 'Recreated on every build or export.';
  if (/^\.soma\/skills\//i.test(p)) return 'Copy of a skill. Change it on the left under “Skills”.';
  if (/^\.(soma|git)(\/|$)/i.test(p)) return 'Internal data of the app and of Git.';
  return null;
}

/**
 * Grund, warum der Dateibaum hier nicht anlegen, umbenennen oder löschen darf, sonst null. Bei `create` ist `rel` der neue
 * Pfad (auch das Ziel einer Umbenennung). App-Dateien, Ergebnisse und interne Daten bleiben unangetastet, `model.py`
 * ist der feste Einstiegspunkt (E6), `inputs/` und `parts/` sind Ordner, die `AGENTS.md` dem Agenten nennt.
 */
export function fileOpBlockReason(rel: string, op: 'create' | 'rename' | 'delete'): string | null {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!p) return op === 'create' ? null : 'The project folder itself cannot be changed here.';
  if (/^(AGENTS|CLAUDE)\.md$/i.test(p) || /^\.gitignore$/i.test(p)) return 'Managed by the app.';
  if (/^output(\/|$)/i.test(p)) return 'Recreated on every build.';
  // Markierungen (E16) gehören dem Nutzer: aufräumen und umbenennen ja. Neues legt dort nur „An Agent geben“ ab, das
  // sperrt die Prüfung des Ordners selbst (.soma/feedback fällt unter die nächste Regel).
  if (/^\.soma\/feedback\/[^/]+$/i.test(p)) return null;
  if (/^\.(soma|git)(\/|$)/i.test(p)) return 'Internal data of the app and of Git.';
  if (op !== 'create' && /^model\.py$/i.test(p)) return 'model.py is the fixed entry point of the model.';
  if (op === 'rename' && /^(inputs|parts)$/i.test(p)) return 'The agent looks for this folder by its name.';
  if (op === 'rename' && /^parameters\.json$/i.test(p)) return 'The app and soma build look for this file by its name.';
  return null;
}

/**
 * Betrifft eine Änderung an dieser Datei das Modell? Python-Dateien, alles in inputs/ (mitgebrachte STEP-Dateien,
 * Tabellen, die model.py einliest) und die Werte aus dem Parameter-Panel. Notizen wie NOTES.md nicht: Nach ihrem
 * Speichern wird nicht gebaut.
 */
export function affectsBuild(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  if (affectsAnimation(p)) return false;
  return /\.py$/i.test(p) || /^inputs\//i.test(p) || /^parameters\.json$/i.test(p);
}

/** Eine Animationsdatei (E58): Ihre Änderung baut die Animation neu, nicht das Modell. */
export function affectsAnimation(rel: string): boolean {
  return /^animations\/[^/]+\.py$/i.test(rel.replace(/\\/g, '/'));
}
