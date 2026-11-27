import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AiSignInResult, CopilotAccountStatus } from '../shared/types';
import { COPILOT_PROVIDER, type AiModel } from '../shared/somaai';
import { authorizeCopilotDevice } from './copilotdevice';
import { aiDir } from './paths';

const credentialPath = () => path.join(aiDir(), 'copilot-credential.json');
declare const __SOMA_COPILOT_CLIENT_ID__: string | undefined;
const clientId = () => process.env.SOMA_COPILOT_CLIENT_ID?.trim()
  ?? (typeof __SOMA_COPILOT_CLIENT_ID__ === 'string' ? __SOMA_COPILOT_CLIENT_ID__ : '');
const configured = () => /^[A-Za-z0-9.]{1,100}$/.test(clientId());
let attempt: AbortController | undefined;

function canEncrypt(): boolean {
  return safeStorage.isEncryptionAvailable()
    && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
}

function readCredential(): { encryptedToken: string; models: AiModel[] } | null {
  if (!configured()) return null;
  if (!canEncrypt()) throw new Error('System credential storage is unavailable. Unlock or set up your system keyring and restart SOMA.');
  const file = credentialPath();
  if (!fs.existsSync(file)) return null;
  let state: Record<string, unknown> | null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('The saved GitHub Copilot sign-in could not be read. Sign in again.'); }
  if (!state || typeof state.encryptedToken !== 'string' || typeof state.expiresAt !== 'number' || !Array.isArray(state.models)) {
    throw new Error('The saved GitHub Copilot sign-in needs to be renewed. Sign in again.');
  }
  if (state.clientId !== clientId() || state.expiresAt <= Date.now()) {
    throw new Error('The GitHub Copilot sign-in has expired or belongs to a different app. Sign in again.');
  }
  return { encryptedToken: state.encryptedToken, models: state.models.flatMap((m: unknown) => {
    if (!m || typeof m !== 'object' || !('id' in m) || typeof m.id !== 'string' || !('name' in m) || typeof m.name !== 'string') return [];
    return [{ provider: COPILOT_PROVIDER, id: m.id, name: m.name }];
  }) };
}

export function copilotAccountStatus(): CopilotAccountStatus {
  if (!configured()) return { available: false };
  try { return { available: true, modelCount: readCredential()?.models.length }; }
  catch (e) { return { available: true, error: e instanceof Error ? e.message : 'GitHub Copilot sign-in could not be read.' }; }
}

export function copilotModels(): AiModel[] {
  try { return readCredential()?.models ?? []; }
  catch { return []; /* Settings shows the saved sign-in error. */ }
}

export async function openCopilotClient(token: string) {
  const { CopilotClient } = await import('@microsoft/copilot-sdk');
  const baseDirectory = path.join(aiDir(), 'copilot-runtime');
  fs.mkdirSync(baseDirectory, { recursive: true });
  return new CopilotClient({ mode: 'empty', github: { token, useLoggedInUser: false }, runtime: { kind: 'inprocess', baseDirectory } });
}

export async function openSignedInCopilotClient() {
  const credential = readCredential();
  if (!credential) throw new Error('Sign in with GitHub Copilot in Settings first.');
  return openCopilotClient(safeStorage.decryptString(Buffer.from(credential.encryptedToken, 'base64')));
}

async function checkModels(token: string, signal: AbortSignal): Promise<AiModel[]> {
  let client;
  try {
    signal.throwIfAborted();
    client = await openCopilotClient(token);
    await client.start();
    const models = await client.listModels();
    signal.throwIfAborted();
    return models.map((m) => ({ provider: COPILOT_PROVIDER, id: m.id, name: m.name || m.id }));
  } catch {
    signal.throwIfAborted();
    throw new Error('Copilot could not list your models. Check your Copilot subscription and any organization restrictions, then try again.');
  } finally {
    if (client) {
      try { await client.stop(); }
      catch { console.error('[somaai] Could not stop the Copilot SDK after checking model access.'); }
    }
  }
}

export async function signInCopilot(onCode: (code: string) => void): Promise<AiSignInResult> {
  if (!configured()) return { ok: false, error: 'GitHub Copilot is not configured for this build.' };
  if (!canEncrypt()) return { ok: false, error: 'System credential storage is unavailable.' };
  if (attempt) return { ok: false, error: 'A GitHub Copilot sign-in is already running.' };
  const controller = new AbortController();
  attempt = controller;
  const id = clientId();
  try {
    const { token, expiresAt } = await authorizeCopilotDevice(id, { signal: controller.signal, onCode });
    const models = await checkModels(token, controller.signal);
    if (!models.length) return { ok: false, error: 'GitHub Copilot did not make any models available to this account.' };
    const file = credentialPath();
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify({ clientId: id, expiresAt, models, encryptedToken: safeStorage.encryptString(token).toString('base64') }), {
        flag: 'wx', mode: 0o600,
      });
      fs.renameSync(temp, file);
    } catch {
      try { fs.rmSync(temp, { force: true }); }
      catch { console.error('[somaai] Could not remove an incomplete encrypted Copilot sign-in.'); }
      return { ok: false, error: 'SOMA could not save the encrypted GitHub Copilot sign-in.' };
    }
    return { ok: true };
  } catch (e) {
    if (controller.signal.aborted) return { ok: false, cancelled: true };
    return { ok: false, error: e instanceof Error ? e.message : 'GitHub Copilot sign-in failed.' };
  } finally {
    attempt = undefined;
  }
}

export function cancelCopilotSignIn(): void { attempt?.abort(); }

export function signOutCopilot(): AiSignInResult {
  cancelCopilotSignIn();
  try {
    fs.rmSync(credentialPath(), { force: true });
    return { ok: true };
  } catch {
    return { ok: false, error: 'SOMA could not remove the saved GitHub Copilot sign-in.' };
  }
}
