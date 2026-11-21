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
  { tool: 'ask_user', args: { questions: [
    { question: 'Which material?', header: 'Material', options: [{ label: 'PLA', description: 'Easy to print' }, { label: 'PETG', description: 'Tougher, a bit harder to print' }] },
    { question: 'What should the lid have?', header: 'Lid', multiSelect: true, options: [{ label: 'Hinge' }, { label: 'Snap fit' }, { label: 'Label recess' }] },
  ] } },
  { tool: 'ask_user', args: { questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] } },
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
  // Effort: Opus 5.5 thinks, so the button shows. The menu lists its levels with the recommended one marked
  await app.waitFor('effort button', () => window.__t.chat().effortShown, 20000);
  await ev(() => document.querySelector('.ai-effort').click());
  await app.waitFor('effort menu', () => !document.querySelector('.ai-menu').hidden && !!document.querySelector('.ai-menu [data-effort]'), 20000);
  const eff = await ev(() => ({
    levels: [...document.querySelectorAll('.ai-menu [data-effort]')].map((b) => b.dataset.effort),
    rec: document.querySelector('.ai-menu [data-effort="high"]')?.textContent, note: document.querySelector('.ai-menu .mnote')?.textContent,
  }));
  await shot('effort-menu');
  check('Effort menu: the levels of the model, High marked as recommended, a word on what more effort does',
    eff.levels.includes('high') && eff.levels.length > 2 && eff.rec === 'HighRecommended' && eff.note.includes('We recommend High or more'), JSON.stringify(eff));
  await ev(() => document.querySelector('.ai-menu [data-effort="high"]').click());
  await app.waitFor('effort taken', () => window.__t.chat().effort === 'high', 20000);
  check('… choosing High: the conversation takes it, saved for new ones, the button says so',
    readJson('settings.json').defaultThinkingLevel === 'high' && (await ev(() => document.querySelector('.ai-effort').textContent)) === 'High effort', JSON.stringify(readJson('settings.json')));
  // The fake model instead of Anthropic for the rest of the test, chosen in the model menu like a user would
  await ev(() => document.querySelector('.ai-model').click());
  await app.waitFor('model menu', () => !document.querySelector('.ai-menu').hidden && document.querySelector('.ai-menu').textContent.includes('Mock CAD'), 20000);
  const menuText = await ev(() => document.querySelector('.ai-menu').textContent);
  check('Model menu: the recommended models first', menuText.startsWith('RECOMMENDED FOR THE BEST RESULTS') && menuText.indexOf('Claude Opus 5.5') < menuText.indexOf('OTHER MODELS'), menuText.slice(0, 120));
  // Search: the field has the focus, words narrow the list, Enter takes the first match
  const typeSearch = (v) => ev((x) => { const s = document.querySelector('.ai-menu .ai-msearch'); s.value = x; s.dispatchEvent(new Event('input')); }, v);
  const visible = () => ev(() => ({
    items: [...document.querySelectorAll('.ai-menu .mi')].filter((b) => !b.hidden).map((b) => b.textContent),
    none: !document.querySelector('.ai-menu .mnote').hidden, focus: document.activeElement?.classList.contains('ai-msearch'),
  }));
  await typeSearch('zzzz');
  const nothing = await visible();
  await typeSearch('mock');
  const found = await visible();
  await shot('model-search');
  check('Model menu: a search that narrows the list, with a word when nothing matches', nothing.focus && nothing.items.length === 0 && nothing.none && JSON.stringify(found.items) === '["Mock CAD"]' && !found.none,
    JSON.stringify({ nothing, found }));
  await ev(() => document.querySelector('.ai-menu .ai-msearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await app.waitFor('fake model chosen', () => window.__t.chat().model?.id === 'mock-cad', 20000);
  st = await chat();
  check('A model that does not think: no effort button (pi clamps the level to off)', !st.effortShown && st.effort === 'off', JSON.stringify({ effort: st.effort, efforts: st.efforts }));
  check('Dot on the tab: green (ready)', (await dot()) === 'idle', await dot());
  await shot('welcome');

  // ---- A run ------------------------------------------------------------------------------------------------------
  await ev(() => window.__t.toAgent('[Part: Lid · top face] '));
  st = await chat();
  check('"Send to agent" puts a chip into SOMA AI\'s input', st.chips.length === 1 && st.chips[0] === 'Part: Lid · top face', JSON.stringify(st.chips));
  await ev(() => { const i = document.querySelector('.ai-input'); i.value = 'Make the lid thicker.'; i.dispatchEvent(new Event('input')); });
  await ev(() => document.querySelector('.ai-send').click());

  // Questions of SOMA AI (tool ask_user): two in one card, answered together, one of them in own words
  /** The tool results pi sent to the model, as text. */
  const toolResults = () => mock.requests.flatMap((r) => (r.messages ?? []).filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join(''))));
  const waitToolResult = async (part) => { for (const t0 = Date.now(); Date.now() - t0 < 20000 && !toolResults().some((x) => x.includes(part));) await sleep(200); return toolResults().some((x) => x.includes(part)); };
  await app.waitFor('questions of SOMA AI', () => window.__t.chat().questions.some((q) => !q.done), 120000);
  st = await chat();
  const card = await ev(() => {
    const c = document.querySelector('.ai-q:not(.done)');
    return {
      title: c.querySelector('h4').textContent, blocks: c.querySelectorAll('.ai-qblock').length, owns: c.querySelectorAll('.ai-own textarea').length,
      answers: [...c.querySelectorAll('.ai-ans')].map((b) => b.textContent), send: c.querySelector('.ai-qacts .btn').disabled,
    };
  });
  check('SOMA AI asks two questions in one card, answers to click with what they mean, an own answer for each',
    card.title === 'SOMA AI has 2 questions' && card.blocks === 2 && card.owns === 2 && card.answers[0] === 'PLAEasy to print' && card.answers.length === 5, JSON.stringify(card));
  check('While it waits: input locked, the indicator says so, with the time; nothing answered, nothing to send',
    st.locked && /^Waiting for your answer\s*· \d+ s/.test(st.status.trim()) && card.send, st.status);
  // A longer own answer: the field wraps and grows, so the whole text stays in sight (it was a one-line input)
  const grow = await ev(() => {
    const i = document.querySelector('.ai-q:not(.done) .ai-own textarea');
    const h0 = i.offsetHeight;
    i.value = 'Wood, actually, because the box should match the shelf next to it, and a little longer so it needs several lines';
    i.dispatchEvent(new Event('input'));
    return { h0, h1: i.offsetHeight, hidden: i.scrollHeight - i.clientHeight };
  });
  check('Own answer: one line when empty, grows with a longer text so none of it is out of sight',
    grow.h0 <= 34 && grow.h1 > grow.h0 + 10 && grow.hidden <= 1, JSON.stringify(grow));
  await ev(() => { const i = document.querySelector('.ai-q:not(.done) .ai-own textarea'); i.value = 'Wood, actually'; i.dispatchEvent(new Event('input')); });
  await click('Hinge', '.ai-q:not(.done)');
  await click('Label recess', '.ai-q:not(.done)');
  const on = await ev(() => [...document.querySelectorAll('.ai-q:not(.done) .ai-ans.on')].map((b) => b.querySelector('b').textContent));
  check('Several answers to pick where several apply', JSON.stringify(on) === '["Hinge","Label recess"]', JSON.stringify(on));
  await shot('ask-user');
  await click('Send answers', '.ai-q:not(.done)');
  check('Both answers reach SOMA AI together, the own words as such',
    await waitToolResult('Which material? → in their own words: "Wood, actually"') && toolResults().some((x) => x.includes('What should the lid have? → Hinge, Label recess')), toolResults().at(-1));
  // One question with one answer to pick: a click sends it
  await app.waitFor('one more question', () => window.__t.chat().questions.some((q) => !q.done && q.text.includes('Which colour?')), 60000);
  await click('Red', '.ai-q:not(.done)');
  check('One question: a click on an answer sends it', await waitToolResult('The person answered:\nWhich colour? → Red'), toolResults().at(-1));
  st = await chat();
  check('The cards say what was answered', st.questions.every((x) => x.done) && st.questions[0].text.includes('Material → Wood, actually') && st.questions[1].text.includes('You answered: Red'),
    st.questions.map((x) => x.text).join(' | '));

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

  // An expired sign-in (ChatGPT: "OAuth refresh failed … (400): invalid_grant") is not "Try again": that never helps
  steps[steps.length - 1] = { status: 400, message: 'OAuth refresh failed: invalid_grant' };
  const nProblems = st.problems.length;
  await ev(() => { const i = document.querySelector('.ai-input'); i.value = 'And add vents, please.'; i.dispatchEvent(new Event('input')); });
  await ev(() => document.querySelector('.ai-send').click());
  await app.waitFor('second problem', (n) => window.__t.chat().problems.length > n, 60000, nProblems);
  st = await chat();
  const expired = await ev(() => [...document.querySelectorAll('.ai-prob')].at(-1)?.textContent ?? '');
  check('An expired sign-in says so and offers to sign in again', st.problems.at(-1) === 'Your sign-in has expired' && expired.includes('Sign in again'), st.problems.join(' | '));
  steps[steps.length - 1] = { status: 401, message: 'invalid x-api-key' };

  // ---- Another model and back: the conversation is there again --------------------------------------------------
  // A change, otherwise the model counts as untouched and disappears when it is left (E69): the fake model only built it
  fs.appendFileSync(path.join(dir, 'NOTES.md'), '\nThe lid should be thicker.\n');
  await ev(() => window.soma.project.create());
  await app.waitFor('new model', (id) => window.__t.project()?.id !== id, 60000, modelId);
  await app.waitFor('empty chat of the new model', () => window.__t.chat().phase === 'chat' && window.__t.chat().user.length === 0, 60000);
  await ev((id) => window.soma.project.open(id), modelId);
  await app.waitFor('old model', (id) => window.__t.project()?.id === id, 60000, modelId);
  await app.waitFor('history', () => window.__t.chat().user.length === 3, 60000);
  st = await chat();
  check('After a model switch the conversation of the model is back, steps grouped as before', JSON.stringify(st.rows.map((r) => [r.state, r.count])) === '[["ok",2],["ok",1],["denied",1],["stopped",1]]',
    JSON.stringify(st.rows.map((r) => [r.state, r.count])));
  check('… and the questions with their answers', st.quiet.some((x) => x.includes('SOMA AI asked: Which material? You answered: Wood, actually'))
    && st.quiet.some((x) => x.includes('SOMA AI asked: What should the lid have? You answered: Hinge, Label recess'))
    && st.quiet.some((x) => x.includes('SOMA AI asked: Which colour? You answered: Red')), st.quiet.join(' | ').slice(0, 400));
  const worked = st.quiet.filter((x) => /^Worked for (\d+ min )?\d+ s$/.test(x));
  check('… and how long each task took', worked.length >= 1, st.quiet.join(' | ').slice(-300));
  // Following the end: Chromium sends the scroll event of a jump to the end one frame later. A row added in between (the
  // next step, an answer) put the end further away without anyone scrolling, and the chat stopped following (it stayed
  // up to 185 px above the end). Only meaningful in a window that paints (SMOKE_VISIBLE=offscreen)
  // Invisible windows (SOMA_HIDDEN) do not paint, the jump to the end does not settle there: checked only offscreen
  const gap = process.env.SMOKE_VISIBLE !== 'offscreen' ? null : await ev(async () => {
    const body = document.querySelector('.ai-body');
    const list = document.querySelector('.ai-list');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const pad = Object.assign(document.createElement('div'), { style: 'height:3000px' });
    list.append(pad);
    await wait(100);
    // A step comes in: the chat jumps to the end. Then, before the scroll event of that jump, the next row
    const step = Object.assign(document.createElement('div'), { style: 'height:120px' });
    list.append(step);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const row = Object.assign(document.createElement('div'), { style: 'height:185px' });
    list.append(row);
    await wait(300);
    const g = body.scrollHeight - body.scrollTop - body.clientHeight;
    pad.remove(); step.remove(); row.remove();
    return g;
  });
  if (gap === null) console.log('SKIP   The chat stays at the end when rows come in quickly (needs SMOKE_VISIBLE=offscreen)');
  else check('The chat stays at the end when rows come in quickly', gap < 5, `${gap} px above the end`);

  // ---- Earlier conversations: a new one, then back to the first ---------------------------------------------------
  await ev(() => document.querySelector('.ai-top [aria-label="New conversation"]').click());
  await app.waitFor('new conversation', () => window.__t.chat().user.length === 0 && !!document.querySelector('.ai-welcome'), 30000);
  await ev(() => document.querySelector('.ai-top [aria-label="Earlier conversations"]').click());
  await app.waitFor('conversations', () => !document.querySelector('.ai-menu').hidden && document.querySelectorAll('.ai-menu .mi').length > 0, 30000);
  const convs = await ev(() => [...document.querySelectorAll('.ai-menu .mi')].map((b) => b.textContent));
  check('Earlier conversations: the first one is listed with its first words and when, the new empty one is not', convs.length === 1 && convs[0].startsWith('[Part: Lid · top face] Make the lid thicker.') && /today \d\d:\d\d/.test(convs[0]),
    JSON.stringify(convs));
  await shot('conversations');
  await ev(() => document.querySelector('.ai-menu .mi').click());
  await app.waitFor('earlier conversation back', () => window.__t.chat().user.length === 3, 30000);
  st = await chat();
  check('… a click brings it back: messages, steps and its model', st.user.length === 3 && st.rows.length === 4 && st.model?.id === 'mock-cad', JSON.stringify({ user: st.user.length, rows: st.rows.length, model: st.model?.id }));

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
  check('"Use another sign-in" and back: the conversation is there, no set-up left over', st.user.length === 3 && !lo.panel && !lo.setupInList, JSON.stringify(lo));
  await menu('Use another sign-in …');
  await app.waitFor('set-up', () => window.__t.chat().phase === 'setup', 10000);
  await ev(() => { const s = document.querySelector('.ai-pane select'); s.value = 'openrouter'; s.dispatchEvent(new Event('change')); });
  await ev(() => { const k = document.querySelector('.ai-pane input[type=password]'); k.value = 'sk-or-test-456'; });
  await click('Save key');
  // Ready means started with the model chosen, not just the first record of the new pi (piUp)
  await app.waitFor('chat after the new sign-in', () => { const c = window.__t.chat(); return c.phase === 'chat' && c.piUp && !c.starting; }, 60000);
  st = await chat();
  lo = await leftover();
  check('After a model that does not think and a new sign-in: the chosen effort again, not the clamped one', st.effort === 'high' && st.effortShown, JSON.stringify({ model: st.model?.id, effort: st.effort, efforts: st.efforts }));
  check('After a new sign-in: back in the conversation, the chip shows its recommended model', st.user.length === 3 && !lo.panel && !lo.setupInList
    && st.model?.provider === 'openrouter' && st.model?.id === 'anthropic/claude-opus-5.5', `${st.model?.provider} ${st.model?.id} ${JSON.stringify(lo)}`);

  // ---- Settings > SOMA AI ---------------------------------------------------------------------------------------
  const aiPage = () => ev(() => window.__t.settingsPages().ai);
  await ev(() => window.__t.settingsShow('ai'));
  await app.waitFor('models in Settings', () => window.__t.settingsPages().ai.models !== null && window.__t.settingsPages().ai.usage, 60000);
  let ap = await aiPage();
  check('Settings > SOMA AI: both sign-ins, ChatGPT to add, the models of the sign-ins, the recommendation',
    JSON.stringify(ap.accounts.map((a) => a.provider).sort()) === '["anthropic","openrouter"]' && ap.text.includes('Sign in with ChatGPT') && ap.models > 5
    && ap.text.includes('we recommend') && ap.current?.provider === 'openrouter', JSON.stringify({ accounts: ap.accounts, models: ap.models, current: ap.current, err: ap.modelsError }));
  check('… what the conversation of the open model used', /Messages\s+3 from you/.test(ap.text) && /Tokens\s+[\d.]+ k read/.test(ap.text), ap.text.slice(ap.text.indexOf('USAGE'), ap.text.indexOf('USAGE') + 200));
  await shot('settings-ai');
  // The model: chosen in the same menu with search, the open conversation takes it at once
  await ev(() => document.querySelector('#st-ai [data-act="model"]').click());
  await app.waitFor('model menu in Settings', () => !document.querySelector('.st-ai-menu').hidden, 10000);
  await ev(() => { const s = document.querySelector('.st-ai-menu .ai-msearch'); s.value = 'mock'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await app.waitFor('model taken', () => window.__t.settingsPages().ai.current?.id === 'mock-cad' && window.__t.chat().model?.id === 'mock-cad', 20000);
  settings = readJson('settings.json');
  check('… choosing a model there: saved for new conversations, the open conversation takes it too', settings.defaultProvider === 'mock' && settings.defaultModel === 'mock-cad',
    JSON.stringify({ provider: settings.defaultProvider, model: settings.defaultModel }));
  // The effort: the same menu with all of pi's levels, saved for new conversations
  check('… the effort row with the recommendation', /Effort\s/.test(ap.text) && ap.text.includes('More effort gives better models. We recommend High or more.') && ap.effort === 'high', JSON.stringify({ effort: ap.effort }));
  await ev(() => document.querySelector('#st-ai [data-act="effort"]').click());
  await app.waitFor('effort menu in Settings', () => !document.querySelector('.st-ai-menu').hidden && !!document.querySelector('.st-ai-menu [data-effort="xhigh"]'), 10000);
  await ev(() => document.querySelector('.st-ai-menu [data-effort="xhigh"]').click());
  await app.waitFor('effort saved', () => window.__t.settingsPages().ai.effort === 'xhigh', 10000);
  check('… choosing an effort there: saved for new conversations', readJson('settings.json').defaultThinkingLevel === 'xhigh', JSON.stringify(readJson('settings.json')));
  // A key added and removed there, the chat knows about it
  await ev(() => { const s = document.querySelector('#st-ai .ai-keyrow select'); s.value = 'google'; s.dispatchEvent(new Event('change')); document.querySelector('#st-ai .ai-keyrow input').value = 'AIza-test-789'; });
  await ev(() => [...document.querySelectorAll('#st-ai button')].find((b) => b.textContent === 'Save key').click());
  await app.waitFor('key added in Settings', () => window.__t.settingsPages().ai.accounts.some((a) => a.provider === 'google'), 20000);
  check('… an API key added there is in auth.json, the page lists it', readJson('auth.json').google?.key === 'AIza-test-789');
  await ev(() => document.querySelector('#st-ai [data-provider="google"] [data-act="signout"]').click());
  await app.waitFor('key removed in Settings', () => !window.__t.settingsPages().ai.accounts.some((a) => a.provider === 'google'), 20000);
  ap = await aiPage();
  check('… and signed out there again', !readJson('auth.json').google && !(await ev(() => document.body.innerText)).includes('AIza-test-789'));
  await ev(() => window.__t.closeSettings());

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
