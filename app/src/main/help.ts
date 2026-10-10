import fs from 'node:fs';
import path from 'node:path';
import { HELP_DIR, HELP_IMAGE, HELP_SKILL } from '../shared/help';
import { readSkillFile, SKILLS_DIR } from './skills';

/**
 * Anleitung (E83) im Hauptprozess: Text für das Hilfe-Fenster, Bilder dazu und die Kopie der Bilder ins Projekt. Der Text ist
 * der mitgelieferte Skill (`<skillsDir>/soma-app.md`), nicht eine bearbeitete Fassung aus der Bibliothek: Die Hilfe beschreibt
 * die App, wie sie ist. Die Bilder liegen in `<helpDir>/`.
 */

/** Text der Anleitung, null wenn die Datei fehlt oder zu groß ist. */
export const readHelp = (skillsDir: string): string | null => readSkillFile(path.join(skillsDir, `${HELP_SKILL}.md`));

/** Ein Bild der Anleitung. Nur Namen nach HELP_IMAGE, also nichts außerhalb des Ordners. */
export function readHelpImage(helpDir: string, name: unknown): Buffer | null {
  if (typeof name !== 'string' || !HELP_IMAGE.test(name)) return null;
  try { return fs.readFileSync(path.join(helpDir, name)); } catch { return null; }
}

const sameFile = (a: string, b: string): boolean => {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
};

/**
 * Bilder der Anleitung nach `.soma/help/` im Projekt, sofern der Skill dort liegt (Stufe Bei Bedarf oder Immer): Der Agent
 * öffnet sie über die Pfade im Skill. Der Ordner gehört der App, steht nicht im Verlauf und nicht in der Modelldatei
 * (wie `.soma/drawings/`), deshalb ersetzt die App dort abweichende Bilder ohne Sicherung. Fremde Dateien bleiben liegen.
 * Fehler werden nur protokolliert: Ohne Bilder bleibt der Text brauchbar.
 */
export function syncHelpImages(root: string, helpDir: string): void {
  if (!fs.existsSync(path.join(root, SKILLS_DIR, `${HELP_SKILL}.md`))) return;
  try {
    const names = fs.readdirSync(helpDir).filter((n) => HELP_IMAGE.test(n));
    const dest = path.join(root, HELP_DIR);
    // Ein Verweis (Symlink) an Stelle des Ordners könnte nach außen zeigen: dann nichts schreiben
    if (fs.existsSync(dest) && !fs.lstatSync(dest).isDirectory()) { console.error(`[soma] ${HELP_DIR} is not a folder, the pictures of the guide are not copied.`); return; }
    fs.mkdirSync(dest, { recursive: true });
    for (const n of names) {
      const to = path.join(dest, n);
      if (fs.existsSync(to) && fs.lstatSync(to).isSymbolicLink()) continue;
      if (!sameFile(path.join(helpDir, n), to)) fs.copyFileSync(path.join(helpDir, n), to);
    }
  } catch (e) {
    console.error('[soma] Could not copy the pictures of the guide:', e);
  }
}
