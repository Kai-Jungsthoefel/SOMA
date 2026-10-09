// Kennung eines eigenen Skills aus seinem Namen (E78). Hauptprozess und Einstellungen rechnen gleich: Die Oberfläche
// zeigt vorab den Dateinamen, der Hauptprozess vergibt ihn.

/**
 * Kleinbuchstaben, Ziffern und Bindestriche, höchstens 36 Zeichen (die Kennung landet als Dateiname in jedem Modell und
 * in AGENTS.md). Umlaute werden umschrieben, Akzente fallen weg, alles Übrige wird zum Bindestrich.
 */
export function skillIdFrom(title: string): string {
  const s = title.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 36).replace(/-+$/, '');
  return s || 'skill';
}

/** Erste freie Kennung: `base`, sonst `base-2`, `base-3` … */
export function uniqueSkillId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
