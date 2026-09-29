import path from 'node:path';
import type { WebContents } from 'electron';
import * as pty from 'node-pty';
import { pythonBinDir } from './paths';

/** Umgebung fuer Terminals: Python-Basisumgebung vorn im PATH, damit `python`, `pip` und `cadide` gefunden werden. */
export function terminalEnv(projectDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', CADIDE_PROJECT: projectDir };
  const bin = pythonBinDir();
  if (bin) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[key] = bin + path.delimiter + (env[key] ?? '');
    env.VIRTUAL_ENV = path.dirname(bin);
  }
  return env;
}

/** Verwaltet die Terminals eines Projekts. Jedes ist eine normale Shell im Projektordner (E19). */
export class TerminalManager {
  private terms = new Map<number, pty.IPty>();
  private next = 1;

  constructor(private readonly wc: WebContents, private readonly dir: string) {}

  create(opts: { command?: string } = {}): number {
    const win = process.platform === 'win32';
    const shell = win ? 'powershell.exe' : (process.env.SHELL || 'bash');
    const p = pty.spawn(shell, win ? ['-NoLogo'] : [], {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: this.dir, env: terminalEnv(this.dir) as Record<string, string>,
    });
    const id = this.next++;
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
