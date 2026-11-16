import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AI_KEY_PROVIDERS, CHATGPT_PROVIDER, RECOMMENDED_MODEL, type AiAccount } from '../shared/somaai';
import type { AiSignInResult } from '../shared/types';
import { aiDir, piIndex, piProcessEnv, readJson, writeJson } from './somaai';

/*
 * Sign-in of SOMA AI. pi keeps it in auth.json of its own folder (aiDir()), SOMA reads and writes that file only here
 * and never passes a key or token on to the window: the chat sees which providers are signed in and how, nothing more.
 * - API key: written into auth.json in pi's format ({ type: 'api_key', key }), as pi's own `/login` does.
 * - ChatGPT: pi's own login (ModelRuntime.login, as `pi auth login openai`) in resources/somaai/signin.mjs. pi names
 *   the sign-in page, SOMA opens it in the browser and waits until pi has the token from its callback on 127.0.0.1.
 */

const authFile = () => path.join(aiDir(), 'auth.json');
const settingsFile = () => path.join(aiDir(), 'settings.json');
const KNOWN = new Set([CHATGPT_PROVIDER, ...AI_KEY_PROVIDERS.map((p) => p.id)]);
const SIGN_IN_MS = 15 * 60_000;

/** The saved sign-ins SOMA offers (others in auth.json stay as they are and are not shown). */
export function aiAccounts(): AiAccount[] {
  let data: Record<string, unknown>;
  try { data = readJson(authFile()); } catch { return []; }
  return Object.entries(data).flatMap(([provider, v]) => {
    const type = (v as { type?: unknown } | null)?.type;
    return KNOWN.has(provider) && (type === 'oauth' || type === 'api_key') ? [{ provider, type }] : [];
  });
}

/** After signing in, pi starts with the recommended model of that provider, or its own choice there. */
function useProvider(provider: string): void {
  const s = readJson(settingsFile());
  s.defaultProvider = provider;
  if (RECOMMENDED_MODEL[provider]) s.defaultModel = RECOMMENDED_MODEL[provider];
  else delete s.defaultModel;
  writeJson(settingsFile(), s);
}

export function saveApiKey(provider: unknown, key: unknown): { ok: boolean; error?: string } {
  const p = AI_KEY_PROVIDERS.find((x) => x.id === provider);
  if (!p) return { ok: false, error: 'Unknown provider.' };
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) return { ok: false, error: 'Paste the key first.' };
  if (k.length > 4000 || /\s/.test(k)) return { ok: false, error: 'This does not look like an API key: it contains spaces or line breaks.' };
  try {
    const data = readJson(authFile());
    data[p.id] = { type: 'api_key', key: k };
    writeJson(authFile(), data);
    useProvider(p.id);
  } catch (e) { return { ok: false, error: `The key could not be saved: ${e instanceof Error ? e.message : String(e)}` }; }
  console.log(`[somaai] API key saved for ${p.id}`);
  return { ok: true };
}

/** Removes a sign-in from this computer. A token stays valid at the provider until it expires (as with pi's /logout). */
export function signOut(provider: unknown): { ok: boolean; error?: string } {
  if (typeof provider !== 'string' || !KNOWN.has(provider)) return { ok: false, error: 'Unknown provider.' };
  try {
    const data = readJson(authFile());
    delete data[provider];
    writeJson(authFile(), data);
    const s = readJson(settingsFile());
    if (s.defaultProvider === provider) {
      // Another sign-in, if there is one, takes over
      const next = aiAccounts()[0]?.provider;
      if (next) { s.defaultProvider = next; if (RECOMMENDED_MODEL[next]) s.defaultModel = RECOMMENDED_MODEL[next]; else delete s.defaultModel; }
      else { delete s.defaultProvider; delete s.defaultModel; }
      writeJson(settingsFile(), s);
    }
  } catch (e) { return { ok: false, error: `Signing out did not work: ${e instanceof Error ? e.message : String(e)}` }; }
  console.log(`[somaai] signed out of ${provider}`);
  return { ok: true };
}

/** pi's device id (settings.json, as pi's own login creates it): OpenAI knows the installation by it. */
function deviceId(): string {
  const s = readJson(settingsFile());
  if (typeof s.deviceId !== 'string' || !s.deviceId) { s.deviceId = randomUUID(); writeJson(settingsFile(), s); }
  return s.deviceId as string;
}

let signing: { child: ChildProcess; cancelled: boolean } | null = null;

/**
 * "Sign in with ChatGPT" through resources/somaai/signin.mjs (pi's SDK over pipes, see there). `onUrl` gets the
 * sign-in page as soon as pi names it, the caller opens it (not in tests). Ends when pi has saved the token, failed,
 * or the user cancels.
 */
export function signInChatGPT(onUrl: (url: string) => void): Promise<AiSignInResult> {
  if (signing) return Promise.resolve({ ok: false, error: 'A sign-in is already running.' });
  const index = piIndex();
  const helper = path.join(app.getAppPath(), 'resources', 'somaai', 'signin.mjs');
  if (!index || !fs.existsSync(helper)) return Promise.resolve({ ok: false, error: 'SOMA AI is missing from this installation. Please reinstall SOMA.' });
  let id: string;
  try { fs.mkdirSync(aiDir(), { recursive: true }); id = deviceId(); }
  catch (e) { return Promise.resolve({ ok: false, error: `SOMA AI could not write its settings: ${e instanceof Error ? e.message : String(e)}` }); }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, index, authFile(), CHATGPT_PROVIDER, id], {
      cwd: aiDir(), env: piProcessEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const me = { child, cancelled: false };
    signing = me;
    console.log('[somaai] sign-in with ChatGPT started');
    const timer = setTimeout(() => cancelSignIn(), SIGN_IN_MS);
    let error = '';
    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m: { url?: unknown; error?: unknown };
        try { m = JSON.parse(line) as typeof m; } catch { continue; }
        // Only web addresses go to the browser
        if (typeof m.url === 'string' && /^https:\/\//.test(m.url)) onUrl(m.url);
        if (typeof m.error === 'string') error = m.error;
      }
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => { stderr = (stderr + d).slice(-2000); });
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signing === me) signing = null;
      if (code === 0 && aiAccounts().some((a) => a.provider === CHATGPT_PROVIDER && a.type === 'oauth')) {
        try { useProvider(CHATGPT_PROVIDER); } catch { /* the model choice stays pi's */ }
        console.log('[somaai] signed in with ChatGPT');
        resolve({ ok: true });
      } else if (me.cancelled || error === 'cancelled') resolve({ ok: false, cancelled: true });
      else {
        const why = (error || stderr.trim().split(/\r?\n/).slice(-2).join(' ') || 'Signing in did not work.').slice(0, 400);
        console.log(`[somaai] sign-in with ChatGPT failed (code ${code}): ${why}`);
        resolve({ ok: false, error: why });
      }
    };
    child.once('error', (e) => { error = e.message; done(null); });
    child.once('exit', (code) => done(code));
  });
}

/** Closing stdin cancels pi's login. The callback server on 127.0.0.1 goes with the process. */
export function cancelSignIn(): void {
  if (!signing) return;
  signing.cancelled = true;
  const c = signing.child;
  try { c.stdin?.end(); } catch { /* already ended */ }
  setTimeout(() => { if (c.exitCode === null) c.kill(); }, 2000).unref();
}
