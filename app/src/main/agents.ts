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
