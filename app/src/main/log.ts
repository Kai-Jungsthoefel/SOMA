import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

/**
 * Protokoll der App in den App-Daten (`logs/soma.log`), damit sich Probleme bei Nutzern nachvollziehen lassen. Die
 * installierte App hat keine Konsole: Was über console.* lief, war bisher verloren. initLog() leitet console.log/warn/error
 * zusätzlich in die Datei, die bestehenden Meldungen landen so ohne Umbau darin. Nichts wird hochgeladen, der Nutzer gibt
 * die Datei selbst weiter (sie enthält Pfade, also den Benutzernamen).
 *
 * Rotation beim Start und während des Laufs: über MAX_BYTES wird soma.log zu soma.1.log (bis KEEP alte Dateien).
 * Schreiben ist synchron (wenige Zeilen, und nach einem Absturz soll das Letzte drinstehen). Scheitert es, bleibt nur die
 * Konsole: Das Protokoll darf die App nie stören.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP = 3;
/** Längere Meldungen (stderr eines Builds, Tracebacks) werden gekürzt, das Ende bleibt (dort steht meist der Grund). */
const MAX_LINE = 4000;

let file: string | null = null;
let size = 0;

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export const logFile = (): string | null => file;

function rotate(): void {
  if (!file) return;
  try {
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = file.replace(/\.log$/, `.${i}.log`);
      if (fs.existsSync(from)) fs.renameSync(from, file.replace(/\.log$/, `.${i + 1}.log`));
    }
    if (fs.existsSync(file)) fs.renameSync(file, file.replace(/\.log$/, '.1.log'));
    size = 0;
  } catch { /* Datei gesperrt (zweite Instanz): weiter anhängen */ }
}

function write(level: LogLevel, text: string): void {
  if (!file) return;
  let t = text.replace(/\r\n?/g, '\n').trimEnd();
  if (t.length > MAX_LINE) t = `… ${t.slice(-MAX_LINE)}`;
  // Folgezeilen eingerückt: Ein Eintrag bleibt als Block erkennbar
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${t.replace(/\n/g, '\n    ')}\n`;
  try {
    if (size + line.length > MAX_BYTES) rotate();
    fs.appendFileSync(file, line, 'utf8');
    size += Buffer.byteLength(line);
  } catch { /* Platte voll, Ordner weg: nur Konsole */ }
}

/** Ein Eintrag ins Protokoll, ohne Ausgabe auf der Konsole. */
export function log(level: LogLevel, ...args: unknown[]): void {
  write(level, util.format(...args));
}

/**
 * Protokoll einrichten und console.* anzapfen. Einmal beim Start, sobald die App-Daten feststehen. `header`: Zeilen für
 * den Beginn der Sitzung (Version, System …).
 */
export function initLog(dir: string, header: Record<string, string | null | undefined>): void {
  if (file) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'soma.log');
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size > MAX_BYTES) rotate();
  } catch { file = null; return; }

  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => { orig.log(...a); write('INFO', util.format(...a)); };
  console.warn = (...a: unknown[]) => { orig.warn(...a); write('WARN', util.format(...a)); };
  console.error = (...a: unknown[]) => { orig.error(...a); write('ERROR', util.format(...a)); };

  // Nur mitschreiben: uncaughtExceptionMonitor ändert nichts am Verhalten von Electron (Fehlerdialog)
  process.on('uncaughtExceptionMonitor', (e) => write('ERROR', `[main] Uncaught exception: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
  process.on('unhandledRejection', (e) => write('ERROR', `[main] Unhandled promise rejection: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));

  write('INFO', `---- SOMA started (pid ${process.pid}) ----\n${Object.entries(header).map(([k, v]) => `${k}: ${v ?? '–'}`).join('\n')}`);
}

/** Systemname für den Kopf, ohne Electron (auch in reinen Node-Tests nutzbar). */
export const osText = (): string => `${os.type()} ${os.release()} (${process.arch})`;

/** Die letzten `n` Zeilen des Protokolls, für „Copy system info“. Leer, wenn es keins gibt. */
export function logTail(n: number): string {
  if (!file) return '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = fs.fstatSync(fd).size;
      const take = Math.min(len, 64 * 1024);
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, len - take);
      const lines = buf.toString('utf8').split('\n');
      if (take < len) lines.shift(); // angeschnittene erste Zeile
      return lines.filter((l, i) => l || i < lines.length - 1).slice(-n).join('\n');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}
