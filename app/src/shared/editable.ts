// Regeln für Dateien, die Renderer und Hauptprozess gleich anwenden müssen: welche der Editor nur zeigt (der Renderer
// sperrt das Bearbeiten, der Hauptprozess lehnt das Schreiben ab) und welche das Modell betreffen (nur dann wird gebaut).

/** Grund, warum eine Datei (Pfad relativ zum Projekt) nur lesbar ist, sonst null. */
export function readOnlyReason(rel: string): string | null {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^(AGENTS|CLAUDE)\.md$/i.test(p)) return 'Wird von der App verwaltet und bei Updates ersetzt. Eigene Wünsche und Regeln gehören in NOTES.md.';
  if (/^\.gitignore$/i.test(p)) return 'Wird von der App verwaltet.';
  if (/^(output|exports)\//i.test(p)) return 'Wird beim Bauen oder Exportieren neu erzeugt.';
  if (/^\.soma\/skills\//i.test(p)) return 'Kopie eines Skills. Ein- und ausschalten links unter „Skills“.';
  if (/^\.(soma|git)(\/|$)/i.test(p)) return 'Interne Daten der App und von Git.';
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
