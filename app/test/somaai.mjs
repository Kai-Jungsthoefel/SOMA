// Test of SOMA AI (src/main/somaai.ts), the built-in agent: pi in RPC mode against a fake model (mockllm.mjs) that plays
// a script of tool calls. Checks start and state, the commands the chat may send, what pi gets (AGENTS.md, SOMA's
// addition to the system prompt, an image), that soma build runs inside it, the rules of the permission extension
// (inside the folder allowed, outside asks, secrets and going back in the history denied), stopping, continuing the
// conversation and ending pi when the model is left. Run: npm run test:somaai (builds first).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { checker, cleanup, startApp } from './harness.mjs';
import { startMockLlm, useMockModel } from './mockllm.mjs';

const t = checker();
const { check } = t;

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-somaai-'));
const auth = path.join(ud, 'somaai', 'auth.json');
// A website on 127.0.0.1 for web_fetch (allowed only with SOMA_TEST_WEB_LOCAL, below): a product page and its STEP file
const web = http.createServer((req, res) => {
  if (req.url === '/files/part.step') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('ISO-10303-21;\nHEADER;\nENDSEC;\n'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><head><title>Test bearing</title></head><body><h1>Bearing 608</h1><p>8 x 22 x 7 mm</p><a href="/files/part.step">STEP</a></body></html>');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${web.address().port}`;
const steps = [
  { tool: 'bash', args: { command: 'echo "RUN_AS_NODE=[$ELECTRON_RUN_AS_NODE]"' } },
  { tool: 'bash', args: { command: 'soma build' } },
  { tool: 'bash', args: { command: 'mkdir -p parts && cp model.py parts/copy.py && ls parts' } },
  { tool: 'bash', args: { command: 'cp model.py ../outside-copy.py' } },
  { tool: 'read', args: { path: auth } },
  { tool: 'bash', args: { command: 'git reset --hard HEAD' } },
  { tool: 'web_fetch', args: { url: `${site}/bearing` } },
  { tool: 'web_fetch', args: { url: `${site}/files/part.step`, path: 'inputs/part.step' } },
  { text: 'Done, the box is built.' },
];
const mock = await startMockLlm(steps);
useMockModel(ud, mock.port);
fs.writeFileSync(auth, '{}\n'); // something to read, if the rule did not stop it
// A 1x1 PNG stands in for the photo of a sketch
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const app = await startApp({ name: 'somaai', userData: ud, env: { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', SOMA_TEST_WEB_LOCAL: '1' } });
const { ev } = app;
const results = () => ev(() => window.__ai.events.filter((e) => e.record.type === 'tool_execution_end').map((e) => ({
  tool: e.record.toolName, error: !!e.record.isError, text: JSON.stringify(e.record.result?.content ?? e.record.result ?? ''),
})));

try {
  await app.waitFor('model open', () => !!window.__t && !!window.__t.project(), 90000);
  const dir = await ev(() => window.__t.project().dir);
  // Collect pi's records like the chat will. Questions are answered with "No" to see what is asked
  await ev(() => {
    window.__ai = { events: [], exits: [], asked: [] };
    window.soma.ai.onEvent((e) => {
      window.__ai.events.push(e);
      const r = e.record;
      if (r.type !== 'extension_ui_request' || !['select', 'confirm', 'input', 'editor'].includes(r.method)) return;
      window.__ai.asked.push({ method: r.method, title: String(r.title ?? ''), options: r.options ?? [] });
      // A website is allowed until the model is closed (web_fetch), everything else gets "No"
      const site = (r.options ?? []).find((o) => /^Yes, allow .* until/.test(o));
      if (/surface : web_fetch/.test(String(r.title ?? '')) && site) { window.soma.ai.respond({ id: r.id, value: site }); return; }
      const no = (r.options ?? []).find((o) => o === 'No');
      window.soma.ai.respond(r.method === 'confirm' ? { id: r.id, confirmed: false } : no ? { id: r.id, value: no } : { id: r.id, cancelled: true });
    });
    window.soma.ai.onExit((e) => window.__ai.exits.push(e));
  });

  let st = await ev(() => window.soma.ai.status());
  check('SOMA AI is available (pi and the permission extension are installed)', st.available && !st.running, JSON.stringify(st));

  const started = await ev(() => window.soma.ai.start());
  check('Starts pi for the open model and gets its state (fake model chosen)', started.ok && started.data?.model?.provider === 'mock', JSON.stringify(started).slice(0, 200));
  st = await ev(() => window.soma.ai.status());
  check('Status says it is running, with pi\'s version', st.running && /^\d+\.\d+\.\d+/.test(st.version ?? ''), JSON.stringify(st));

  const refused = await ev(() => window.soma.ai.command({ type: 'bash', command: 'echo hi' }));
  check('Commands outside the chat\'s list are refused (no direct shell)', !refused.ok && /Unknown request/.test(refused.error ?? ''), JSON.stringify(refused));

  const sent = await ev((png) => window.soma.ai.command({ type: 'prompt', message: 'Build the box from my sketch.', images: [{ type: 'image', data: png, mimeType: 'image/png' }] }), PNG);
  check('A prompt with a sketch image is accepted', sent.ok && sent.data?.disposition === 'started', JSON.stringify(sent));
  await app.waitFor('run settled', () => window.__ai.events.some((e) => e.record.type === 'agent_settled'), 180000);
  check('The run ends (agent_settled)', true);

  const first = mock.requests[0] ?? {};
  const sys = (first.messages ?? []).filter((m) => m.role === 'system' || m.role === 'developer').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  check('pi got AGENTS.md of the model in its system prompt', sys.includes('Instructions for the coding agent'), `${sys.length} chars`);
  check('… and SOMA\'s addition (SOMA AI, plain words for non-programmers)', sys.includes('You are SOMA AI') && sys.includes('not a programmer'));
  check('… and the user\'s units (Settings > Viewer > Units, default millimetres)', sys.includes('Units: the user works in millimetres'), sys.slice(sys.indexOf('Units:'), sys.indexOf('Units:') + 80));
  const user = (first.messages ?? []).find((m) => m.role === 'user');
  check('The image reached the model', Array.isArray(user?.content) && user.content.some((c) => c.type === 'image_url'), JSON.stringify(user?.content?.map?.((c) => c.type)));

  const r = await results();
  const step = (i) => r[i] ?? { error: true, text: '(missing)' };
  check('Commands pi runs do not inherit ELECTRON_RUN_AS_NODE', !step(0).error && step(0).text.includes('RUN_AS_NODE=[]'), step(0).text.slice(0, 120));
  check('soma build runs inside SOMA AI (Python, soma and bash on the PATH)', !step(1).error && step(1).text.includes('Build ok'), step(1).text.slice(0, 160));
  check('Copying and listing inside the model folder is allowed without a question', !step(2).error && step(2).text.includes('copy.py') && fs.existsSync(path.join(dir, 'parts', 'copy.py')), step(2).text.slice(0, 120));
  check('Copying out of the model folder asks, and No blocks it', step(3).error && /denied/i.test(step(3).text) && !fs.existsSync(path.join(dir, '..', 'outside-copy.py')), step(3).text.slice(0, 160));
  check('Reading the sign-in of SOMA AI is denied without a question', step(4).error && /sign-in of SOMA AI/.test(step(4).text), step(4).text.slice(0, 200));
  check('Going back in the history is denied, the agent learns why', step(5).error && /forward only/.test(step(5).text), step(5).text.slice(0, 200));
  check('web_fetch asks once for the website and then reads the page as text with its file links', !step(6).error && step(6).text.includes('Bearing 608')
    && step(6).text.includes('Links to files') && step(6).text.includes('/files/part.step'), step(6).text.slice(0, 300));
  check('… the download from the same website needs no second question and lands in inputs/', !step(7).error && /Saved inputs\/part\.step.*STEP/.test(step(7).text)
    && fs.readFileSync(path.join(dir, 'inputs', 'part.step'), 'utf8').startsWith('ISO-10303-21'), step(7).text.slice(0, 200));
  const tools = (first.tools ?? []).map((x) => x.function?.name ?? x.name);
  check('SOMA AI has web_fetch, and web_search from pi-web-search is loaded', tools.includes('web_fetch') && tools.includes('web_search') && tools.includes('part_library') && tools.includes('ask_user'), JSON.stringify(tools));
  const asked = await ev(() => window.__ai.asked);
  check('Two questions during the run: the copy out of the folder, and the website (once)', asked.length === 2 && asked[0].method === 'select' && asked[0].title.includes('outside-copy')
    && asked[1].title.includes('surface : web_fetch'), JSON.stringify(asked).slice(0, 400));
  const settings = JSON.parse(fs.readFileSync(path.join(ud, 'somaai', 'settings.json'), 'utf8'));
  check('pi settings: SOMA\'s keys set, the chosen model kept', settings.defaultProjectTrust === 'never' && settings.defaultModel === 'mock-cad'
    && (process.platform !== 'win32' || /sh\.exe$/.test(settings.shellPath ?? '')), JSON.stringify(settings));

  await ev(() => window.soma.ai.stop());
  st = await ev(() => window.soma.ai.status());
  const exits = await ev(() => window.__ai.exits);
  check('Stop ends pi without an error', !st.running && exits.length === 1 && !exits[0].error, JSON.stringify({ st, exits }));

  const again = await ev(() => window.soma.ai.start());
  const msgs = again.ok ? await ev(() => window.soma.ai.command({ type: 'get_messages' })) : again;
  const count = msgs.data?.messages?.length ?? 0;
  check('Starting again continues the conversation of the model', again.ok && count >= 2, `${count} messages`);
  const times = await ev(() => window.soma.ai.runTimes());
  const took = Object.values(times.data ?? {});
  check('How long the finished task took, for "Worked for" in the history', times.ok && took.length === 1 && took[0] > 0, JSON.stringify(times));

  // After "Load file" (marked in the model's state) a new conversation: the last one is about a later state of the model
  const id = await ev(() => window.__t.project().id);
  const stateFile = path.join(ud, 'projects', `${id}.json`);
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  fs.writeFileSync(stateFile, JSON.stringify({ ...state(), app: { ...state().app, aiFresh: true } }));
  await ev((i) => window.soma.project.open(i), id);
  await app.waitFor('model open again', (i) => window.__t.project()?.id === i, 60000, id);
  const fresh = await ev(() => window.soma.ai.command({ type: 'get_messages' }));
  const sessions = await ev(() => window.soma.ai.sessions());
  check('Marked after "Load file": a new conversation, the earlier one stays in the list', fresh.ok && fresh.data.messages.length === 0
    && sessions.ok && sessions.sessions.some((x) => x.messages >= 2) && state().app.aiFresh === true, JSON.stringify({ n: fresh.data?.messages?.length, s: sessions.sessions?.length, app: state().app }));
  const back = await ev((sid) => window.soma.ai.switchSession(sid), sessions.sessions.find((x) => x.messages >= 2).id);
  check('… picking the earlier one ends the mark: from then on it continues', back.ok && state().app.aiFresh === false, JSON.stringify({ back, app: state().app }));

  const oldGen = (await ev(() => window.__ai.events.at(-1)?.gen)) ?? 0;
  await ev(() => window.soma.project.create());
  await app.waitFor('pi of the old model ended', () => window.__ai.exits.length >= 2, 30000).catch(() => null);
  const exits2 = await ev(() => window.__ai.exits);
  st = await ev(() => window.soma.ai.status());
  check('Leaving the model ends its pi (no error, nothing running in the new model)', exits2.length >= 2 && !exits2.at(-1).error && !st.running && exits2.at(-1).gen >= oldGen, JSON.stringify(exits2));
  // The old model folder is free again: renaming it works (Windows keeps folders in use by a process). A few seconds of
  // grace, the terminal of the old model ends asynchronously as well
  const moved = `${dir}-moved`;
  let free = null;
  for (const t0 = Date.now(); free !== true && Date.now() - t0 < 15000;) {
    free = await fsp.rename(dir, moved).then(() => fsp.rename(moved, dir)).then(() => true).catch((e) => e.code);
    if (free !== true) await new Promise((res) => setTimeout(res, 500));
  }
  check('The old model folder is no longer in use', free === true, String(free));
} catch (e) {
  console.log('FEHLER Exception:', e.message);
  t.fail();
} finally {
  await app.stop();
  await mock.close();
  web.close();
  cleanup(ud);
}
if (t.fails) console.log(app.log().split('\n').filter((l) => l.includes('[somaai]')).slice(-30).join('\n'));
process.exit(t.fails ? 1 : 0);
