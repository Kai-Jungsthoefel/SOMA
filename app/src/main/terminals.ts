import path from 'node:path';
import type { WebContents } from 'electron';
import * as pty from 'node-pty';
import { bridgeEnv } from './bridge';
import { envPaths } from './packages';
import { gitCmdDir, pythonBinDir } from './paths';

/**
 * Umgebung fuer Terminals: vorn im PATH die Projektumgebung (E67, `python` sieht Basis und Zusatzpakete), dahinter die
 * Basisumgebung (`pip`, `soma`). PIP_PYTHON leitet jedes pip in die Projektumgebung, die Basis bleibt unverändert. Dazu
 * Adresse und Schluessel der App fuer `soma render` (E58).
 */
export function terminalEnv(projectDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', SOMA_PROJECT: projectDir, ...bridgeEnv() };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const pe = envPaths(projectDir);
  const front: string[] = [pe.scripts];
  env.VIRTUAL_ENV = pe.env;
  env.PIP_PYTHON = pe.python;
  const bin = pythonBinDir();
  if (bin) front.push(bin);
  const git = gitCmdDir(); // das mitgelieferte Git hat Vorrang vor einem Git des Systems
  if (git) front.push(git);
  env[key] = [...front, env[key] ?? ''].join(path.delimiter);
  return env;
}

/**
 * Nummern der Terminals, fortlaufend über alle Projekte. Beim Modellwechsel endet die alte Shell erst nach dem Wechsel,
 * ihre Daten und ihr „beendet“ kommen dann noch an. Finge jedes Projekt wieder bei 1 an, landeten sie beim neuen Terminal
 * mit derselben Nummer: Es galt als beendet, und Auswahl oder Markierung ließen sich nicht mehr einfügen.
 */
let nextId = 1;

/** Verwaltet die Terminals eines Projekts. Jedes ist eine normale Shell im Projektordner (E19). */
export class TerminalManager {
  private terms = new Map<number, pty.IPty>();

  constructor(private readonly wc: WebContents, private readonly dir: string) {}

  create(opts: { command?: string } = {}): number {
    const win = process.platform === 'win32';
    const shell = win ? 'powershell.exe' : (process.env.SHELL || 'bash');
    const p = pty.spawn(shell, win ? ['-NoLogo'] : [], {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: this.dir, env: terminalEnv(this.dir) as Record<string, string>,
    });
    const id = nextId++;
    this.terms.set(id, p);
    p.onData((d) => { if (!this.wc.isDestroyed()) this.wc.send('term:data', id, d); });
    p.onExit(({ exitCode }) => {
      this.terms.delete(id);
      if (!this.wc.isDestroyed()) this.wc.send('term:exit', id, exitCode);
    });
    // Ein Startbefehl (z. B. der Agent) wird sichtbar in die Shell getippt. Endet er, bleibt die Shell offen.
    if (opts.command) setTimeout(() => p.write(opts.command + '\r'), 400);
    return id;
  }

  write(id: number, data: string): void { this.terms.get(id)?.write(data); }
  resize(id: number, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) { try { this.terms.get(id)?.resize(cols, rows); } catch { /* Terminal schon beendet */ } }
  }
  kill(id: number): void { try { this.terms.get(id)?.kill(); } catch { /* schon beendet */ } this.terms.delete(id); }
  killAll(): void { for (const id of [...this.terms.keys()]) this.kill(id); }
}
