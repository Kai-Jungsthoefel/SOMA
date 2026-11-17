import { accountLabel, CHATGPT_PROVIDER, RECOMMENDED_MODEL, type AiAccount } from '../shared/somaai';
import type { AiEvent, AiExit, SomaApi } from '../shared/types';
import { keyForm, searchMenu, showModelMenu } from './aiparts';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { el, fmtWhen, menuItem, menus } from './ui';

/*
 * Chat of SOMA AI, the agent built into SOMA (main/somaai.ts). Made for people who never used a coding agent
 * (design/agent-chat-draft.html): steps in plain words instead of tool calls, questions about leaving the model folder
 * in plain words, problems with one way out. Everything comes from pi's records (session events and extension
 * questions), rendered as DOM: text from the agent and the project never goes through innerHTML.
 *
 * Decisions of the user (2026-11-16): no protection beyond the permission rules, a note at the start names the risks
 * instead. A model recommendation instead of quality levels. Failed builds while SOMA AI works are normal: a neutral
 * step, never an error message.
 */

export type ChatState = 'off' | 'idle' | 'work' | 'wait';

export interface ChatDeps {
  api: SomaApi;
  toast(text: string, kind?: 'ok' | 'info' | 'error'): void;
  /** "I already use Claude Code": a terminal tab instead. */
  openTerminal(): void;
  store: { get(k: string): string | null; set(k: string, v: string): void };
  /** Dot on the tab: grey not set up, green ready, orange working, yellow waiting for an answer. */
  onState(s: ChatState): void;
}

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const NOTE_KEY = 'soma.aiNoteSeen';
/** An icon, the spinner turning (style.css .spin). */
const ico = (name: string, size = 16, sw = 1.8): Element => (name === 'spin' ? el('span', { className: 'spin' }, icon(name, size, sw)) : icon(name, size, sw));
const MAX_IMAGE = 8 * 1024 * 1024;
/** Start of the title of the input dialog from SOMA's tool ask_user (resources/somaai/soma.ts, same text there), JSON follows. */
const ASK_MARK = 'SOMA AI asks:\n';

/** A question of ask_user. `at`: its place in the call, the answers go back in that order. */
interface AskQ { at: number; question: string; header: string; options: { label: string; description: string }[]; multi: boolean }

/** The questions of an ask_user call from its JSON, only what can be shown: it comes from the agent. */
function askQuestions(json: string): AskQ[] {
  let p: unknown;
  try { p = JSON.parse(json); } catch { return []; }
  return arr(obj(p).questions).slice(0, 8).map(obj).map((q, at) => ({
    at,
    question: str(q.question).trim(),
    header: str(q.header).trim().slice(0, 40),
    options: arr(q.options).map(obj).map((o) => ({ label: str(o.label).trim(), description: str(o.description).trim() })).filter((o) => o.label).slice(0, 8),
    multi: q.multiSelect === true,
  })).filter((q) => q.question);
}

/** "SOMA AI asked: … You answered: …" for each question of an ask_user call in the history. */
function askedLines(args: Json, details: Json): string[] {
  const given = arr(details.answers).map(obj);
  return arr(args.questions).map(obj).flatMap((q, i) => {
    if (!str(q.question).trim()) return [];
    const a = str(given[i]?.answer);
    return [`SOMA AI asked: ${str(q.question).trim()}${a ? ` You answered: ${a}` : ' You skipped it.'}`];
  });
}
/**
 * Words of the working indicator, like Claude Code's "Elucidating …" (wish of the user): something visibly happens,
 * with a wink at the workshop. One every few seconds, never the same twice in a row.
 */
const WORKING = [
  'Sketching', 'Extruding', 'Filleting', 'Chamfering', 'Lofting', 'Revolving', 'Shelling', 'Measuring twice', 'Cutting once',
  'Deburring', 'Sanding the edges', 'Tightening bolts', 'Squaring up', 'Calibrating', 'Tolerancing', 'Machining', 'Drafting',
  'Pondering', 'Tinkering', 'Whittling', 'Riveting', 'Polishing', 'Shimming', 'Clamping', 'Marking out', 'Countersinking',
  'Tapping threads', 'Checking the fit', 'Sharpening the pencil', 'Consulting the caliper',
];
/** "12 s", "2 min 34 s", "1 h 05 min". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}

const SUGGESTIONS: { icon: string; text: string; sub?: string; attach?: boolean }[] = [
  { icon: 'image', text: 'Turn my sketch into a part', sub: 'Add a photo of a drawing with measurements', attach: true },
  { icon: 'cube', text: 'A case for a Raspberry Pi 5 with vents in the lid' },
  { icon: 'cube', text: 'A wall bracket for a 40 mm pipe, printed in PETG' },
  { icon: 'pen', text: 'Change this model: make the box 20 mm taller' },
];

// ---- Steps in plain words -----------------------------------------------------------------------------------------

interface StepWords { run: string; done: string; fail: string; meta?: string }
const fileName = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p;

/** What a tool call is, said for people who do not program. The command itself is behind "Details". */
export function stepWords(tool: string, args: Json): StepWords {
  if (tool === 'bash') {
    const c = str(args.command).trim();
    const has = (re: RegExp) => re.test(c);
    const w = (run: string, done: string, fail = `${done.replace(/^(\w+)/, 'Tried: $1')}`) => ({ run: `${run} …`, done, fail });
    if (has(/(^|[\s;&|(])soma build\b/)) return w('Building the model', 'Built the model', 'The model did not build yet');
    if (has(/\bsoma export\b/)) return w('Exporting', 'Exported', 'Exporting did not work yet');
    if (has(/\bsoma analyze\b/)) return w('Running an analysis', 'Ran an analysis', 'The analysis did not work yet');
    if (has(/\bsoma render\b/)) return w('Making a picture', 'Made a picture', 'The picture did not work yet');
    if (has(/\bsoma drawing\b/)) return w('Making a drawing', 'Made a drawing', 'The drawing did not work yet');
    if (has(/\bsoma anim\b/)) return w('Checking an animation', 'Checked an animation', 'The animation did not work yet');
    if (has(/\bgit commit\b/)) return w('Saving a step in the History', 'Saved a step in the History', 'Saving in the History did not work yet');
    if (has(/^(curl|wget)\b/)) return w('Downloading', 'Downloaded something', 'Downloading did not work');
    if (has(/\bpip3? install\b|-m pip install\b/)) return w('Installing software', 'Installed software', 'Installing did not work');
    if (has(/^(mkdir|cp|mv|rm|rmdir|touch)\b/)) return w('Arranging files', 'Arranged files', 'Arranging files did not work');
    if (has(/^(ls|find|grep|rg|cat|head|tail|wc|tree|pwd|stat|file|echo)\b/)) return w('Looking at files', 'Looked at files', 'Looking at files did not work');
    if (has(/^git (reset|checkout|restore|revert|rebase|branch|clean|stash)\b/)) return w('Going back in the History', 'Went back in the History', 'Going back in the History did not work');
    if (has(/^git push\b/)) return w('Publishing the model', 'Published the model', 'Publishing did not work');
    if (has(/^git\b/)) return w('Looking at the History', 'Looked at the History', 'Looking at the History did not work');
    if (has(/\bpython3?(\.exe)?\b/)) return w('Running a Python script', 'Ran a Python script', 'The Python script did not work yet');
    return w('Running a command', 'Ran a command', 'The command did not work');
  }
  const f = fileName(str(args.path));
  if (tool === 'read') return { run: `Looking at ${f} …`, done: `Looked at ${f}`, fail: `Could not look at ${f}` };
  if (tool === 'write') {
    const n = str(args.content).split('\n').length;
    return { run: `Writing ${f} …`, done: `Wrote ${f}`, fail: `Could not write ${f}`, meta: `${n} line${n === 1 ? '' : 's'}` };
  }
  if (tool === 'edit') {
    const n = arr(args.edits).length || 1;
    return { run: `Changing ${f} …`, done: `Changed ${f}`, fail: `Could not change ${f} yet`, meta: `${n} change${n === 1 ? '' : 's'}` };
  }
  return { run: `Using ${tool} …`, done: `Used ${tool}`, fail: `${tool} did not work` };
}

/** Text of a tool result (content blocks). */
const resultText = (result: unknown) => arr(obj(result).content).map((c) => str(obj(c).text)).join('\n');

/** The permission extension stopped the call: by a rule (`policy`) or because the user said no (`user`). */
function stoppedBy(text: string): { by: 'policy' | 'user'; reason: string } | null {
  if (!text.includes('[pi-permission-system]')) return null;
  if (/user denied/i.test(text)) return { by: 'user', reason: '' };
  return { by: 'policy', reason: /Reason: (.*?)\.?$/m.exec(text)?.[1] ?? '' };
}

// ---- Questions in plain words ---------------------------------------------------------------------------------------

/** The permission extension's question as key/value lines ("tool : bash", "surface : external_directory" …). */
export function questionFacts(title: string): Record<string, string> {
  const parts: Record<string, string[]> = {};
  let key: string | null = null;
  for (const line of title.split('\n').slice(1)) {
    // Keys are padded to one width ("tool              :"), so there is a space before the colon. A path such as
    // "c:\users\…" has none and continues the value above. Long values wrap onto the next lines
    const m = /^([a-z][a-z _-]*?)\s+:\s?(.*)$/i.exec(line);
    if (m) { key = m[1].trim().toLowerCase(); parts[key] = m[2].trim() ? [m[2].trim()] : []; }
    else if (key && line.trim()) parts[key].push(line.trim());
  }
  const facts: Record<string, string> = {};
  // Paths wrap in the middle of a name: joined without a space
  for (const [k, v] of Object.entries(parts)) facts[k] = /path|directory/.test(k) ? v.join('') : v.join(' ');
  return facts;
}

/** Last two parts of a path, the way people name a place: "Downloads › bracket.step". */
const shortPlace = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join(' › ') || p;

/** One of the four questions (design/agent-chat-draft.html, slide 8), or a command SOMA cannot judge. */
export function plainQuestion(facts: Record<string, string>): { icon: string; title: string; what: string; whatIcon: string; full: string } {
  const surface = facts.surface ?? '';
  const rule = facts.rule ?? '';
  const cmd = facts['full command'] ?? facts.command ?? '';
  // "external path" names the place. "why" has it too, followed by an explanation ("…\x.py: unproven, …")
  const place = facts['external path'] || facts.path || (facts.why ?? '').replace(/:\s.*$/, '');
  if (surface.startsWith('external_directory_read')) return { icon: 'folder', title: 'SOMA AI wants to look at a file outside this model', what: shortPlace(place), whatIcon: 'file', full: place };
  if (surface.startsWith('external_directory')) {
    const write = surface.endsWith('_write');
    return { icon: 'pen', title: write ? 'SOMA AI wants to change files outside this model' : 'SOMA AI wants to work with files outside this model', what: shortPlace(place), whatIcon: 'folder', full: place };
  }
  if (/^(curl|wget)\b/.test(rule)) {
    const url = /https?:\/\/[^\s'"]+/.exec(cmd)?.[0] ?? '';
    let host = url;
    try { host = new URL(url).host; } catch { /* as written */ }
    return { icon: 'globe', title: 'SOMA AI wants to download something from the internet', what: host || cmd, whatIcon: 'globe', full: cmd };
  }
  if (/^(pip|pip3|python -m pip|npm|npx)\b/.test(rule)) {
    return { icon: 'pkg', title: 'SOMA AI wants to install extra software for this model', what: cmd.replace(/^.*?\binstall\s+/, '') || cmd, whatIcon: 'pkg', full: cmd };
  }
  return { icon: 'alert', title: 'SOMA AI wants to run a command that SOMA cannot check', what: cmd, whatIcon: 'term', full: cmd };
}

// ---- Problems in plain words ----------------------------------------------------------------------------------------

interface Problem { kind: 'warn' | 'info' | 'err'; icon: string; title: string; text: string; action?: 'setup' | 'retry' }
export function plainProblem(msg: string): Problem {
  if (/\b429\b|rate.?limit|quota|usage limit|too many requests|insufficient/i.test(msg)) {
    return { kind: 'warn', icon: 'clock', title: 'You have reached the limit of your plan or account', text: 'Wait a while, or use another sign-in. Your model and the conversation are kept.', action: 'setup' };
  }
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid.{0,24}(api.?key|token|x-api-key)|authenticat|expired|no api key|credentials/i.test(msg)) {
    return { kind: 'warn', icon: 'user', title: 'The sign-in does not work any more', text: 'Sign in again or enter the API key again. Your model and the conversation are kept.', action: 'setup' };
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket hang up|getaddrinfo/i.test(msg)) {
    return { kind: 'info', icon: 'wifioff', title: 'No connection to the AI service', text: 'SOMA AI needs the internet to think. Your model is not affected, SOMA still builds and shows it.', action: 'retry' };
  }
  if (/overloaded|\b5\d\d\b|unavailable|timed? ?out/i.test(msg)) {
    return { kind: 'info', icon: 'alert', title: 'The AI service is not answering right now', text: 'This usually passes in a few minutes.', action: 'retry' };
  }
  if (/no model|model not found|unknown model/i.test(msg)) {
    return { kind: 'warn', icon: 'alert', title: 'SOMA AI has no model to work with', text: 'Choose a sign-in, or pick another model below.', action: 'setup' };
  }
  return { kind: 'info', icon: 'alert', title: 'Something went wrong at the AI service', text: 'Try again. If it keeps happening, the details below say what the service answered.', action: 'retry' };
}

// ---- The chat ---------------------------------------------------------------------------------------------------------

/** `merged`: the step went into an earlier row of the same kind (grouped, "×3"), its own row is gone. */
interface StepRef { row: HTMLElement; ico: HTMLElement; label: HTMLElement; meta: HTMLElement; det: HTMLPreElement; link: HTMLButtonElement; tool: string; args: Json; state: string; merged?: boolean }
interface Attachment { data: string; mimeType: string; name: string }
type Phase = 'unavailable' | 'setup' | 'signing' | 'note' | 'chat';

export class SomaChat {
  readonly el: HTMLElement;
  private top: HTMLElement;
  private body: HTMLElement;
  private list: HTMLElement;
  /** Set-up, sign-in, the note: shown instead of the conversation, which stays as it is underneath. */
  private panel: HTMLElement;
  private composer: HTMLElement;
  private chips: HTMLElement;
  private input: HTMLTextAreaElement;
  /** Working indicator above the input: animated mark, changing word, time. */
  private status: HTMLElement;
  private statusWord: HTMLElement;
  private statusTime: HTMLElement;
  private runStart = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private nextWord = 0;
  private modelBtn: HTMLButtonElement;
  private sendBtn: HTMLButtonElement;
  private menu: HTMLElement;
  private fileInput: HTMLInputElement;

  private phase: Phase = 'setup';
  private accounts: AiAccount[] = [];
  /** Records of pi processes from before a model switch are ignored (main/somaai.ts numbers them). */
  private minGen = 0;
  private gen = 0;
  private piUp = false;
  private loaded = false;
  private running = false;
  private asking: string | null = null;
  private model: { provider: string; id: string; name: string } | null = null;
  private steps = new Map<string, StepRef>();
  private texts = new Map<number, HTMLElement>();
  /** Rows of the current turn by kind of step, for grouping (group()). A new message of the person starts a new turn. */
  private turnRows = new Map<string, HTMLElement>();
  private notes: { label: string; text: string }[] = [];
  private images: Attachment[] = [];
  private showing: Promise<void> | null = null;
  private showAgain = false;
  private signInUrl = '';
  /**
   * After a new sign-in: its recommended model, set once pi runs. A continued conversation keeps the model it had,
   * the new default in pi's settings alone would not change it.
   */
  private wantModel: { provider: string; modelId: string } | null = null;
  private starting: Promise<boolean> | null = null;
  /** Open question cards by request id: closed when the run ends without an answer (pi drops its dialogs then). */
  private closers = new Map<string, () => void>();

  constructor(private readonly deps: ChatDeps) {
    this.top = el('div', { className: 'ai-top' });
    this.list = el('div', { className: 'ai-list' });
    this.panel = el('div', { className: 'ai-panel' });
    this.body = el('div', { className: 'ai-body' }, this.panel, this.list);
    this.chips = el('div', { className: 'ai-chips' });
    this.input = el('textarea', { className: 'ai-input', rows: 2, placeholder: 'Describe what you want, or add a sketch or photo …' });
    this.input.setAttribute('aria-label', 'Message to SOMA AI');
    this.statusWord = el('span', { className: 'w' });
    this.statusTime = el('span', { className: 't' });
    this.status = el('div', { className: 'ai-status' }, el('span', { className: 'orb' }, icon('sparkle', 14, 2.2)), this.statusWord, this.statusTime,
      el('span', { className: 'grow' }), el('span', { className: 'k', textContent: 'Esc stops' }));
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;
    this.fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true });
    this.fileInput.hidden = true;
    const attach = el('button', { className: 'ibtn s', title: 'Add a photo or a sketch (or paste or drop a picture)' }, icon('clip', 17));
    attach.setAttribute('aria-label', 'Add a picture');
    attach.addEventListener('click', () => this.fileInput.click());
    this.modelBtn = el('button', { className: 'ai-model', title: 'Model. Recommended for the best results: Opus 5.5 or GPT-6 Astra' });
    this.modelBtn.addEventListener('click', () => void this.openModelMenu());
    this.sendBtn = el('button', { className: 'ai-send', title: 'Send (Enter)' });
    this.sendBtn.addEventListener('click', () => (this.running && !this.input.value.trim() && !this.notes.length && !this.images.length ? void this.stop() : void this.send()));
    this.composer = el('div', { className: 'ai-composer' }, this.chips, this.input,
      el('div', { className: 'ai-row' }, attach, this.fileInput, el('span', { className: 'grow' }), this.modelBtn, this.sendBtn));
    this.menu = el('div', { className: 'menu ai-menu' });
    this.menu.hidden = true;
    this.menu.setAttribute('role', 'menu');
    document.body.append(this.menu);
    this.el = el('div', { className: 'ai-pane' }, this.top, this.body, this.status, this.composer);
    this.el.hidden = true;

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void this.send(); }
      else if (e.key === 'Escape' && this.running) { e.preventDefault(); void this.stop(); }
    });
    this.input.addEventListener('input', () => this.fit());
    this.input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); void this.attach(files); }
    });
    this.fileInput.addEventListener('change', () => { void this.attach([...(this.fileInput.files ?? [])]); this.fileInput.value = ''; });
    // Pictures dropped on the chat go with the message. Other files take the usual way into inputs/ (main.ts)
    this.el.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length || !files.every((f) => f.type.startsWith('image/'))) return;
      e.preventDefault();
      e.stopPropagation();
      document.body.classList.remove('dragging');
      void this.attach(files);
    });
    deps.api.ai.onEvent((e) => this.onEvent(e));
    deps.api.ai.onExit((e) => this.onExit(e));
    deps.api.ai.onSignInUrl((url) => { this.signInUrl = url; if (this.phase === 'signing') this.renderSigning(); });
    this.renderComposer();
  }

  // ---- Lifecycle --------------------------------------------------------------------------------------------------

  /** Another model: an empty chat, pi of the old model is gone (main process). */
  reset(): void {
    this.minGen = this.gen + 1;
    this.piUp = false;
    this.loaded = false;
    this.running = false;
    clearInterval(this.ticker);
    this.runStart = 0;
    this.asking = null;
    this.closers.clear();
    this.model = null;
    this.steps.clear();
    this.turnRows.clear();
    this.texts.clear();
    this.list.replaceChildren();
    this.panel.replaceChildren();
    this.notes = [];
    this.images = [];
    this.input.value = '';
    this.renderChips();
    this.renderComposer();
    if (!this.el.hidden) void this.show();
  }

  /** The tab comes to the front: set up, the note, or the conversation of the model. */
  show(): Promise<void> {
    // Asked again while it is still deciding (two sign-outs in a row): decide once more afterwards, with what is true
    // now. Otherwise the second call got the first answer ("still signed in")
    if (this.showing) { this.showAgain = true; return this.showing; }
    this.showing = (async () => {
      do { this.showAgain = false; await this.decide(); } while (this.showAgain);
    })().finally(() => { this.showing = null; });
    return this.showing;
  }

  private async decide(): Promise<void> {
    const st = await this.deps.api.ai.status().catch(() => null);
    if (!st?.available) { this.renderUnavailable(); return; }
    this.accounts = await this.deps.api.ai.accounts().catch(() => []);
    if (this.phase === 'signing') return;
    if (!this.accounts.length) { this.renderSetup(false); return; }
    if (this.deps.store.get(NOTE_KEY) !== '1') { this.renderNote(); return; }
    await this.renderChat();
  }

  focus(): void { if (!this.input.disabled && this.phase === 'chat') this.input.focus(); }

  /** "Send to agent" (part, measurement, markup, file): a chip in the input, sent with the next message. */
  insert(text: string): void {
    const t = text.trim();
    if (!t) return;
    const label = (/^\[([^\]]{1,200})\]/.exec(t)?.[1] ?? t).replace(/\s+/g, ' ').slice(0, 48);
    this.notes.push({ label, text: t });
    this.renderChips();
    this.focus();
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.el.dataset.phase = p;
    this.panel.hidden = p === 'chat';
    this.list.hidden = p !== 'chat';
    this.renderComposer();
  }

  private emitState(): void {
    this.deps.onState(this.phase !== 'chat' && this.phase !== 'note' ? 'off' : this.asking ? 'wait' : this.running ? 'work' : 'idle');
  }

  // ---- Views ------------------------------------------------------------------------------------------------------

  private renderUnavailable(): void {
    this.setPhase('unavailable');
    this.top.replaceChildren();
    this.panel.replaceChildren(el('div', { className: 'ai-setup' },
      el('h3', { textContent: 'SOMA AI is not available' }),
      el('p', { className: 'lead', textContent: 'This installation of SOMA lacks the built-in agent. Reinstalling SOMA brings it back. Agents in a terminal still work: start one with + above.' })));
  }

  /** First start, or "Use another sign-in": ChatGPT, an API key, or a terminal agent (draft, slide 1). */
  private renderSetup(back: boolean): void {
    this.setPhase('setup');
    this.top.replaceChildren();
    const chatgpt = el('button', { className: 'btn primary', textContent: 'Sign in with ChatGPT' });
    chatgpt.addEventListener('click', () => void this.signIn());
    const key = keyForm({ api: this.deps.api, toast: this.deps.toast, saved: (provider) => this.accountsChanged(provider) });
    const term = el('button', { className: 'btn sm', textContent: 'Open a terminal' });
    term.addEventListener('click', () => this.deps.openTerminal());
    const backBtn = back ? el('button', { className: 'lnk ai-back' }, icon('left', 13, 2), 'Back to the conversation') : null;
    backBtn?.addEventListener('click', () => void this.show());
    this.panel.replaceChildren(el('div', { className: 'ai-setup' },
      backBtn,
      el('span', { className: 'ai-mark' }, icon('sparkle', 26, 1.8)),
      el('h3', { textContent: back ? 'Another sign-in' : 'Set up SOMA AI' }),
      el('p', { className: 'lead', textContent: 'SOMA AI builds the model for you from what you describe. It thinks with an AI service you choose, so it needs an account there. You only do this once.' }),
      el('div', { className: 'ai-rec' }, icon('sparkle', 13, 2), el('span', {}, 'For the best results we recommend ', el('b', { textContent: 'Opus 5.5' }), ' (Claude, with an API key) or ', el('b', { textContent: 'GPT-6 Astra' }), ' (with ChatGPT).')),
      el('div', { className: 'ai-opt rec' },
        el('h4', {}, icon('chat', 16), 'Sign in with ChatGPT', el('span', { className: 'badge', textContent: 'Recommended' })),
        el('p', { textContent: 'Uses your ChatGPT Plus or Pro plan. No extra cost, your plan’s limits apply.' }),
        el('div', { className: 'acts' }, chatgpt, el('span', { className: 'c3 small', textContent: 'Opens your browser' }))),
      el('div', { className: 'ai-opt' },
        el('h4', {}, icon('apikey', 16), 'Use an API key'),
        el('p', { textContent: 'Pay per use, billed by the provider. Works with Claude, OpenAI, Google Gemini, OpenRouter and OpenCode (Zen or Go).' }),
        ...key),
      el('div', { className: 'ai-or', textContent: 'or' }),
      el('div', { className: 'ai-opt plain' },
        el('h4', {}, icon('term', 16), 'I already use Claude Code or another agent'),
        el('p', { textContent: 'Start it in a terminal tab instead. SOMA works with it the same way.' }),
        el('div', { className: 'acts' }, term)),
      el('div', { className: 'ai-safe' }, icon('lock', 13), 'Your sign-in is stored on this computer only.')));
    this.emitState();
  }

  private async signIn(): Promise<void> {
    this.signInUrl = '';
    this.setPhase('signing');
    this.renderSigning();
    const r = await this.deps.api.ai.signIn().catch((e) => ({ ok: false, error: String(e), cancelled: false }));
    this.setPhase('setup');
    if (r.ok) { this.deps.toast('Signed in with ChatGPT.'); await this.accountsChanged(CHATGPT_PROVIDER); return; }
    this.renderSetup(this.accounts.length > 0);
    if (!r.cancelled) this.deps.toast(`Signing in did not work: ${r.error ?? 'unknown reason'}`, 'error');
  }

  private renderSigning(): void {
    const cancel = el('button', { className: 'btn sm', textContent: 'Cancel' });
    cancel.addEventListener('click', async () => {
      await this.deps.api.ai.cancelSignIn();
      // Nothing was running any more: back to where the chat is
      if (this.phase !== 'signing') void this.show();
    });
    const again = el('button', { className: 'lnk' }, 'Open the sign-in page again', icon('openext', 12, 2));
    again.hidden = !this.signInUrl;
    again.addEventListener('click', () => { if (this.signInUrl) void this.deps.api.openUrl(this.signInUrl); });
    this.top.replaceChildren();
    this.panel.replaceChildren(el('div', { className: 'ai-setup' },
      el('span', { className: 'ai-mark' }, icon('chat', 26, 1.8)),
      el('h3', { textContent: 'Finish signing in in your browser' }),
      el('p', { className: 'lead', textContent: 'SOMA opened the sign-in page of ChatGPT. Allow SOMA AI there, then come back here. This window updates by itself.' }),
      el('div', { className: 'ai-wait' }, ico('spin', 16, 2.4), el('span', { textContent: 'Waiting for the browser …' })),
      el('div', { className: 'acts' }, cancel, again)));
    this.emitState();
  }

  /** The note before the first message (draft, slide 2). The input stays locked until "Got it". */
  private renderNote(): void {
    this.setPhase('note');
    this.top.replaceChildren();
    const provider = this.accounts.map(accountLabel).join(' or ') || 'the AI service';
    const got = el('button', { className: 'btn primary', textContent: 'Got it' });
    got.addEventListener('click', () => { this.deps.store.set(NOTE_KEY, '1'); void this.show(); });
    const li = (ic: string, b: string, t: string) => el('li', {}, icon(ic, 15), el('span', {}, el('b', { textContent: b }), ` ${t}`));
    this.panel.replaceChildren(el('div', { className: 'ai-note' },
      el('h4', {}, icon('shield', 18), 'Before you start'),
      el('p', { textContent: 'SOMA AI works on your computer with your permissions. SOMA keeps it inside this model’s folder and stops commands that are known to be dangerous, but it can’t catch everything.' }),
      el('ul', {},
        li('history', 'It can make mistakes.', 'Every step is saved in the History, so you can go back. Files outside the model are not covered.'),
        li('file', 'Files can contain hidden instructions.', 'Only give it downloads, STEP files or PDFs from sources you trust.'),
        li('globe', 'Your data goes to the AI provider.', `What you type and the files it reads are sent to ${provider}.`),
        li('gauge', 'It uses your plan or credit.', 'Every request counts toward your plan’s limit or costs credit.')),
      el('div', { className: 'acts' }, got)));
    this.emitState();
    got.focus();
  }

  private async renderChat(): Promise<void> {
    const first = this.phase !== 'chat';
    this.setPhase('chat');
    this.renderTop();
    if (!this.loaded) {
      this.loaded = true;
      const started = await this.ensureStarted();
      if (started) {
        const r = await this.deps.api.ai.command({ type: 'get_messages' });
        if (r.ok) this.renderHistory(arr(obj(r.data).messages));
      }
    } else if (!this.piUp) {
      // Back after a new sign-in: pi starts with it, the chip shows its model
      await this.ensureStarted();
    }
    if (!this.list.childElementCount) this.renderWelcome();
    this.emitState();
    this.focus();
  }

  private renderTop(): void {
    const details = el('button', { className: 'lnk', textContent: 'Details' });
    details.addEventListener('click', () => { this.deps.store.set(NOTE_KEY, '0'); void this.show(); });
    const fresh = el('button', { className: 'ibtn s', title: 'New conversation' }, icon('chatplus', 16));
    fresh.setAttribute('aria-label', 'New conversation');
    fresh.addEventListener('click', () => void this.newConversation());
    const past = el('button', { className: 'ibtn s', title: 'Earlier conversations' }, icon('history', 16));
    past.setAttribute('aria-label', 'Earlier conversations');
    past.addEventListener('click', () => void this.openSessions(past));
    const more = el('button', { className: 'ibtn s', title: 'Sign-in' }, icon('more', 16));
    more.setAttribute('aria-label', 'Sign-in and more');
    more.addEventListener('click', () => this.openAccountMenu(more));
    this.top.replaceChildren(el('span', { className: 'ai-safe' }, icon('shield', 13), 'Works with your permissions · ', details),
      el('span', { className: 'grow' }), past, fresh, more);
  }

  private renderWelcome(): void {
    const sugg = SUGGESTIONS.map((s) => {
      const b = el('button', { className: 'ai-sugg' }, icon(s.icon, 16), el('span', {}, s.text, s.sub ? el('span', { className: 'sub', textContent: s.sub }) : null));
      b.addEventListener('click', () => {
        this.input.value = s.text;
        this.fit();
        if (s.attach) this.fileInput.click(); else this.input.focus();
      });
      return b;
    });
    this.list.replaceChildren(el('div', { className: 'ai-welcome' },
      el('h3', { textContent: 'What do you want to make?' }),
      el('p', { textContent: 'Describe it in your own words, or add a photo of a sketch. SOMA AI writes the model and you see it on the left right away.' }),
      el('div', { className: 'ai-suggs' }, ...sugg)));
  }

  private renderComposer(): void {
    const chat = this.phase === 'chat';
    this.composer.hidden = this.phase !== 'chat' && this.phase !== 'note';
    const locked = !chat || !!this.asking;
    this.input.disabled = locked;
    this.input.placeholder = this.phase === 'note' ? 'Read the note above first'
      : this.asking ? 'SOMA AI is waiting for your answer above'
        : this.running ? 'Add something, SOMA AI reads it after the current step …' : 'Describe what you want, or add a sketch or photo …';
    this.composer.classList.toggle('locked', locked);
    this.renderStatus();
    const typed = !!(this.input.value.trim() || this.notes.length || this.images.length);
    const stop = this.running && !typed;
    this.sendBtn.replaceChildren(icon(stop ? 'stop' : 'arrowup', 16, 2.2));
    this.sendBtn.classList.toggle('stop', stop);
    this.sendBtn.title = stop ? 'Stop SOMA AI' : 'Send (Enter)';
    this.sendBtn.setAttribute('aria-label', this.sendBtn.title);
    this.sendBtn.disabled = locked || (!stop && !typed);
    this.modelBtn.replaceChildren(el('span', { textContent: this.model?.name ?? 'Model' }), icon('down', 12, 2));
    this.modelBtn.hidden = !this.model;
    this.emitState();
  }

  private renderChips(): void {
    const kids: HTMLElement[] = [];
    this.notes.forEach((n, i) => {
      const x = el('button', { className: 'x', title: 'Remove' }, icon('x', 11, 2.2));
      x.addEventListener('click', () => { this.notes.splice(i, 1); this.renderChips(); });
      kids.push(el('span', { className: 'ai-chip acc', title: n.text }, icon('send', 12, 2), el('span', { textContent: n.label }), x));
    });
    this.images.forEach((m, i) => {
      const x = el('button', { className: 'x', title: 'Remove' }, icon('x', 11, 2.2));
      x.addEventListener('click', () => { this.images.splice(i, 1); this.renderChips(); });
      kids.push(el('span', { className: 'ai-chip', title: m.name }, el('img', { src: `data:${m.mimeType};base64,${m.data}`, alt: '' }), el('span', { textContent: m.name }), x));
    });
    this.chips.replaceChildren(...kids);
    this.chips.hidden = !kids.length;
    this.renderComposer();
  }

  private fit(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 200)}px`;
    this.renderComposer();
  }

  private async attach(files: File[]): Promise<void> {
    for (const f of files) {
      if (!f.type.startsWith('image/')) { this.deps.toast(`${f.name} is not a picture. Other files go into the model with Import.`, 'info'); continue; }
      if (f.size > MAX_IMAGE) { this.deps.toast(`${f.name} is larger than 8 MB.`, 'info'); continue; }
      const data = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
        r.onerror = () => resolve('');
        r.readAsDataURL(f);
      });
      if (data) this.images.push({ data, mimeType: f.type, name: f.name || 'Picture' });
    }
    this.renderChips();
    this.focus();
  }

  // ---- Talking to pi ----------------------------------------------------------------------------------------------

  /** Starts pi if needed, learns the model. False with a problem in the chat when it does not start. */
  private ensureStarted(): Promise<boolean> {
    // pi's first records can arrive before the start has chosen the model: piUp alone does not mean ready
    if (this.piUp && !this.starting) return Promise.resolve(true);
    // One start at a time (the chat and the model menu can ask at once)
    this.starting ??= this.startPi().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startPi(): Promise<boolean> {
    const r = await this.deps.api.ai.start();
    if (!r.ok) { this.problem(r.error ?? 'SOMA AI did not start.', true); return false; }
    const st = r.data ? r : await this.deps.api.ai.command({ type: 'get_state' });
    let model = obj(obj(st.data).model);
    const want = this.wantModel;
    this.wantModel = null;
    if (want && (str(model.provider) !== want.provider || str(model.id) !== want.modelId)) {
      // Not in the plan or not offered any more: pi's choice stays
      const s = await this.deps.api.ai.command({ type: 'set_model', provider: want.provider, modelId: want.modelId });
      if (s.ok) model = obj(s.data);
    }
    // Once, at the end: the chip never shows the model of the old sign-in for a moment
    this.setModel(model);
    this.piUp = true;
    return true;
  }

  /** Remember the recommended model of a provider just signed in to (none for some: pi's choice then). */
  private useRecommended(provider: string): void {
    const modelId = RECOMMENDED_MODEL[provider];
    this.wantModel = modelId ? { provider, modelId } : null;
  }

  /**
   * A sign-in was added or removed (here or in Settings > SOMA AI): pi of the open model has been ended by then
   * (main.ts), the next start takes the new sign-in. `provider`: just signed in, its recommended model is chosen.
   */
  async accountsChanged(provider?: string, refresh = true): Promise<void> {
    if (provider) this.useRecommended(provider);
    this.piUp = false;
    if (refresh) await this.show();
  }

  /**
   * Another model, from the model menu or Settings > SOMA AI: at once when pi runs, otherwise at its next start (a
   * continued conversation would keep its own model).
   */
  async useModel(provider: string, modelId: string): Promise<void> {
    if (!this.piUp) { this.wantModel = { provider, modelId }; return; }
    const s = await this.deps.api.ai.command({ type: 'set_model', provider, modelId });
    if (s.ok) this.setModel(obj(s.data));
    else this.deps.toast(s.error ?? 'The model could not be changed.', 'error');
  }

  /**
   * Settings > SOMA AI, "Show again": the note before the first message comes back before the next one. `refresh`:
   * the tab is in front with a model open (main.ts), it shows the note right away.
   */
  showNote(refresh: boolean): void {
    this.deps.store.set(NOTE_KEY, '0');
    if (refresh) void this.show();
  }

  /** Signed in and past the set-up (the tutorial words its step after it). */
  get setUp(): boolean { return this.phase === 'chat' || this.phase === 'note'; }

  private setModel(m: Json): void {
    this.model = str(m.id) ? { provider: str(m.provider), id: str(m.id), name: str(m.name) || str(m.id) } : null;
    this.renderComposer();
  }

  async send(): Promise<void> {
    if (this.phase !== 'chat' || this.asking) return;
    const typed = this.input.value.trim();
    const message = [...this.notes.map((n) => n.text), typed].filter(Boolean).join('\n');
    if (!message && !this.images.length) return;
    if (!(await this.ensureStarted())) return;
    const cmd: Json = { type: 'prompt', message: message || 'Here is a picture.' };
    if (this.images.length) cmd.images = this.images.map((m) => ({ type: 'image', data: m.data, mimeType: m.mimeType }));
    if (this.running) cmd.streamingBehavior = 'steer';
    const r = await this.deps.api.ai.command(cmd);
    if (!r.ok) { this.problem(r.error ?? 'The message did not reach SOMA AI.', false); return; }
    this.input.value = '';
    this.notes = [];
    this.images = [];
    this.renderChips();
    this.fit();
  }

  private async stop(): Promise<void> {
    await this.deps.api.ai.command({ type: 'abort' });
  }

  private async newConversation(): Promise<void> {
    if (this.running) await this.stop();
    if (!(await this.ensureStarted())) return;
    const r = await this.deps.api.ai.command({ type: 'new_session' });
    if (!r.ok) { this.deps.toast(r.error ?? 'A new conversation could not start.', 'error'); return; }
    this.steps.clear();
    this.turnRows.clear();
    this.texts.clear();
    this.renderWelcome();
  }

  /**
   * "Earlier conversations" (wish of the user): back to a conversation of this model, the newest first, with a search.
   * pi continues it where it ended, with its model.
   */
  private async openSessions(anchor: HTMLElement): Promise<void> {
    if (menus.isOpen(this.menu)) { menus.close(); return; }
    const [r, st] = await Promise.all([
      this.deps.api.ai.sessions().catch((e) => ({ ok: false, error: String(e), sessions: undefined })),
      this.piUp ? this.deps.api.ai.command({ type: 'get_state' }) : Promise.resolve(null),
    ]);
    if (!r.ok) { this.deps.toast(r.error ?? 'The conversations could not be listed.', 'error'); return; }
    const now = str(obj(st?.data).sessionId);
    searchMenu(this.menu, anchor, [{
      title: 'EARLIER CONVERSATIONS', scroll: true,
      entries: (r.sessions ?? []).map((s) => {
        const title = s.title || 'A picture without words';
        return {
          label: title.length > 70 ? `${title.slice(0, 69)}…` : title, sub: fmtWhen(s.modified, true), find: title, on: s.id === now,
          onClick: () => { if (s.id !== now) void this.switchTo(s.id); },
        };
      }),
    }], { placeholder: 'Search conversations …', empty: 'No conversations in this model yet.', align: 'right' });
  }

  private async switchTo(id: string): Promise<void> {
    if (this.running) await this.stop();
    const r = await this.deps.api.ai.switchSession(id);
    if (!r.ok) { this.deps.toast(r.error ?? 'The conversation could not be opened.', 'error'); return; }
    if (obj(r.data).cancelled === true) return;
    // main.ts started pi for it if needed
    this.piUp = true;
    this.closeQuestions();
    const m = await this.deps.api.ai.command({ type: 'get_messages' });
    if (m.ok) this.renderHistory(arr(obj(m.data).messages));
    if (!this.list.childElementCount) this.renderWelcome();
    const s = await this.deps.api.ai.command({ type: 'get_state' });
    if (s.ok) this.setModel(obj(obj(s.data).model));
    this.focus();
  }

  private openAccountMenu(anchor: HTMLElement): void {
    const items: HTMLElement[] = [el('div', { className: 'mh', textContent: 'SIGNED IN' })];
    for (const a of this.accounts) {
      items.push(menuItem(`Sign out of ${accountLabel(a)}`, { icon: 'user', sub: a.type === 'oauth' ? 'Account' : 'API key', onClick: () => void this.signOut(a) }));
    }
    items.push(el('div', { className: 'msep' }), menuItem('Use another sign-in …', { icon: 'apikey', onClick: () => this.renderSetup(true) }));
    this.menu.onkeydown = null;
    this.menu.replaceChildren(...items);
    menus.toggle(this.menu, anchor, 'right');
  }

  private async signOut(a: AiAccount): Promise<void> {
    const r = await this.deps.api.ai.signOut(a.provider);
    if (!r.ok) { this.deps.toast(r.error ?? 'Signing out did not work.', 'error'); return; }
    this.deps.toast(`Signed out of ${accountLabel(a)}.`);
    this.piUp = false;
    this.model = null;
    await this.show();
  }

  private async openModelMenu(): Promise<void> {
    if (menus.isOpen(this.menu)) { menus.close(); return; }
    if (!(await this.ensureStarted())) return;
    const r = await this.deps.api.ai.command({ type: 'get_available_models' });
    const models = arr(obj(r.data).models).map(obj).map((m) => ({ provider: str(m.provider), id: str(m.id), name: str(m.name) || str(m.id) }));
    showModelMenu(this.menu, this.modelBtn, models, this.model, (m) => void this.useModel(m.provider, m.id));
  }

  // ---- Records of pi ---------------------------------------------------------------------------------------------

  private onEvent(e: AiEvent): void {
    if (e.gen < this.minGen) return;
    this.gen = Math.max(this.gen, e.gen);
    this.piUp = true;
    const r = e.record;
    switch (r.type) {
      case 'agent_start': this.setRunning(true); break;
      case 'agent_settled': this.closeQuestions(); this.setRunning(false); this.settleSteps(); break;
      case 'message_start': this.messageStart(obj(r.message)); break;
      case 'message_update': this.messageUpdate(obj(r.assistantMessageEvent)); break;
      case 'message_end': this.messageEnd(obj(r.message)); break;
      case 'tool_execution_start': this.toolStart(str(r.toolCallId), str(r.toolName), obj(r.args)); break;
      case 'tool_execution_end': this.toolEnd(str(r.toolCallId), resultText(r.result), r.isError === true); break;
      case 'extension_ui_request': this.uiRequest(r); break;
      case 'compaction_start': this.quiet('info', 'The conversation is getting long. SOMA AI is summarizing the older part to keep going.'); break;
      case 'auto_retry_start': this.quiet('refresh', 'The AI service did not answer. SOMA AI tries again …'); break;
      default: break;
    }
  }

  private onExit(e: AiExit): void {
    if (e.gen < this.minGen) return;
    this.piUp = false;
    this.closeQuestions();
    this.setRunning(false);
    this.settleSteps();
    if (e.error) this.problem(e.error, true);
    this.renderComposer();
  }

  private setRunning(on: boolean): void {
    if (on && !this.running) {
      this.runStart = Date.now();
      this.nextWord = 0;
      clearInterval(this.ticker);
      this.ticker = setInterval(() => this.renderStatus(), 1000);
    }
    if (!on && this.running) {
      clearInterval(this.ticker);
      this.ticker = undefined;
      // How long it took, at the end of the turn (like Claude Code's "Worked for …")
      if (this.runStart) this.quiet('clock', `Worked for ${duration(Date.now() - this.runStart)}`);
      this.runStart = 0;
    }
    this.running = on;
    if (on) this.list.querySelector('.ai-welcome')?.remove();
    this.renderComposer();
  }

  /** The working indicator: a new word every few seconds, the time each second. Waiting for an answer says so. */
  private renderStatus(): void {
    const on = this.running && this.phase === 'chat';
    this.status.hidden = !on;
    if (!on) return;
    this.status.classList.toggle('waiting', !!this.asking);
    const now = Date.now();
    if (this.asking) this.statusWord.textContent = 'Waiting for your answer';
    else if (now >= this.nextWord || this.statusWord.textContent === 'Waiting for your answer') {
      const old = this.statusWord.textContent;
      let w = old;
      while (w === old) w = `${WORKING[Math.floor(Math.random() * WORKING.length)]} …`;
      this.statusWord.textContent = w;
      // The fade-in again for the new word
      this.statusWord.style.animation = 'none';
      void this.statusWord.offsetWidth;
      this.statusWord.style.animation = '';
      this.nextWord = now + 3500;
    }
    this.statusTime.textContent = this.runStart ? `· ${duration(now - this.runStart)}` : '';
  }

  private append(node: HTMLElement): void {
    this.list.querySelector('.ai-welcome')?.remove();
    const stick = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 60;
    this.list.append(node);
    if (stick) this.body.scrollTop = this.body.scrollHeight;
  }

  private messageStart(m: Json): void {
    if (m.role === 'user') { this.turnRows.clear(); this.append(this.userBubble(m.content)); }
    else if (m.role === 'assistant') this.texts.clear();
  }

  private messageUpdate(ev: Json): void {
    const i = Number(ev.contentIndex ?? 0);
    switch (ev.type) {
      case 'text_start': case 'text_delta': {
        let t = this.texts.get(i);
        if (!t) { t = el('div', { className: 'ai-msg' }, this.who(), el('div', { className: 'ai-text' })); this.texts.set(i, t); this.append(t); }
        const body = t.querySelector('.ai-text');
        if (body && ev.type === 'text_delta') body.textContent += str(ev.delta);
        break;
      }
      case 'text_end': this.texts.get(i)?.querySelector('.ai-text')?.replaceWith(this.markdown(str(ev.content))); break;
      case 'toolcall_start': if (ev.toolName !== 'ask_user') this.ensureStep(str(ev.id), str(ev.toolName), {}); break;
      case 'toolcall_end': {
        const call = obj(ev.toolCall);
        if (call.name === 'ask_user') break;
        const ref = this.ensureStep(str(call.id), str(call.name), obj(call.arguments));
        ref.args = obj(call.arguments);
        this.paintStep(ref, ref.state === 'run' ? 'run' : ref.state);
        break;
      }
      default: break;
    }
  }

  private messageEnd(m: Json): void {
    if (m.role !== 'assistant') return;
    // Text that came without deltas, and the authoritative final text
    arr(m.content).map(obj).forEach((c, i) => {
      if (c.type !== 'text' || !str(c.text).trim()) return;
      const t = this.texts.get(i);
      if (t) t.querySelector('.ai-text, .md')?.replaceWith(this.markdown(str(c.text)));
      else { const n = el('div', { className: 'ai-msg' }, this.who(), this.markdown(str(c.text))); this.texts.set(i, n); this.append(n); }
    });
    if (m.stopReason === 'error') this.problem(str(m.errorMessage) || 'The AI service reported an error.', false);
    else if (m.stopReason === 'aborted') this.quiet('stop', 'You stopped SOMA AI. What it did up to here is kept and in the History.');
  }

  private toolStart(id: string, tool: string, args: Json): void {
    if (tool === 'ask_user') return;
    const ref = this.ensureStep(id, tool, args);
    ref.args = Object.keys(args).length ? args : ref.args;
    this.paintStep(ref, 'run');
  }

  private toolEnd(id: string, text: string, isError: boolean): void {
    const ref = this.steps.get(id);
    if (!ref) return;
    const stop = stoppedBy(text);
    ref.det.textContent = `${this.detailOf(ref)}\n\n${text.slice(0, 6000)}`.trim();
    if (stop) this.paintStep(ref, stop.by === 'user' ? 'denied' : 'stopped', stop.reason);
    else this.paintStep(ref, isError ? 'fail' : 'ok');
  }

  /**
   * The run ended (stopped with Esc, pi ended) while a question was open: pi forgets its dialog without a record, so
   * the card says so and the input is free again.
   */
  private closeQuestions(): void {
    for (const close of this.closers.values()) close();
    this.closers.clear();
    if (this.asking) { this.asking = null; this.renderComposer(); }
  }

  /** A step that was still running when the run ended (stopped, crashed): no spinner forever. */
  private settleSteps(): void {
    for (const ref of this.steps.values()) if (ref.state === 'run') this.paintStep(ref, 'fail');
  }

  private ensureStep(id: string, tool: string, args: Json): StepRef {
    const known = this.steps.get(id);
    if (known) return known;
    const ico = el('span', { className: 'si' });
    const label = el('b');
    const meta = el('span', { className: 'meta' });
    const det = el('pre', { className: 'ai-det' });
    det.hidden = true;
    const link = el('button', { className: 'lnk' });
    link.addEventListener('click', () => { det.hidden = !det.hidden; });
    const row = el('div', { className: 'ai-step' }, el('div', { className: 'ai-step-row' }, ico, el('span', { className: 'tx' }, label, meta), link), det);
    const ref: StepRef = { row, ico, label, meta, det, link, tool, args, state: 'run' };
    this.steps.set(id, ref);
    const last = this.list.lastElementChild;
    if (last?.classList.contains('ai-steps')) last.append(row);
    else this.append(el('div', { className: 'ai-steps' }, row));
    return ref;
  }

  private detailOf(ref: StepRef): string {
    if (ref.tool === 'bash') return `$ ${str(ref.args.command)}`;
    if (ref.tool === 'write') return `${str(ref.args.path)}\n\n${str(ref.args.content).slice(0, 6000)}`;
    if (ref.tool === 'edit') return `${str(ref.args.path)}\n\n${arr(ref.args.edits).map(obj).map((e) => `- ${str(e.oldText)}\n+ ${str(e.newText)}`).join('\n\n').slice(0, 6000)}`;
    return [str(ref.args.path), JSON.stringify(ref.args)].filter(Boolean)[0];
  }

  private paintStep(ref: StepRef, state: string, reason = ''): void {
    if (ref.merged) return;
    ref.state = state;
    const w = stepWords(ref.tool, ref.args);
    const ic: Record<string, [string, number]> = { run: ['spin', 2.4], ok: ['check', 2.2], fail: ['refresh', 2], stopped: ['shield', 1.9], denied: ['shield', 1.9] };
    const [name, sw] = ic[state] ?? ['check', 2];
    ref.ico.replaceChildren(ico(name, 15, sw));
    ref.row.dataset.state = state;
    ref.label.textContent = state === 'run' ? (Object.keys(ref.args).length ? w.run : 'Getting ready …')
      : state === 'ok' ? w.done : state === 'fail' ? w.fail
        : state === 'denied' ? `You did not allow this: ${w.run.replace(/ …$/, '').toLowerCase()}`
          // The reason is written for the agent ("Make a new commit instead"), it stays under Details
          : `SOMA stopped this: ${w.run.replace(/ …$/, '').toLowerCase()}. SOMA AI was told why${reason ? '' : ''} and will do it another way.`;
    ref.meta.textContent = state === 'ok' && w.meta ? ` · ${w.meta}` : '';
    ref.link.textContent = ref.tool === 'write' || ref.tool === 'edit' ? 'Show changes' : 'Details';
    if (!ref.det.textContent) ref.det.textContent = this.detailOf(ref);
    if (state !== 'run') this.group(ref);
  }

  /**
   * Steps of the same kind in one block become one row with a count ("Changed model.py ×5"), wish of the user: complex
   * work would otherwise give an endless list. The details keep every single step.
   */
  private group(ref: StepRef): void {
    if (ref.merged) return;
    const key = `${ref.state}|${ref.label.textContent}`;
    ref.row.dataset.key = key;
    // Within the whole turn: SOMA AI often writes a sentence between its steps, which starts a new block
    const before = this.turnRows.get(key);
    this.turnRows.set(key, ref.row);
    if (!before || before === ref.row || !before.isConnected) return;
    // The row moves to the latest step of its kind, where the work is happening
    const n = Number(before.dataset.count ?? '1') + 1;
    ref.row.dataset.count = String(n);
    ref.meta.textContent = ` ×${n}`;
    ref.det.textContent = `${before.querySelector('.ai-det')?.textContent ?? ''}\n\n────────\n\n${ref.det.textContent}`;
    const box = before.parentElement;
    before.remove();
    if (box && !box.childElementCount) box.remove();
  }

  private who(): HTMLElement {
    return el('div', { className: 'ai-who' }, el('span', { className: 'av' }, icon('sparkle', 12, 2)), 'SOMA AI');
  }

  private markdown(src: string): HTMLElement {
    return renderMarkdown(src, '', true, {
      link: (href) => { if (/^https?:\/\//i.test(href)) void this.deps.api.openUrl(href); },
      image: async () => null,
      toggleTask: () => {},
      edit: () => {},
    });
  }

  private userBubble(content: unknown): HTMLElement {
    const box = el('div', { className: 'ai-user' });
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : arr(content).map(obj);
    const pics = parts.filter((p) => p.type === 'image' && str(p.data)).map((p) =>
      el('img', { src: `data:${str(p.mimeType) || 'image/png'};base64,${str(p.data)}`, alt: 'Picture sent to SOMA AI' }));
    if (pics.length) box.append(el('div', { className: 'pics' }, ...pics));
    const text = parts.filter((p) => p.type === 'text').map((p) => str(p.text)).join('\n').trim();
    if (text) box.append(el('div', { className: 'tx', textContent: text }));
    return box;
  }

  private renderHistory(messages: unknown[]): void {
    this.list.replaceChildren();
    this.steps.clear();
    this.turnRows.clear();
    const results = new Map<string, { text: string; isError: boolean; details: Json }>();
    for (const m of messages.map(obj)) if (m.role === 'toolResult') results.set(str(m.toolCallId), { text: resultText(m), isError: m.isError === true, details: obj(m.details) });
    for (const m of messages.map(obj)) {
      if (m.role === 'user') { this.turnRows.clear(); this.append(this.userBubble(m.content)); }
      else if (m.role === 'assistant') {
        for (const c of arr(m.content).map(obj)) {
          if (c.type === 'text' && str(c.text).trim()) this.append(el('div', { className: 'ai-msg' }, this.who(), this.markdown(str(c.text))));
          else if (c.type === 'toolCall' && c.name === 'ask_user') {
            for (const line of askedLines(obj(c.arguments), results.get(str(c.id))?.details ?? {})) this.quiet('help', line);
          } else if (c.type === 'toolCall') {
            const ref = this.ensureStep(str(c.id), str(c.name), obj(c.arguments));
            const res = results.get(str(c.id));
            if (res) this.toolEnd(str(c.id), res.text, res.isError); else this.paintStep(ref, 'fail');
          }
        }
        if (m.stopReason === 'error') this.problem(str(m.errorMessage), false);
      } else if (m.role === 'compactionSummary') this.quiet('info', 'The older part of this conversation was summarized.');
    }
    this.body.scrollTop = this.body.scrollHeight;
  }

  // ---- Questions and messages -------------------------------------------------------------------------------------

  private uiRequest(r: Json): void {
    const id = str(r.id);
    const method = str(r.method);
    if (method === 'select' && /^Permission Required/.test(str(r.title))) { this.permission(id, str(r.title), arr(r.options).map(String)); return; }
    if (method === 'input' && str(r.title).startsWith(ASK_MARK)) {
      const qs = askQuestions(str(r.title).slice(ASK_MARK.length));
      // Nothing sensible to show: skipped, SOMA AI decides itself (the tool tells it so)
      if (qs.length) this.agentQuestions(id, qs); else this.deps.api.ai.respond({ id, cancelled: true });
      return;
    }
    if (method === 'select' || method === 'confirm') { this.genericQuestion(id, method, str(r.title), str(r.message), arr(r.options).map(String)); return; }
    if (method === 'input' || method === 'editor') { this.deps.api.ai.respond({ id, cancelled: true }); return; }
    // Notes of extensions are written for programmers ("project is not trusted — skipping project-scoped permission
    // configuration" on every start, because SOMA never loads rules from a model folder). Into the log, not the chat
    if (method === 'notify' && str(r.message)) console.warn(`[somaai] note of an extension: ${str(r.message).slice(0, 300)}`);
  }

  /** A question of the permission extension, in plain words (draft, slides 5 and 8). No button is highlighted. */
  private permission(id: string, title: string, options: string[]): void {
    const q = plainQuestion(questionFacts(title));
    const yes = options.find((o) => o === 'Yes');
    const session = options.find((o) => /^Yes, allow/.test(o));
    const no = options.find((o) => o === 'No') ?? options.find((o) => /^No/.test(o));
    const det = el('pre', { className: 'ai-det', textContent: title });
    det.hidden = true;
    const detBtn = el('button', { className: 'ai-detbtn' }, icon('right', 13, 2), 'Details');
    detBtn.addEventListener('click', () => { det.hidden = !det.hidden; detBtn.replaceChildren(icon(det.hidden ? 'right' : 'down', 13, 2), 'Details'); });
    const card = el('div', { className: 'ai-ask' });
    card.dataset.raw = title;
    const answer = (value: string | undefined, said: string) => {
      if (this.asking !== id) return;
      this.deps.api.ai.respond(value ? { id, value } : { id, cancelled: true });
      this.asking = null;
      this.closers.delete(id);
      card.classList.add('done');
      acts.replaceChildren(el('span', { className: 'c3 small', textContent: said }));
      this.renderComposer();
    };
    const btn = (label: string, value: string | undefined, said: string) => {
      const b = el('button', { className: 'btn', textContent: label });
      b.addEventListener('click', () => answer(value, said));
      return b;
    };
    const acts = el('div', { className: 'acts' },
      btn('Don’t allow', no, 'Not allowed. SOMA AI was told and will try another way.'),
      session ? btn('Allow until I close the model', session, 'Allowed until you close the model.') : null,
      btn('Allow', yes, 'Allowed once.'));
    card.append(
      el('h4', {}, icon(q.icon, 18), el('span', { textContent: q.title })),
      el('div', { className: 'in' }, el('div', { className: 'what', title: q.full }, el('span', { className: 'c3' }, icon(q.whatIcon, 14)), el('span', { textContent: q.what }))),
      acts, detBtn, det);
    this.asking = id;
    this.closers.set(id, () => { card.classList.add('done'); acts.replaceChildren(el('span', { className: 'c3 small', textContent: 'Not answered: SOMA AI stopped.' })); });
    this.append(card);
    this.renderComposer();
  }

  /**
   * Questions of SOMA AI (tool ask_user, resources/somaai/soma.ts), like AskUserQuestion in Claude Code: all questions
   * of one call in one card, answered together (wish of the user: not one after the other). Answers to click with what
   * they mean, and an own answer for each question. One question with one answer to pick: a click sends it. The input
   * below stays locked until the card is answered.
   */
  private agentQuestions(id: string, qs: AskQ[]): void {
    const card = el('div', { className: 'ai-ask ai-q' });
    const one = qs.length === 1;
    const picks = qs.map(() => new Set<string>());
    const owns: HTMLInputElement[] = [];
    const paints: (() => void)[] = [];
    const answered = (i: number) => picks[i].size > 0 || !!owns[i].value.trim();
    const send = el('button', { className: 'btn sm acc', textContent: one ? 'Send' : 'Send answers' });
    const skip = el('button', { className: 'lnk', textContent: 'Skip' });
    const refresh = () => {
      send.disabled = !qs.some((_, i) => answered(i));
      paints.forEach((p) => p());
    };
    const done = (sending: boolean) => {
      if (this.asking !== id) return;
      const answers = qs.map((_, i) => (sending && answered(i) ? { picked: [...picks[i]], own: owns[i].value.trim() } : null));
      // In the order of the call: a question the card left out (no text) counts as skipped
      const inOrder: (typeof answers[number])[] = Array.from({ length: Math.max(...qs.map((q) => q.at)) + 1 }, () => null);
      qs.forEach((q, i) => { inOrder[q.at] = answers[i]; });
      this.deps.api.ai.respond(sending ? { id, value: JSON.stringify({ answers: inOrder }) } : { id, cancelled: true });
      this.asking = null;
      this.closers.delete(id);
      card.classList.add('done');
      const words = answers.map((a) => (a ? [...a.picked, ...(a.own ? [a.own] : [])].join(', ') : ''));
      const line = (ok: boolean, text: string) => el('div', { className: ok ? 'answer' : 'answer skipped' }, icon(ok ? 'check' : 'x', 14, 2.2), el('span', { textContent: text }));
      body.replaceChildren(...(one || words.every((w) => !w)
        ? [line(!!words[0], words[0] ? `You answered: ${words[0]}` : `You skipped ${one ? 'this question' : 'these questions'}.`)]
        : qs.map((q, i) => line(!!words[i], `${q.header || q.question} ${words[i] ? `→ ${words[i]}` : '→ skipped'}`))));
      this.renderComposer();
    };
    const blocks = qs.map((q, i) => {
      const btns = q.options.map((o) => {
        const b = el('button', { className: 'ai-ans' }, el('b', { textContent: o.label }), o.description ? el('span', { textContent: o.description }) : null);
        b.addEventListener('click', () => {
          if (one && !q.multi) { picks[i] = new Set([o.label]); owns[i].value = ''; done(true); return; }
          if (q.multi) { if (!picks[i].delete(o.label)) picks[i].add(o.label); } else { picks[i] = new Set([o.label]); owns[i].value = ''; }
          refresh();
        });
        return [o.label, b] as const;
      });
      paints.push(() => { for (const [label, b] of btns) { b.classList.toggle('on', picks[i].has(label)); b.setAttribute('aria-pressed', String(picks[i].has(label))); } });
      const own = el('input', { className: 'ai-field grow', placeholder: q.multi ? 'Something else, in your own words …' : 'Or in your own words …' });
      own.setAttribute('aria-label', `Your own answer: ${q.question}`);
      own.addEventListener('input', () => { if (!q.multi && own.value.trim()) picks[i].clear(); refresh(); });
      // Enter: on to the next question without an answer, after the last one send
      own.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const next = owns.find((_, j) => j > i && !answered(j));
        if (next) next.focus(); else if (!send.disabled) done(true);
      });
      owns.push(own);
      return el('div', { className: 'ai-qblock' },
        one ? null : el('div', { className: 'ai-qtext' }, q.header ? el('span', { className: 'ai-qhead', textContent: q.header }) : null, el('span', { textContent: q.question })),
        q.multi ? el('div', { className: 'ai-qhint', textContent: 'Pick one or more.' }) : null,
        // Answers without an explanation side by side: short ones ("PLA", "PETG") would waste the narrow column
        el('div', { className: q.options.some((o) => o.description) ? 'ai-answers' : 'ai-answers inline' }, ...btns.map(([, b]) => b)),
        el('div', { className: 'ai-own' }, own, one ? send : null, one ? skip : null));
    });
    send.addEventListener('click', () => done(true));
    skip.addEventListener('click', () => done(false));
    const body = el('div', { className: 'ai-qbody' }, ...blocks, one ? null : el('div', { className: 'ai-qacts' }, send, skip));
    card.append(el('h4', {}, icon('help', 18), el('span', { textContent: one ? qs[0].question : `SOMA AI has ${qs.length} questions` })), body);
    refresh();
    this.asking = id;
    this.closers.set(id, () => {
      card.classList.add('done');
      body.replaceChildren(el('div', { className: 'answer skipped' }, icon('x', 14, 2.2), el('span', { textContent: 'Not answered: SOMA AI stopped.' })));
    });
    this.append(card);
    this.renderComposer();
  }

  private genericQuestion(id: string, method: string, title: string, message: string, options: string[]): void {
    const card = el('div', { className: 'ai-ask' });
    const acts = el('div', { className: 'acts' });
    const done = (res: { value?: string; confirmed?: boolean; cancelled?: boolean }, said: string) => {
      if (this.asking !== id) return;
      this.deps.api.ai.respond({ id, ...res });
      this.asking = null;
      this.closers.delete(id);
      card.classList.add('done');
      acts.replaceChildren(el('span', { className: 'c3 small', textContent: said }));
      this.renderComposer();
    };
    const buttons = method === 'confirm'
      ? [['No', () => done({ confirmed: false }, 'No.')], ['Yes', () => done({ confirmed: true }, 'Yes.')]] as const
      : options.slice(0, 4).map((o) => [o, () => done({ value: o }, o)] as const);
    for (const [label, fn] of buttons) { const b = el('button', { className: 'btn', textContent: label }); b.addEventListener('click', fn); acts.append(b); }
    card.append(el('h4', {}, icon('help', 18), el('span', { textContent: title || 'SOMA AI asks' })));
    if (message) card.append(el('div', { className: 'in', textContent: message }));
    card.append(acts);
    this.asking = id;
    this.closers.set(id, () => { card.classList.add('done'); acts.replaceChildren(el('span', { className: 'c3 small', textContent: 'Not answered: SOMA AI stopped.' })); });
    this.append(card);
    this.renderComposer();
  }

  private quiet(ic: string, text: string): void {
    this.append(el('div', { className: 'ai-quiet' }, icon(ic, 14), el('span', { textContent: text })));
  }

  /** A problem in plain words with one way out. `crash`: pi itself ended. */
  private problem(msg: string, crash: boolean): void {
    const p: Problem = crash
      ? { kind: 'err', icon: 'xcirc', title: 'SOMA AI stopped unexpectedly', text: 'Your conversation and your model are kept. Starting it again usually helps.', action: 'retry' }
      : plainProblem(msg);
    const acts = el('div', { className: 'acts' });
    if (crash) {
      const b = el('button', { className: 'btn sm acc', textContent: 'Start SOMA AI again' });
      b.addEventListener('click', async () => { b.disabled = true; this.loaded = false; this.piUp = false; await this.renderChat(); });
      acts.append(b);
    } else if (p.action === 'setup') {
      const b = el('button', { className: 'btn sm acc', textContent: 'Choose a sign-in' });
      b.addEventListener('click', () => this.renderSetup(true));
      acts.append(b);
    } else {
      const b = el('button', { className: 'btn sm', textContent: 'Try again' });
      b.addEventListener('click', () => { this.input.value = 'Please continue where you stopped.'; void this.send(); });
      acts.append(b);
    }
    const det = el('pre', { className: 'ai-det', textContent: msg });
    det.hidden = true;
    const detBtn = el('button', { className: 'lnk', textContent: 'Details' });
    detBtn.addEventListener('click', () => { det.hidden = !det.hidden; });
    if (msg) acts.append(detBtn);
    this.append(el('div', { className: `ai-prob ${p.kind}` }, el('h4', {}, icon(p.icon, 18), el('span', { textContent: p.title })), el('p', { textContent: p.text }), acts, det));
  }

  /** For tests: what the chat shows. */
  state(): Json {
    return {
      phase: this.phase, running: this.running, asking: this.asking, model: this.model, piUp: this.piUp, starting: !!this.starting,
      steps: [...this.steps.values()].map((s) => ({ state: s.state, label: s.label.textContent })),
      rows: [...this.list.querySelectorAll<HTMLElement>('.ai-step')].map((r) => ({ state: r.dataset.state, label: r.querySelector('b')?.textContent, count: Number(r.dataset.count ?? '1') })),
      status: this.status.hidden ? null : this.status.textContent,
      questions: [...this.list.querySelectorAll('.ai-q')].map((q) => ({ done: q.classList.contains('done'), text: q.textContent })),
      asks: [...this.list.querySelectorAll<HTMLElement>('.ai-ask')].map((a) => ({ done: a.classList.contains('done'), title: a.querySelector('h4')?.textContent, what: a.querySelector('.what')?.textContent, raw: a.dataset.raw })),
      problems: [...this.list.querySelectorAll('.ai-prob h4')].map((h) => h.textContent),
      quiet: [...this.list.querySelectorAll('.ai-quiet')].map((q) => q.textContent),
      user: [...this.list.querySelectorAll('.ai-user')].map((u) => ({ text: u.querySelector('.tx')?.textContent ?? '', pics: u.querySelectorAll('img').length })),
      text: [...this.list.querySelectorAll('.ai-msg')].map((m) => m.textContent?.replace(/^SOMA AI/, '').trim()),
      chips: this.notes.map((n) => n.label), images: this.images.length, input: this.input.value, locked: this.input.disabled,
    };
  }
}
