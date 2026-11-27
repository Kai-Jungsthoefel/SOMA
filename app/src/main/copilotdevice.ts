import { setTimeout as sleep } from 'node:timers/promises';

export const COPILOT_DEVICE_URL = 'https://github.com/login/device';

type DeviceOptions = {
  signal: AbortSignal;
  onCode(code: string): void;
  request?: typeof fetch;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export async function authorizeCopilotDevice(clientId: string, {
  signal, onCode, request = fetch, pause = (ms, abort) => sleep(ms, undefined, { signal: abort }),
}: DeviceOptions): Promise<{ token: string; expiresAt: number }> {
  async function post(path: string, fields: Record<string, string>, lifetime: AbortSignal) {
    let response: Response;
    try {
      response = await request(`https://github.com${path}`, {
        method: 'POST', headers: { Accept: 'application/json' },
        body: new URLSearchParams({ client_id: clientId, ...fields }),
        redirect: 'error', signal: AbortSignal.any([lifetime, AbortSignal.timeout(15_000)]),
      });
    } catch {
      lifetime.throwIfAborted();
      throw new Error('Could not reach GitHub. Check your connection and try signing in again.');
    }
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}. Try signing in again.`);
    try {
      const data: unknown = await response.json();
      if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
    } catch { lifetime.throwIfAborted(); }
    throw new Error('GitHub returned an invalid sign-in response.');
  }

  const d = await post('/login/device/code', {}, signal);
  if (d.error === 'device_flow_disabled') throw new Error('Enable Device Flow in the GitHub App settings.');
  if (d.error === 'incorrect_client_credentials') throw new Error('Check the Client ID in SOMA_COPILOT_CLIENT_ID.');
  if (typeof d.user_code !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(d.user_code)
      || typeof d.device_code !== 'string' || d.device_code.length !== 40 || d.verification_uri !== COPILOT_DEVICE_URL
      || !positiveInt(d.expires_in) || d.expires_in > 900 || !positiveInt(d.interval)) {
    throw new Error('GitHub did not provide a valid device code. Check the GitHub App settings and try again.');
  }
  const expiry = AbortSignal.timeout(d.expires_in * 1000);
  const lifetime = AbortSignal.any([signal, expiry]);
  let interval = d.interval;
  signal.throwIfAborted();
  onCode(d.user_code);
  try {
    for (;;) {
      await pause(interval * 1000, lifetime);
      lifetime.throwIfAborted();
      const result = await post('/login/oauth/access_token', {
        device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }, lifetime);
      if (typeof result.access_token === 'string' && /^ghu_[A-Za-z0-9_]+$/.test(result.access_token)
          && positiveInt(result.expires_in)) {
        return { token: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
      }
      if (result.error === 'authorization_pending') continue;
      if (result.error === 'slow_down') {
        interval = Math.max(interval + 5, positiveInt(result.interval) ? result.interval : 0);
        continue;
      }
      if (result.error === 'access_denied') throw new Error('GitHub authorization was declined. Try signing in again.');
      if (result.error === 'expired_token' || result.error === 'token_expired') break;
      throw new Error('GitHub did not issue an expiring user token. Check token expiration in the GitHub App settings.');
    }
  } catch (error) {
    if (!expiry.aborted || signal.aborted) throw error;
  }
  throw new Error('The GitHub device code expired. Try signing in again.');
}
