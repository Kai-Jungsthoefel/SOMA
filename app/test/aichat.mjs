// Test of SOMA AI's chat (src/renderer/chat.ts) with a fake model (mockllm.mjs): set-up with an API key, the note before
// the first message, a chip from "Send to agent", a run in plain words (build, a question about leaving the model folder
// answered with "Don't allow", a command stopped by SOMA), the dot on the tab, a provider error as a problem with a way
// out, the conversation again after a model switch, signing out. Run: npm run test:aichat (builds first).
// SMOKE_SHOTS=1 with SMOKE_VISIBLE=offscreen saves pictures to test/shots/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';
import { startMockLlm, useMockModel } from './mockllm.mjs';

const t = checker();
const { check } = t;

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-aichat-'));
const steps = [
  { tool: 'ask_user', args: { question: 'Which material?', options: [{ label: 'PLA', description: 'Easy to print' }, { label: 'PETG', description: 'Tougher, a bit harder to print' }] } },
  { tool: 'bash', args: { command: 'ls' } },
  { tool: 'bash', args: { command: 'ls -a' } },
  { tool: 'bash', args: { command: 'soma build' } },
  { tool: 'bash', args: { command: 'cp model.py ../outside.py' } },
  { tool: 'bash', args: { command: 'git reset --hard HEAD' } },
  { text: 'Done, the lid is **2 mm** thicker now.' },
  { status: 401, message: 'invalid x-api-key' },
];
const mock = await startMockLlm(steps);
useMockModel(ud, mock.port);
const aiDir = path.join(ud, 'somaai');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(aiDir, f), 'utf8')); } catch { return {}; } };

const app = await startApp({ name: 'aichat', userData: ud, env: { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
const { ev } = app;
const chat = () => ev(() => window.__t.chat());
const dot = () => ev(() => document.querySelector('.ai-tab .ai-dot')?.dataset.state);
/** Clicks the button inside SOMA AI (or a menu) with exactly this text. */
const click = (text, scope = '.ai-pane') => ev(([s, tx]) => {
  const b = [...document.querySelectorAll(`${s} button`)].find((x) => x.textContent.trim() === tx && !x.disabled);
  if (!b) return false;
  b.click();
  return true;
}, [scope, text]);
const shot = async (name) => {
  if (!process.env.SMOKE_SHOTS) return;
  fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
  await sleep(500);
  await app.screenshot(path.join(APP, 'test', 'shots', `aichat-${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
};

try {
  await app.waitFor('model open', () => !!window.__t && !!window.__t.project(), 90000);
  const dir = await ev(() => window.__t.project().dir);
  const modelId = await ev(() => window.__t.project().id);

  const tabs = await ev(() => ({
    first: document.querySelector('#term-tabs .tab')?.textContent?.trim(),
    menu: !!document.getElementById('btn-ai-tab') && document.querySelector('#menu-agents .mh')?.textContent,
  }));
  check('SOMA AI is the first tab of the agent area, the + menu starts it', tabs.first === 'SOMA AI' && tabs.menu === 'START', JSON.stringify(tabs));

  // ---- Set up --------------------------------------------------------------------------------------------------------
  await ev(() => window.__t.showChat(true));
  await app.waitFor('set-up', () => window.__t.chat().phase === 'setup', 20000);
  const setup = await ev(() => [...document.querySelectorAll('.ai-pane button')].map((b) => b.textContent.trim()));
  check('Without a sign-in: set-up with ChatGPT, API key and terminal', setup.includes('Sign in with ChatGPT') && setup.includes('Save key') && setup.includes('Open a terminal'), setup.join(' | '));
  check('Dot on the tab: grey (not set up)', (await dot()) === 'off', await dot());
  await shot('setup');

  await ev(() => { const s = document.querySelector('.ai-pane select'); s.value = 'anthropic'; s.dispatchEvent(new Event('change')); });
  await ev(() => { const k = document.querySelector('.ai-pane input[type=password]'); k.value = ' with space '; });
  await click('Save key');
  await app.waitFor('error shown', () => !!document.querySelector('.ai-err')?.textContent, 10000);
  const err = await ev(() => document.querySelector('.ai-err').textContent);
  check('A key with spaces is refused with a reason, nothing saved', /spaces/.test(err) && !readJson('auth.json').anthropic, err);
  await ev(() => { const k = document.querySelector('.ai-pane input[type=password]'); k.value = 'sk-ant-test-123'; });
  await click('Save key');
  await app.waitFor('note', () => window.__t.chat().phase === 'note', 20000);
  const auth = readJson('auth.json');
  let settings = readJson('settings.json');
  check('The key is in pi\'s auth.json, the recommended model is chosen', auth.anthropic?.type === 'api_key' && auth.anthropic?.key === 'sk-ant-test-123'
    && settings.defaultProvider === 'anthropic' && settings.defaultModel === 'claude-opus-5-5', JSON.stringify({ provider: settings.defaultProvider, model: settings.defaultModel }));
  const page = await ev(() => document.body.innerText);
  check('The key never reaches the window', !page.includes('sk-ant-test-123'));

  // ---- The note before the first message --------------------------------------------------------------------------
  let st = await chat();
  const note = await ev(() => document.querySelector('.ai-note')?.textContent ?? '');
  check('Note before the first message: risks named, provider named, input locked', note.includes('Before you start') && note.includes('Anthropic (Claude)') && st.locked, note.slice(0, 120));
  await shot('note');
  await click('Got it');
  await app.waitFor('chat', () => window.__t.chat().phase === 'chat' && window.__t.chat().model?.id === 'claude-opus-5-5', 60000);
  st = await chat();
  const welcome = await ev(() => document.querySelector('.ai-welcome')?.textContent ?? '');
  check('After "Got it": welcome with suggestions, the recommended model of the new sign-in on the chip', welcome.includes('What do you want to make?') && st.model?.name === 'Claude Opus 5.5' && !st.locked, `${st.model?.name}`);
  // The fake model instead of Anthropic for the rest of the test, chosen in the model menu like a user would
  await ev(() => document.querySelector('.ai-model').click());
  await app.waitFor('model menu', () => !document.querySelector('.ai-menu').hidden && document.querySelector('.ai-menu').textContent.includes('Mock CAD'), 20000);
  const menuText = await ev(() => document.querySelector('.ai-menu').textContent);
  check('Model menu: the recommended models first', menuText.startsWith('RECOMMENDED FOR THE BEST RESULTS') && menuText.indexOf('Claude Opus 5.5') < menuText.indexOf('OTHER MODELS'), menuText.slice(0, 120));
  await click('Mock CAD', '.ai-menu');
  await app.waitFor('fake model chosen', () => window.__t.chat().model?.id === 'mock-cad', 20000);
  check('Dot on the tab: green (ready)', (await dot()) === 'idle', await dot());
  await shot('welcome');

  // ---- A run ------------------------------------------------------------------------------------------------------
  await ev(() => window.__t.toAgent('[Part: Lid · top face] '));
  st = await chat();
  check('"Send to agent" puts a chip into SOMA AI\'s input', st.chips.length === 1 && st.chips[0] === 'Part: Lid · top face', JSON.stringify(st.chips));
  await ev(() => { const i = document.querySelector('.ai-input'); i.value = 'Make the lid thicker.'; i.dispatchEvent(new Event('input')); });
  await ev(() => document.querySelector('.ai-send').click());

  // A question of SOMA AI (tool ask_user), answered in own words
  await app.waitFor('question of SOMA AI', () => window.__t.chat().questions.some((q) => !q.done), 120000);
  st = await chat();
  const q = st.questions.find((x) => !x.done);
  const answers = await ev(() => [...document.querySelectorAll('.ai-q .ai-ans')].map((b) => b.textContent));
  check('SOMA AI asks with answers to click, each with what it means', q.text.includes('Which material?') && answers.length === 2 && answers[0] === 'PLAEasy to print', JSON.stringify(answers));
  check('While it waits: input locked, the indicator says so, with the time', st.locked && /^Waiting for your answer\s*· \d+ s/.test(st.status.trim()), st.status);
  await shot('ask-user');
  await ev(() => { const i = document.querySelector('.ai-q input'); i.value = 'Wood, actually'; });
  await click('Send', '.ai-q');
  await app.waitFor('answer reached the model', () => true, 1000);
  await app.waitFor('question done', () => window.__t.chat().questions.every((x) => x.done), 20000);
  for (const t0 = Date.now(); Date.now() - t0 < 20000 && !mock.requests.some((r) => JSON.stringify(r.messages ?? []).includes('The person answered: Wood, actually'));) await sleep(200);
  check('An own answer reaches SOMA AI as the tool\'s result', mock.requests.some((r) => JSON.stringify(r.messages ?? []).includes('The person answered: Wood, actually')));

  await app.waitFor('question', () => window.__t.chat().asks.some((a) => !a.done), 120000);
  st = await chat();
  const ask = st.asks.find((a) => !a.done);
  check('Leaving the model folder asks in plain words', ask.title === 'SOMA AI wants to work with files outside this model' && ask.what.includes('outside.py'), JSON.stringify(ask));
  check('While it asks: input locked, dot yellow', st.locked && (await dot()) === 'wait', `${st.locked} ${await dot()}`);
  await shot('question');
  await click('Don’t allow');
  await app.waitFor('run settled', () => { const c = window.__t.chat(); return !c.running && c.text.some((x) => x.includes('thicker now')); }, 120000);
  st = await chat();
  const labels = st.rows.map((r) => `${r.state}: ${r.label}${r.count > 1 ? ` ×${r.count}` : ''}`);
  check('Steps of the same kind are one row with a count', labels[0] === 'ok: Looked at files ×2', labels.join(' | '));
  labels.shift();
  check('Steps in plain words: build done', labels[0] === 'ok: Built the model', labels[0]);
  check('… copy out of the folder: not allowed by the user', /^denied: You did not allow this/.test(labels[1] ?? ''), labels[1]);
  check('… going back in the history: stopped by SOMA, said for people (the agent\'s reason under Details)', /^stopped: SOMA stopped this: going back in the history\./.test(labels[2] ?? ''), labels[2]);
  check('Nothing was copied out of the model folder', !fs.existsSync(path.join(dir, '..', 'outside.py')));
  check('The message went with the chip text', st.user.length === 1 && st.user[0].text.includes('[Part: Lid · top face]') && st.user[0].text.includes('Make the lid thicker.') && st.chips.length === 0, JSON.stringify(st.user));
  const md = await ev(() => document.querySelector('.ai-msg .md strong')?.textContent);
  check('The answer is shown as formatted text (Markdown as DOM)', md === '2 mm', md);
  check('Dot on the tab: green again', (await dot()) === 'idle', await dot());
  check('Indicator gone, the turn ends with how long it took', st.status === null && /^Worked for (\d+ min )?\d+ s$/.test(st.quiet.at(-1) ?? ''), `${st.status} | ${st.quiet.at(-1)}`);
  await shot('done');

  // ---- A provider error -------------------------------------------------------------------------------------------
  await ev(() => { const i = document.querySelector('.ai-input'); i.value = 'And add vents.'; i.dispatchEvent(new Event('input')); });
  await ev(() => document.querySelector('.ai-send').click());
  await app.waitFor('problem', () => window.__t.chat().problems.length > 0, 60000);
  st = await chat();
  const prob = await ev(() => [...document.querySelectorAll('.ai-prob')].at(-1)?.textContent ?? '');
  check('A refused key becomes a problem with one way out', st.problems.at(-1) === 'The sign-in does not work any more' && prob.includes('Choose a sign-in'), st.problems.join(' | '));

  // ---- Another model and back: the conversation is there again --------------------------------------------------
  // A change, otherwise the model counts as untouched and disappears when it is left (E69): the fake model only built it
  fs.appendFileSync(path.join(dir, 'NOTES.md'), '\nThe lid should be thicker.\n');
  await ev(() => window.soma.project.create());
  await app.waitFor('new model', (id) => window.__t.project()?.id !== id, 60000, modelId);
  await app.waitFor('empty chat of the new model', () => window.__t.chat().phase === 'chat' && window.__t.chat().user.length === 0, 60000);
  await ev((id) => window.soma.project.open(id), modelId);
  await app.waitFor('old model', (id) => window.__t.project()?.id === id, 60000, modelId);
  await app.waitFor('history', () => window.__t.chat().user.length === 2, 60000);
  st = await chat();
  check('After a model switch the conversation of the model is back, steps grouped as before', JSON.stringify(st.rows.map((r) => [r.state, r.count])) === '[["ok",2],["ok",1],["denied",1],["stopped",1]]',
    JSON.stringify(st.rows.map((r) => [r.state, r.count])));
  check('… and the question with its answer', st.quiet.some((x) => x.includes('SOMA AI asked: Which material? You answered: Wood, actually')), st.quiet.join(' | ').slice(0, 200));

  // ---- Another sign-in: the conversation stays (the set-up has its own place) ----------------------------------
  const menu = async (item) => {
    await ev(() => document.querySelector('.ai-top [aria-label="Sign-in and more"]').click());
    await app.waitFor('menu', () => !document.querySelector('.ai-menu').hidden, 5000);
    return click(item, '.ai-menu');
  };
  const leftover = () => ev(() => ({ panel: !document.querySelector('.ai-panel').hidden, setupInList: !!document.querySelector('.ai-list .ai-setup, .ai-list .ai-note') }));
  await menu('Use another sign-in …');
  await app.waitFor('set-up', () => window.__t.chat().phase === 'setup', 10000);
  await click('Back to the conversation');
  await app.waitFor('chat again', () => window.__t.chat().phase === 'chat', 10000);
  st = await chat();
  let lo = await leftover();
  check('"Use another sign-in" and back: the conversation is there, no set-up left over', st.user.length === 2 && !lo.panel && !lo.setupInList, JSON.stringify(lo));
  await menu('Use another sign-in …');
  await app.waitFor('set-up', () => window.__t.chat().phase === 'setup', 10000);
  await ev(() => { const s = document.querySelector('.ai-pane select'); s.value = 'openrouter'; s.dispatchEvent(new Event('change')); });
  await ev(() => { const k = document.querySelector('.ai-pane input[type=password]'); k.value = 'sk-or-test-456'; });
  await click('Save key');
  // Ready means started with the model chosen, not just the first record of the new pi (piUp)
  await app.waitFor('chat after the new sign-in', () => { const c = window.__t.chat(); return c.phase === 'chat' && c.piUp && !c.starting; }, 60000);
  st = await chat();
  lo = await leftover();
  check('After a new sign-in: back in the conversation, the chip shows its recommended model', st.user.length === 2 && !lo.panel && !lo.setupInList
    && st.model?.provider === 'openrouter' && st.model?.id === 'anthropic/claude-opus-5.5', `${st.model?.provider} ${st.model?.id} ${JSON.stringify(lo)}`);

  // ---- Signing out ------------------------------------------------------------------------------------------------
  await menu('Sign out of OpenRouterAPI key');
  await app.waitFor('still signed in elsewhere', () => window.__t.chat().phase === 'chat', 20000);
  await menu('Sign out of Anthropic (Claude)API key');
  await app.waitFor('set-up again', () => window.__t.chat().phase === 'setup', 20000);
  const left = Object.keys(readJson('auth.json'));
  check('Signing out removes the keys, after the last one the set-up shows again', !left.includes('anthropic') && !left.includes('openrouter'), JSON.stringify(left));
} catch (e) {
  console.log('FEHLER Exception:', e.message);
  t.fail();
} finally {
  await app.stop();
  await mock.close();
  cleanup(ud);
}
if (t.fails) console.log(app.log().split('\n').filter((l) => /somaai|renderer/.test(l)).slice(-30).join('\n'));
process.exit(t.fails ? 1 : 0);
