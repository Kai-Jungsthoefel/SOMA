// Versionsnummer von SOMA (E68): Major.minor.bugfix, eine für App und soma. Sie steht in package.json und gleichlautend in
// python/soma/__init__.py (test/unit.mjs prüft das). esbuild setzt sie beim Bauen ein (esbuild.config.mjs).

declare const __SOMA_VERSION__: string | undefined;

/** Ohne esbuild (etwa ein Modul im Test einzeln gebündelt) gibt es keine Nummer: 0.0.0 statt eines Absturzes. */
export const SOMA_VERSION: string = typeof __SOMA_VERSION__ === 'string' ? __SOMA_VERSION__ : '0.0.0';

/** Zerlegt „1.2.3“ in Zahlen, sonst null (etwa ein von Hand verdorbener Eintrag in project.json). */
export function parseVersion(v: unknown): [number, number, number] | null {
  const m = typeof v === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Ist `v` neuer als diese App? Unlesbare Nummern gelten nicht als neuer. */
export function isNewerVersion(v: unknown, than = SOMA_VERSION): boolean {
  const a = parseVersion(v), b = parseVersion(than);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
