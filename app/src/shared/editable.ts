// Regeln für Dateien, die Renderer und Hauptprozess gleich anwenden müssen: welche der Editor nur zeigt (der Renderer
// sperrt das Bearbeiten, der Hauptprozess lehnt das Schreiben ab) und welche das Modell betreffen (nur dann wird gebaut).

/** Grund, warum eine Datei (Pfad relativ zum Projekt) nur lesbar ist, sonst null. */
export function readOnlyReason(rel: string): string | null {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^(AGENTS|CLAUDE)\.md$/i.test(p)) return 'Wird von der App verwaltet und bei Updates ersetzt. Eigene Wünsche und Regeln gehören in NOTES.md.';
  if (/^\.gitignore$/i.test(p)) return 'Wird von der App verwaltet.';
  if (/^(output|exports)\//i.test(p)) return 'Wird beim Bauen oder Exportieren neu erzeugt.';
  if (/^\.soma\/skills\//i.test(p)) return 'Kopie eines Skills. Umstellen links unter „Skills“.';
  if (/^\.(soma|git)(\/|$)/i.test(p)) return 'Interne Daten der App und von Git.';
  return null;
}

/**
 * Grund, warum der Dateibaum hier nicht anlegen, umbenennen oder löschen darf, sonst null. Bei `create` ist `rel` der neue
 * Pfad (auch das Ziel einer Umbenennung). App-Dateien, Ergebnisse und interne Daten bleiben unangetastet, `model.py`
 * ist der feste Einstiegspunkt (E6), `inputs/` und `parts/` sind Ordner, die `AGENTS.md` dem Agenten nennt.
 */
export function fileOpBlockReason(rel: string, op: 'create' | 'rename' | 'delete'): string | null {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!p) return op === 'create' ? null : 'Der Projektordner selbst lässt sich hier nicht ändern.';
  if (/^(AGENTS|CLAUDE)\.md$/i.test(p) || /^\.gitignore$/i.test(p)) return 'Wird von der App verwaltet.';
  if (/^output(\/|$)/i.test(p)) return 'Wird beim Bauen neu erzeugt.';
  // Markierungen (E16) gehören dem Nutzer: aufräumen und umbenennen ja. Neues legt dort nur „An Agent geben“ ab, das
  // sperrt die Prüfung des Ordners selbst (.soma/feedback fällt unter die nächste Regel).
  if (/^\.soma\/feedback\/[^/]+$/i.test(p)) return null;
  if (/^\.(soma|git)(\/|$)/i.test(p)) return 'Interne Daten der App und von Git.';
  if (op !== 'create' && /^model\.py$/i.test(p)) return 'model.py ist der feste Einstiegspunkt des Modells.';
  if (op === 'rename' && /^(inputs|parts)$/i.test(p)) return 'Der Agent sucht diesen Ordner unter seinem Namen.';
  return null;
}

/**
 * Betrifft eine Änderung an dieser Datei das Modell? Python-Dateien und alles in inputs/ (mitgebrachte STEP-Dateien,
 * Tabellen, die model.py einliest). Notizen wie NOTES.md nicht: Nach ihrem Speichern wird nicht gebaut.
 */
export function affectsBuild(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  return /\.py$/i.test(p) || /^inputs\//i.test(p);
}
