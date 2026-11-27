// "Sign in with ChatGPT" and "with GitHub Copilot" for SOMA AI (app/src/main/somaaiauth.ts) with pi's SDK:
// ModelRuntime.login, the same call as `pi auth login`. pi's command needs a terminal, and the Electron of the app has
// none (a Windows GUI program), so SOMA runs this over pipes with ELECTRON_RUN_AS_NODE=1 and PI_CODING_AGENT_DIR set.
// Arguments: pi's bundle (index.js), auth.json, provider, device id. Lines on stdout are JSON: {url}, {url, code}
// (device flow: the code to type on that page), {info}, {ok}, {error}. Closing stdin cancels. SOMA introduces itself
// as "SOMA AI" (OpenAI shows the name when asking for consent).
import { pathToFileURL } from 'node:url';

const [, , piIndex, authPath, provider, deviceId] = process.argv;
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const cancel = new AbortController();
process.stdin.on('end', () => cancel.abort());
process.stdin.on('error', () => cancel.abort());
process.stdin.resume();

/**
 * A question pi asks on the command line. Choices: the first (ChatGPT: the browser login). Text: GitHub Copilot asks for
 * a GitHub Enterprise domain, blank means github.com, the only one SOMA offers. Pasting the address by hand: the browser
 * callback answers it instead.
 */
const waitForCallback = (signal) => new Promise((_, reject) => {
  for (const s of [signal, cancel.signal].filter(Boolean)) s.addEventListener('abort', () => reject(new Error('Login cancelled')), { once: true });
});

try {
  const { ModelRuntime } = await import(pathToFileURL(piIndex).href);
  const runtime = await ModelRuntime.create({ authPath, refreshOnCreate: false });
  await runtime.login(provider, 'oauth', {
    signal: cancel.signal,
    prompt: (p) => (p.type === 'select' ? Promise.resolve(p.options[0].id) : p.type === 'text' ? Promise.resolve('') : waitForCallback(p.signal)),
    notify: (e) => {
      if (e.type === 'auth_url') say({ url: e.url });
      else if (e.type === 'device_code') say({ url: e.verificationUri, code: e.userCode });
      else if (e.message) say({ info: e.message });
    },
  }, { getDeviceId: () => deviceId, agentName: 'SOMA AI' });
  say({ ok: true });
  process.exit(0);
} catch (e) {
  say({ error: cancel.signal.aborted ? 'cancelled' : e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
