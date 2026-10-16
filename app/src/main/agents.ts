import { execFile } from 'node:child_process';
import type { AgentInfo } from '../shared/types';

/** Bekannte Kommandozeilen-Agenten. Die App installiert nichts, sie erkennt nur (E4). Weitere Agenten laufen im freien Terminal. */
const KNOWN = [
  { id: 'claude', label: 'Claude Code', command: 'claude' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini' },
];

const finder = process.platform === 'win32' ? 'where' : 'which';

/** Asynchron, damit der Hauptprozess nicht blockiert (`where` durchsucht den ganzen PATH). */
const isOnPath = (command: string, env: NodeJS.ProcessEnv) =>
  new Promise<boolean>((resolve) => {
    execFile(finder, [command], { env, windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
  });

export async function detectAgents(env: NodeJS.ProcessEnv): Promise<AgentInfo[]> {
  return Promise.all(KNOWN.map(async (a) => ({ ...a, found: await isOnPath(a.command, env) })));
}

/** Bekannter Agent zu einer Befehlszeile (erstes Wort, ohne Pfad und .cmd/.exe), sonst undefined. */
export function agentFor(line: string): (typeof KNOWN)[number] | undefined {
  const first = line.trim().split(/\s+/)[0] ?? '';
  const name = first.replace(/^.*[\\/]/, '').replace(/\.(cmd|exe|ps1|bat)$/i, '').toLowerCase();
  return KNOWN.find((a) => a.command === name);
}

/** Je Sitzung nur einmal nach der Version fragen: Ein Agent startet in einer Sitzung oft mehrmals. */
const versionAsked = new Set<string>();

/**
 * Für das Protokoll (log.ts): welcher Agent gestartet wurde, und einmal je Sitzung seine Version. Bei Problemen mit einem
 * Agenten hängt viel an seiner Version. `how`: per Knopf oder im Terminal getippt. Nur Name und Version, nie die
 * Befehlszeile (sie kann Schlüssel oder Text des Nutzers enthalten).
 */
export function logAgentStart(line: string, how: 'button' | 'typed', env: NodeJS.ProcessEnv): void {
  const a = agentFor(line);
  if (!a) return;
  console.log(`[agent] ${a.label} started (${how === 'button' ? 'start button' : 'typed in a terminal'})`);
  if (versionAsked.has(a.id) || process.env.SOMA_TEST === '1') return;
  versionAsked.add(a.id);
  // Unter Windows sind die Agenten meist .cmd-Dateien von npm, die gehen nur über die Shell. Der Befehl ist fest (KNOWN).
  execFile(a.command, ['--version'], { env, windowsHide: true, timeout: 15000, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
    const v = (stdout || stderr || '').trim().split(/\r?\n/)[0]?.slice(0, 200);
    console.log(`[agent] ${a.label} version: ${err && !v ? `unknown (${err.message.split('\n')[0]})` : v || 'unknown'}`);
  });
}
