// Test of voice input for SOMA AI (src/main/voice.ts, src/renderer/voice.ts). Part 1 with a small stand-in archive from a
// local server: the microphone button, the setup on the first click (language, size), download and unpack, removing the
// model in Settings > SOMA AI, a failing download. Part 2 with the real speech model, when it is on this computer
// (SOMA_TEST_VOICE_MODEL, default %LOCALAPPDATA%/soma-dev/voice/parakeet-tdt-0.6b-v3-int8): Chromium's fake microphone
// plays a German sentence, the text lands in the chat input and is not sent. Run: npm run test:voice (builds first).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';
import { useMockModel } from './mockllm.mjs';

const t = checker();
const { check } = t;
const MODEL_ID = 'parakeet-tdt-0.6b-v3-int8';
const FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt', 'README.md'];

// ---- Stand-in archive and server ----------------------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-voice-'));
const src = path.join(work, 'src', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8');
fs.mkdirSync(src, { recursive: true });
for (const f of FILES) fs.writeFileSync(path.join(src, f), `stand-in ${f}\n`.repeat(2000));
const archive = path.join(work, 'model.tar.bz2');
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const made = spawnSync(tar, ['-cjf', archive, '-C', path.join(work, 'src'), 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8']);
if (made.status !== 0) { console.log('FEHLER tar:', String(made.stderr)); process.exit(1); }
const body = fs.readFileSync(archive);
let serverMode = 'ok';
let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  if (serverMode !== 'ok') { res.writeHead(404); res.end('gone'); return; }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
  // In pieces with pauses, so the progress can be seen
  let at = 0;
  const step = Math.ceil(body.length / 5);
  const next = () => { if (at >= body.length) { res.end(); return; } res.write(body.subarray(at, at + step)); at += step; setTimeout(next, 300); };
  next();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/model.tar.bz2`;

/** A model chat with a key, so the chat input is there (nothing is sent to it). */
function prepareUserData(ud) {
  useMockModel(ud, 9);
  fs.writeFileSync(path.join(ud, 'somaai', 'auth.json'), JSON.stringify({ anthropic: { type: 'api_key', key: 'test' } }));
}

async function openChat(app) {
  const { ev } = app;
  await app.waitFor('model open', () => !!window.__t && !!window.__t.project(), 90000);
  await ev(() => window.__t.showChat(true));
  await app.waitFor('note', () => ['note', 'chat'].includes(window.__t.chat().phase), 20000);
  await ev(() => [...document.querySelectorAll('.ai-pane button')].find((b) => b.textContent.trim() === 'Got it')?.click());
  await app.waitFor('chat', () => window.__t.chat().phase === 'chat', 30000);
}

const shot = async (app, name) => {
  if (!process.env.SMOKE_SHOTS) return;
  fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
  await sleep(500);
  await app.screenshot(path.join(APP, 'test', 'shots', `voice-${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
};

// ---- Part 1: set up, download, remove -----------------------------------------------------------------------------
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-voice-ud-'));
prepareUserData(ud);
let app = await startApp({ name: 'voice', userData: ud, env: { SOMA_VOICE_URL: url, SOMA_TEST_MIC: 'tone', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
try {
  const { ev } = app;
  await openChat(app);
  let v = (await ev(() => window.__t.chat())).voice;
  check('Voice input: engine there, no model yet', v.status?.available === true && v.status?.installed === false, JSON.stringify(v.status));
  const row = await ev(() => [...document.querySelectorAll('.ai-composer .ai-row > *')].filter((e) => !e.hidden).map((e) => e.className));
  check('Microphone button next to the picture button', row.findIndex((c) => c.includes('ai-mic')) === row.findIndex((c) => c.includes('ibtn')) + 1, row.join(' | '));
  check('Its title says the first click sets it up', /sets it up/.test(v.title), v.title);

  await ev(() => document.querySelector('.ai-mic').click());
  await app.waitFor('setup dialog', () => !!document.querySelector('.vc-dlg'), 10000);
  const dlg = await ev(() => ({ text: document.querySelector('.vc-dlg').textContent, lang: document.querySelector('.vc-lang').value, n: document.querySelectorAll('.vc-lang option').length }));
  check('Setup names the model, its size and that nothing leaves the computer',
    /Parakeet TDT 0\.6B v3/.test(dlg.text) && /487 MB download/.test(dlg.text) && /nothing you say leaves it/.test(dlg.text), dlg.text.slice(0, 200));
  check('25 languages and "Another language"', dlg.n === 26, String(dlg.n));
  await shot(app, 'setup');
  await ev(() => { const s = document.querySelector('.vc-lang'); s.value = ''; s.dispatchEvent(new Event('change')); });
  const other = await ev(() => ({ note: !document.querySelector('.vc-note').hidden, dl: document.querySelector('.vc-dlg [data-act=download]').disabled }));
  check('Another language: a note, no download', other.note && other.dl, JSON.stringify(other));
  await ev(() => { const s = document.querySelector('.vc-lang'); s.value = 'de'; s.dispatchEvent(new Event('change')); });
  await ev(() => document.querySelector('.vc-dlg [data-act=download]').click());
  await app.waitFor('progress', () => !!document.querySelector('.vc-dlg [data-act=cancel]') || !document.querySelector('.vc-dlg'), 10000);
  // Progress reports must not rebuild the spinner (it would start its turn over and jerk) or the buttons (a click would get lost)
  await app.waitFor('spinner', () => !!document.querySelector('.ai-mic[data-state=download] .spin'), 5000);
  await ev(() => { window.__spin = document.querySelector('.ai-mic .spin'); window.__hide = document.querySelector('.vc-dlg [data-act=hide]'); });
  await sleep(700);
  const kept = await ev(() => ({ download: document.querySelector('.ai-mic')?.dataset.state === 'download', spin: window.__spin.isConnected, hide: window.__hide.isConnected }));
  check('During the download the spinner and the buttons stay the same elements', kept.download && kept.spin && kept.hide, JSON.stringify(kept));
  await app.waitFor('installed', () => !document.querySelector('.vc-dlg') && window.__t.chat().voice.status?.installed === true, 30000);
  const mdir = path.join(ud, 'voice', MODEL_ID);
  const files = fs.existsSync(mdir) ? fs.readdirSync(mdir).sort() : [];
  const left = fs.readdirSync(path.join(ud, 'voice')).filter((f) => f !== MODEL_ID && f !== 'voice.json');
  check('Download unpacked into voice/<model>, archive and temp folder gone', FILES.every((f) => files.includes(f)) && !left.length, `${files.join(',')} | left: ${left.join(',')}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(ud, 'voice', 'voice.json'), 'utf8'));
  check('The language is kept', cfg.language === 'de', JSON.stringify(cfg));
  const toast = await ev(() => window.__t.toast());
  check('A toast says how to use it', /Voice input is ready/.test(toast.text), toast.text);
  // After the setup the recording starts right away (fake microphone with a test tone, CI runners have no microphone): Escape drops it
  await app.waitFor('recording or idle', () => ['recording', 'idle'].includes(window.__t.chat().voice.phase), 10000);
  await ev(() => document.querySelector('.ai-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await app.waitFor('idle', () => window.__t.chat().voice.phase === 'idle', 5000);
  check('Escape drops the recording, nothing in the input', (await ev(() => window.__t.chat().input)) === '');

  // Settings > SOMA AI
  await ev(() => window.__t.settingsShow('ai'));
  await app.waitFor('voice row', () => /Voice input/.test(document.getElementById('st-ai').innerText) && !!document.querySelector('#st-ai [data-act=voice-remove]'), 15000);
  const st = await ev(() => document.getElementById('st-ai').innerText);
  check('Settings: voice input ready, set up for German', /Ready\. Parakeet/.test(st) && /set up for German/.test(st), st.slice(st.indexOf('Voice input'), st.indexOf('Voice input') + 200));
  await shot(app, 'settings');
  await ev(() => document.querySelector('#st-ai [data-act=voice-remove]').click());
  await app.waitFor('confirm', () => !!document.querySelector('.ask-dlg'), 5000);
  await ev(() => [...document.querySelectorAll('.ask-dlg button')].find((b) => b.textContent === 'Remove').click());
  await app.waitFor('removed', () => !!document.querySelector('#st-ai [data-act=voice-setup]'), 10000);
  check('Remove deletes the model after asking', !fs.existsSync(mdir));

  // A failing download: the reason is shown, nothing stays behind
  serverMode = 'missing';
  await ev(() => document.querySelector('#st-ai [data-act=voice-setup]').click());
  await app.waitFor('setup dialog', () => !!document.querySelector('.vc-dlg [data-act=download]'), 10000);
  await ev(() => document.querySelector('.vc-dlg [data-act=download]').click());
  await app.waitFor('error', () => /did not work/.test(document.querySelector('.vc-info')?.textContent ?? ''), 15000);
  const err = await ev(() => document.querySelector('.vc-info').textContent);
  check('Failed download: reason in the dialog, "Try again"', /404/.test(err) && (await ev(() => document.querySelector('.vc-dlg [data-act=download]').textContent)) === 'Try again', err);
  check('Failed download leaves nothing behind', fs.readdirSync(path.join(ud, 'voice')).every((f) => f === 'voice.json'), fs.readdirSync(path.join(ud, 'voice')).join(','));
  await ev(() => document.querySelector('.vc-dlg [data-act=close]').click());
  check('The server was asked twice', requests === 2, String(requests));
} catch (e) {
  console.log('FEHLER Exception:', e.message);
  t.fail();
} finally {
  await app.stop();
  cleanup(ud);
}

// ---- Part 1b: an engine that does not run here --------------------------------------------------------------------
const udBroken = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-voice-ud-'));
prepareUserData(udBroken);
app = await startApp({ name: 'voice-broken', userData: udBroken, env: { SOMA_VOICE_URL: url, SOMA_TEST_VOICE_BROKEN: '1', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
try {
  const { ev } = app;
  await openChat(app);
  const asked = requests;
  await ev(() => document.querySelector('.ai-mic').click());
  await app.waitFor('message', () => /cannot run on this computer/.test(window.__t.toast().text), 30000);
  const st = await ev(() => ({ toast: window.__t.toast(), dialog: !!document.querySelector('.vc-dlg'), voice: window.__t.chat().voice }));
  check('Engine does not load: the first click says so, no setup, nothing downloaded',
    st.toast.error && !st.dialog && requests === asked && st.voice.status?.available === false, `${st.toast.text} | ${requests - asked} downloads`);
  check('The microphone button names the reason', /cannot run on this computer/.test(st.voice.title), st.voice.title);
} catch (e) {
  console.log('FEHLER Exception:', e.message);
  t.fail();
} finally {
  await app.stop();
  cleanup(udBroken);
}

// ---- Part 2: recognition with the real model ----------------------------------------------------------------------
const real = process.env.SOMA_TEST_VOICE_MODEL || path.join(process.env.LOCALAPPDATA || os.homedir(), 'soma-dev', 'voice', MODEL_ID);
const wav = path.join(real, 'test_wavs', 'de.wav');
if (!fs.existsSync(path.join(real, 'encoder.int8.onnx')) || !fs.existsSync(wav)) {
  console.log(`HINWEIS Part 2 skipped: no speech model in ${real} (download it once, see app/README.md).`);
} else {
  const ud2 = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-voice-ud-'));
  prepareUserData(ud2);
  app = await startApp({ name: 'voice2', userData: ud2, env: { SOMA_VOICE_MODEL_DIR: real, SOMA_TEST_MIC: wav } });
  try {
    const { ev } = app;
    await openChat(app);
    await ev(() => { const i = document.querySelector('.ai-input'); i.value = 'Please:'; i.setSelectionRange(7, 7); });
    await ev(() => document.querySelector('.ai-mic').click());
    await app.waitFor('recording', () => window.__t.chat().voice.phase === 'recording', 15000);
    check('Click: listening, button pressed', (await ev(() => document.querySelector('.ai-mic').getAttribute('aria-pressed'))) === 'true');
    await shot(app, 'recording');
    await sleep(3500); // de.wav is 2.8 s, the fake microphone plays it in a loop
    await ev(() => document.querySelector('.ai-mic').click());
    await app.waitFor('text', () => window.__t.chat().voice.phase === 'idle' && window.__t.chat().input.length > 8, 60000);
    const st = await ev(() => window.__t.chat());
    check('The German sentence lands in the input after the text there', /^Please: .*(Ende|Wurst)/.test(st.input), st.input);
    check('Nothing was sent', st.user.length === 0, JSON.stringify(st.user));
  } catch (e) {
    console.log('FEHLER Exception:', e.message);
    t.fail();
  } finally {
    await app.stop();
    cleanup(ud2);
  }
}

server.close();
cleanup(work);
if (t.fails) console.log(app.log().split('\n').filter((l) => /voice|renderer/.test(l)).slice(-30).join('\n'));
process.exit(t.fails ? 1 : 0);
