import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { accountProvider, AI_ACCOUNT_PROVIDERS, AI_KEY_PROVIDERS, isEffort, RECOMMENDED_MODEL, type AiAccount, type Effort, type AiModel, type AiSession } from '../shared/somaai';
import type { AiSignInPage, AiSignInResult } from '../shared/types';
import { aiDir, piIndex, piProcessEnv, readJson, writeJson } from './somaai';

/*
 * Sign-in of SOMA AI. pi keeps it in auth.json of its own folder (aiDir()), SOMA reads and writes that file only here
 * and never passes a key or token on to the window: the chat sees which providers are signed in and how, nothing more.
 * - API key: written into auth.json in pi's format ({ type: 'api_key', key }), as pi's own `/login` does.
 * - ChatGPT: pi's own login (ModelRuntime.login, as `pi auth login openai`) in resources/somaai/signin.mjs. pi names
 *   the sign-in page, SOMA opens it in the browser and waits until pi has the token from its callback on 127.0.0.1.
 * - GitHub Copilot: the same with `github-copilot`, GitHub's device flow: pi names the page and a code, the user types
 *   the code there, pi polls GitHub until it is confirmed.
 */

const authFile = () => path.join(aiDir(), 'auth.json');
const settingsFile = () => path.join(aiDir(), 'settings.json');
const KNOWN = new Set([...AI_ACCOUNT_PROVIDERS.map((p) => p.id), ...AI_KEY_PROVIDERS.map((p) => p.id)]);
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
 * "Sign in with ChatGPT" or "with GitHub Copilot" through resources/somaai/signin.mjs (pi's SDK over pipes, see there).
 * `onPage` gets the sign-in page (and for Copilot the code to type there) as soon as pi names it, the caller opens it
 * (not in tests). Ends when pi has saved the token, failed, or the user cancels.
 */
export function signIn(provider: unknown, onPage: (page: AiSignInPage) => void): Promise<AiSignInResult> {
  const p = typeof provider === 'string' ? accountProvider(provider) : undefined;
  if (!p) return Promise.resolve({ ok: false, error: 'Unknown provider.' });
  if (signing) return Promise.resolve({ ok: false, error: 'A sign-in is already running.' });
  const index = piIndex();
  const helper = path.join(app.getAppPath(), 'resources', 'somaai', 'signin.mjs');
  if (!index || !fs.existsSync(helper)) return Promise.resolve({ ok: false, error: 'SOMA AI is missing from this installation. Please reinstall SOMA.' });
  let id: string;
  try { fs.mkdirSync(aiDir(), { recursive: true }); id = deviceId(); }
  catch (e) { return Promise.resolve({ ok: false, error: `SOMA AI could not write its settings: ${e instanceof Error ? e.message : String(e)}` }); }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, index, authFile(), p.id, id], {
      cwd: aiDir(), env: piProcessEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const me = { child, cancelled: false };
    signing = me;
    console.log(`[somaai] sign-in with ${p.label} started`);
    const timer = setTimeout(() => cancelSignIn(), SIGN_IN_MS);
    let error = '';
    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m: { url?: unknown; code?: unknown; error?: unknown };
        try { m = JSON.parse(line) as typeof m; } catch { continue; }
        // Only web addresses go to the browser, only a short code of letters and digits to the window
        const code = typeof m.code === 'string' && /^[A-Z0-9-]{4,24}$/i.test(m.code) ? m.code : undefined;
        if (typeof m.url === 'string' && /^https:\/\//.test(m.url)) onPage({ url: m.url, code });
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
      if (code === 0 && aiAccounts().some((a) => a.provider === p.id && a.type === 'oauth')) {
        try { useProvider(p.id); } catch { /* the model choice stays pi's */ }
        console.log(`[somaai] signed in with ${p.label}`);
        resolve({ ok: true });
      } else if (me.cancelled || error === 'cancelled') resolve({ ok: false, cancelled: true });
      else {
        const why = (error || stderr.trim().split(/\r?\n/).slice(-2).join(' ') || 'Signing in did not work.').slice(0, 400);
        console.log(`[somaai] sign-in with ${p.label} failed (code ${code}): ${why}`);
        resolve({ ok: false, error: why });
      }
    };
    child.once('error', (e) => { error = e.message; done(null); });
    child.once('exit', (code) => done(code));
  });
}

/**
 * A list from pi's SDK through resources/somaai/lists.mjs (see there): there without a model open and without pi
 * running. The JSON line it printed, or an error.
 */
function piList(args: string[], what: string): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const index = piIndex();
  const helper = path.join(app.getAppPath(), 'resources', 'somaai', 'lists.mjs');
  if (!index || !fs.existsSync(helper)) return Promise.resolve({ ok: false, error: 'SOMA AI is missing from this installation. Please reinstall SOMA.' });
  try { fs.mkdirSync(aiDir(), { recursive: true }); } catch { /* the helper reports it */ }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, index, ...args], { cwd: aiDir(), env: { ...piProcessEnv(), PI_OFFLINE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { out = (out + d).slice(-8_000_000); });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => child.kill(), 30_000);
    let settled = false;
    const done = (r: { ok: true; data: Record<string, unknown> } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!r.ok) console.log(`[somaai] list of ${what} failed: ${r.error}`);
      resolve(r);
    };
    child.once('error', (e) => done({ ok: false, error: e.message }));
    child.once('exit', () => {
      let m: Record<string, unknown> = {};
      try { m = JSON.parse(out.trim().split('\n').at(-1) ?? '') as Record<string, unknown>; } catch { /* below */ }
      if (typeof m.error === 'string' || !Object.keys(m).length) {
        done({ ok: false, error: (typeof m.error === 'string' ? m.error : err.trim().split(/\r?\n/).at(-1) || `The ${what} could not be listed.`).slice(0, 400) });
      } else done({ ok: true, data: m });
    });
  });
}

/**
 * The models of the saved sign-ins, for Settings > SOMA AI and the chat's model menu. With the newest catalog from pi.dev
 * for the signed-in providers (wish of the user 2026-11-22, a tester missed GPT-6.2 Sol): new models show up without a
 * new SOMA, the chat's pi reads the saved catalog even offline. Without network the list is pi's own catalog.
 */
export async function listModels(): Promise<{ ok: boolean; models?: AiModel[]; error?: string }> {
  const r = await piList(['models', 'online'], 'models');
  if (!r.ok) return r;
  // Only what can be shown and chosen: the list comes from another process
  const models = (Array.isArray(r.data.models) ? r.data.models : []).flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return typeof o.provider === 'string' && typeof o.id === 'string' ? [{ provider: o.provider, id: o.id, name: typeof o.name === 'string' && o.name ? o.name : o.id }] : [];
  });
  return { ok: true, models };
}

/** The conversations of a model folder with SOMA AI, newest first, with the file pi keeps each one in. */
export async function listSessions(dir: string): Promise<{ ok: boolean; sessions?: (AiSession & { path: string })[]; error?: string }> {
  const r = await piList(['sessions', dir], 'conversations');
  if (!r.ok) return r;
  const sessions = (Array.isArray(r.data.sessions) ? r.data.sessions : []).flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return typeof o.id === 'string' && typeof o.path === 'string'
      ? [{ id: o.id, path: o.path, title: typeof o.title === 'string' ? o.title : '', modified: typeof o.modified === 'number' ? o.modified : 0, messages: typeof o.messages === 'number' ? o.messages : 0 }]
      : [];
  });
  return { ok: true, sessions };
}

/** The model pi starts with (settings.json), null when pi chooses. */
export function defaultModel(): { provider: string; id: string } | null {
  let s: Record<string, unknown>;
  try { s = readJson(settingsFile()); } catch { return null; }
  return typeof s.defaultProvider === 'string' && typeof s.defaultModel === 'string' ? { provider: s.defaultProvider, id: s.defaultModel } : null;
}

/** Settings > SOMA AI: the model pi starts with. Only a model of a saved sign-in (as the list shows them). */
export async function setDefaultModel(provider: unknown, id: unknown): Promise<{ ok: boolean; error?: string }> {
  if (typeof provider !== 'string' || typeof id !== 'string') return { ok: false, error: 'Unknown model.' };
  const list = await listModels();
  if (!list.ok) return { ok: false, error: list.error };
  if (!list.models?.some((m) => m.provider === provider && m.id === id)) return { ok: false, error: 'This model is not available with your sign-ins.' };
  try {
    const s = readJson(settingsFile());
    s.defaultProvider = provider;
    s.defaultModel = id;
    writeJson(settingsFile(), s);
  } catch (e) { return { ok: false, error: `The model could not be saved: ${e instanceof Error ? e.message : String(e)}` }; }
  console.log(`[somaai] model for new conversations: ${provider}/${id}`);
  return { ok: true };
}

/** The effort pi starts new conversations with (settings.json), null when pi's own default applies. */
export function defaultEffort(): Effort | null {
  let s: Record<string, unknown>;
  try { s = readJson(settingsFile()); } catch { return null; }
  return isEffort(s.defaultThinkingLevel) ? s.defaultThinkingLevel : null;
}

/** Settings > SOMA AI and the chat: the effort for new conversations. pi clamps it to what the model supports. */
export function setDefaultEffort(level: unknown): { ok: boolean; error?: string } {
  if (!isEffort(level)) return { ok: false, error: 'Unknown effort.' };
  try {
    const s = readJson(settingsFile());
    s.defaultThinkingLevel = level;
    writeJson(settingsFile(), s);
  } catch (e) { return { ok: false, error: `The effort could not be saved: ${e instanceof Error ? e.message : String(e)}` }; }
  console.log(`[somaai] effort for new conversations: ${level}`);
  return { ok: true };
}

/** Closing stdin cancels pi's login. The callback server on 127.0.0.1 goes with the process. */
export function cancelSignIn(): void {
  if (!signing) return;
  signing.cancelled = true;
  const c = signing.child;
  try { c.stdin?.end(); } catch { /* already ended */ }
  setTimeout(() => { if (c.exitCode === null) c.kill(); }, 2000).unref();
}
