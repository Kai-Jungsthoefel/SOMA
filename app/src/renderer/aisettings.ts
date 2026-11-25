import { accountLabel, CHATGPT_PROVIDER, EFFORT_LABEL, EFFORT_LEVELS, PI_DEFAULT_EFFORT, RECOMMENDED_EFFORT, type AiAccount, type AiModel, type Effort } from '../shared/somaai';
import type { AiStatus, SomaApi, VoiceStatus } from '../shared/types';
import { VOICE_LANGUAGES, VOICE_MODEL } from '../shared/voice';
import { effortText, keyForm, showEffortMenu, showModelMenu } from './aiparts';
import { icon } from './icons';
import type { SettingsPage } from './settings';
import { field, group, head } from './settingspages';
import { ask, el } from './ui';
import { voiceSetup } from './voice';

/*
 * Settings > SOMA AI: the sign-ins, the model, what the conversation of the open model used, and what SOMA AI may do.
 * Works without a model open: the models come from pi's SDK in the main process (somaaiauth.ts listModels), not from
 * a running pi. Changes reach the chat (chat.ts) through the deps, so its tab shows the new sign-in or model at once.
 */

type Toast = (text: string, kind?: 'ok' | 'info' | 'error') => void;
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

interface AiPageDeps {
  api: SomaApi;
  toast: Toast;
  /** A sign-in was added or removed: the chat goes on with it (chat.ts accountsChanged). */
  accountsChanged(provider?: string): void | Promise<void>;
  /** Another model: the conversation of the open model takes it too (chat.ts useModel). */
  useModel(provider: string, id: string): void | Promise<void>;
  /** Another effort: the conversation of the open model takes it too (chat.ts useEffort). */
  useEffort(level: Effort): void | Promise<unknown>;
  /** The note before the first message once more (chat.ts). */
  showNote(): void;
  /** A model is open (its conversation has a usage). */
  modelOpen(): boolean;
}

/** "1.2 k", "3.4 M": token counts for people. */
function count(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: n < 10_000 ? 1 : 0 })} k`;
  return `${(n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })} M`;
}

export class AiPage implements SettingsPage {
  private status: AiStatus | null = null;
  private accounts: AiAccount[] = [];
  private models: AiModel[] | null = null;
  private modelsError = '';
  private current: { provider: string; id: string } | null = null;
  /** Effort for new conversations, null: pi's default. */
  private effort: Effort | null = null;
  private usage: { stats: Json; provider: string } | null = null;
  private signing = false;
  private signInUrl = '';
  private seq = 0;
  private menu: HTMLElement;
  private voice: VoiceStatus | null = null;

  constructor(private root: HTMLElement, private deps: AiPageDeps) {
    // Outside the settings window: menus lie above it (style.css .menu), what is behind it is locked
    this.menu = el('div', { className: 'menu st-ai-menu' });
    this.menu.hidden = true;
    this.menu.setAttribute('role', 'menu');
    document.body.append(this.menu);
    deps.api.ai.onSignInUrl((url) => { this.signInUrl = url; if (this.signing) this.render(); });
    deps.api.voice.onStatus((s) => {
      const was = this.voice?.download?.phase;
      this.voice = s;
      if (!this.root.isConnected || !this.status) return;
      // Progress of the same step: only the text changes. Rendering the page anew would restart its spinner every 200 ms
      const desc = this.root.querySelector<HTMLElement>('[data-voice-progress]');
      if (desc && s.download && s.download.phase === was) desc.textContent = this.voiceProgress(s);
      else this.render();
    });
  }

  show(): void { void this.refresh(); }

  async refresh(): Promise<void> {
    const seq = ++this.seq;
    this.render();
    const api = this.deps.api.ai;
    const [status, accounts, current, effort, voice] = await Promise.all([
      api.status().catch(() => null), api.accounts().catch(() => [] as AiAccount[]), api.defaultModel().catch(() => null),
      api.defaultEffort().catch(() => null), this.deps.api.voice.status().catch(() => null),
    ]);
    if (seq !== this.seq) return;
    this.voice = voice;
    this.status = status;
    this.accounts = accounts;
    this.current = current;
    this.effort = effort;
    this.render();
    // Slower: the list of models (pi's SDK, about a second) and what the conversation used
    const [models, usage] = await Promise.all([
      accounts.length ? api.models().catch((e) => ({ ok: false, error: String(e), models: undefined })) : Promise.resolve({ ok: true, models: [] as AiModel[], error: undefined }),
      this.readUsage(status),
    ]);
    if (seq !== this.seq) return;
    this.models = models.ok ? models.models ?? [] : [];
    this.modelsError = models.ok ? '' : models.error ?? 'The models could not be listed.';
    this.usage = usage;
    this.render();
  }

  /** Usage of the open model's conversation, only while its pi runs (nothing is started for it). */
  private async readUsage(status: AiStatus | null): Promise<{ stats: Json; provider: string } | null> {
    if (!status?.running || !this.deps.modelOpen()) return null;
    const [stats, state] = await Promise.all([
      this.deps.api.ai.command({ type: 'get_session_stats' }).catch(() => null),
      this.deps.api.ai.command({ type: 'get_state' }).catch(() => null),
    ]);
    if (!stats?.ok) return null;
    return { stats: obj(stats.data), provider: String(obj(obj(state?.data).model).provider ?? '') };
  }

  private async signIn(): Promise<void> {
    this.signing = true;
    this.signInUrl = '';
    this.render();
    const r = await this.deps.api.ai.signIn().catch((e) => ({ ok: false, error: String(e), cancelled: false }));
    this.signing = false;
    if (r.ok) {
      this.deps.toast('Signed in with ChatGPT.');
      await this.deps.accountsChanged(CHATGPT_PROVIDER);
    } else if (!r.cancelled) this.deps.toast(`Signing in did not work: ${r.error ?? 'unknown reason'}`, 'error');
    await this.refresh();
  }

  private async signOut(a: AiAccount): Promise<void> {
    const r = await this.deps.api.ai.signOut(a.provider).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { this.deps.toast(r.error ?? 'Signing out did not work.', 'error'); return; }
    this.deps.toast(`Signed out of ${accountLabel(a)}.`);
    await this.deps.accountsChanged();
    await this.refresh();
  }

  private async pickModel(m: AiModel): Promise<void> {
    const r = await this.deps.api.ai.setDefaultModel(m.provider, m.id).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { this.deps.toast(r.error ?? 'The model could not be changed.', 'error'); return; }
    this.current = { provider: m.provider, id: m.id };
    if (this.deps.modelOpen()) await this.deps.useModel(m.provider, m.id);
    this.deps.toast(`SOMA AI uses ${m.name} from the next message on.`);
    this.render();
  }

  private async pickEffort(level: Effort): Promise<void> {
    const r = await this.deps.api.ai.setDefaultEffort(level).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { this.deps.toast(r.error ?? 'The effort could not be changed.', 'error'); return; }
    this.effort = level;
    if (this.deps.modelOpen()) await this.deps.useEffort(level);
    this.deps.toast(`SOMA AI uses ${effortText(level).toLowerCase()} from the next message on.`);
    this.render();
  }

  private accountRow(a: AiAccount): HTMLElement {
    const out = el('button', { className: 'btn sm', textContent: 'Sign out' });
    out.dataset.act = 'signout';
    out.addEventListener('click', () => void this.signOut(a));
    const row = el('div', { className: 'st-store st-acct' },
      el('span', { className: 'st-store-ico' }, icon(a.type === 'oauth' ? 'chat' : 'apikey', 16, 1.8)),
      el('div', { className: 'st-fl' }, el('b', { textContent: accountLabel(a) }),
        el('span', { textContent: a.type === 'oauth' ? 'Account. The limits of your plan apply, no extra cost.' : 'API key. Billed per use by the provider.' })),
      el('div', { className: 'st-store-act' }, out));
    row.dataset.provider = a.provider;
    return row;
  }

  private signInRows(): HTMLElement[] {
    const rows: HTMLElement[] = [];
    if (!this.accounts.some((a) => a.provider === CHATGPT_PROVIDER && a.type === 'oauth')) {
      let control: HTMLElement;
      if (this.signing) {
        const cancel = el('button', { className: 'btn sm', textContent: 'Cancel' });
        cancel.addEventListener('click', () => void this.deps.api.ai.cancelSignIn());
        const again = el('button', { className: 'lnk' }, 'Open the page again', icon('openext', 12, 2));
        again.hidden = !this.signInUrl;
        again.addEventListener('click', () => { if (this.signInUrl) void this.deps.api.openUrl(this.signInUrl); });
        control = el('div', { className: 'st-ai-wait' }, el('span', { className: 'spin' }, icon('spin', 14, 2.4)), el('span', { textContent: 'Waiting for the browser …' }), again, cancel);
      } else {
        const b = el('button', { className: 'btn sm acc', textContent: 'Sign in with ChatGPT' });
        b.dataset.act = 'chatgpt';
        b.addEventListener('click', () => void this.signIn());
        control = b;
      }
      rows.push(field('ChatGPT', 'Uses your ChatGPT Plus or Pro plan. Opens your browser to sign in.', control));
    }
    const key = el('div', { className: 'st-ai-key' }, ...keyForm({
      api: this.deps.api, toast: this.deps.toast,
      saved: async (provider) => { await this.deps.accountsChanged(provider); await this.refresh(); },
    }));
    rows.push(el('div', { className: 'st-field st-ai-keyfield' },
      el('div', { className: 'st-fl' }, el('b', { textContent: 'API key' }), el('span', { textContent: 'Pay per use. Claude, OpenAI, Google Gemini, OpenRouter or OpenCode (Zen or Go).' })), key));
    return rows;
  }

  private modelRow(): HTMLElement {
    const name = this.current ? this.models?.find((m) => m.provider === this.current!.provider && m.id === this.current!.id)?.name ?? this.current.id : null;
    const btn = el('button', { className: 'btn sm st-ai-model', disabled: !this.accounts.length || this.models === null },
      el('span', { textContent: this.models === null && this.accounts.length ? 'Loading models …' : name ?? 'Chosen by SOMA AI' }), icon('down', 12, 2));
    btn.dataset.act = 'model';
    btn.addEventListener('click', () => {
      if (this.models) showModelMenu(this.menu, btn, this.models, this.current, (m) => void this.pickModel(m), 'right');
    });
    const rec = el('div', { className: 'st-ai-rec' }, icon('sparkle', 13, 2),
      el('span', {}, 'For the best results we recommend ', el('b', { textContent: 'Opus 5.5' }), ' (Claude, with an API key) or ', el('b', { textContent: 'GPT-6.2 Astra' }), ' (with ChatGPT), with ', el('b', { textContent: `${EFFORT_LABEL[RECOMMENDED_EFFORT]} effort` }), ' or more.'));
    return field('Model', 'The AI model SOMA AI thinks with, for new conversations and the one of the open model. The model button below the chat input changes it too.',
      btn, el('div', {}, rec, this.modelsError ? el('div', { className: 'ai-err', textContent: this.modelsError }) : null));
  }

  private effortRow(): HTMLElement {
    const level = this.effort ?? PI_DEFAULT_EFFORT;
    const btn = el('button', { className: 'btn sm st-ai-model', disabled: !this.accounts.length }, el('span', { textContent: EFFORT_LABEL[level] }), icon('down', 12, 2));
    btn.dataset.act = 'effort';
    // No model runs here: all of pi's levels, it takes the nearest one a model supports
    btn.addEventListener('click', () => showEffortMenu(this.menu, btn, [...EFFORT_LEVELS], level, (e) => void this.pickEffort(e), 'right'));
    const rec = el('div', { className: 'st-ai-rec' }, icon('sparkle', 13, 2),
      el('span', {}, 'More effort gives better models. We recommend ', el('b', { textContent: EFFORT_LABEL[RECOMMENDED_EFFORT] }), ' or more.'));
    return field('Effort', 'How long SOMA AI thinks before it acts. More effort is slower and uses more of your plan or credit. A model that cannot think that hard uses its highest level. The effort button below the chat input changes it too.',
      btn, el('div', {}, rec));
  }

  private usageRows(): HTMLElement[] {
    const u = this.usage;
    if (!u) {
      return [el('p', { className: 'st-lead', textContent: this.deps.modelOpen()
        ? 'Shown while SOMA AI works in the open model. Start it in the chat, then come back here.'
        : 'Open a model and work with SOMA AI to see what its conversation used.' })];
    }
    const s = u.stats;
    const tokens = obj(s.tokens);
    const read = num(tokens.input) + num(tokens.cacheRead) + num(tokens.cacheWrite);
    const cost = num(s.cost);
    const account = this.accounts.find((a) => a.provider === u.provider);
    const ctx = obj(s.contextUsage);
    const rows: [string, string][] = [
      ['Messages', `${num(s.userMessages)} from you, ${num(s.assistantMessages)} from SOMA AI, ${num(s.toolCalls)} steps`],
      ['Tokens', `${count(read)} read, ${count(num(tokens.output))} written`],
      ['Cost', account?.type === 'oauth' ? 'Included in your plan (its limits apply)' : cost > 0 ? `about $${cost.toFixed(2)} at the provider’s prices` : 'Not known for this model'],
    ];
    if (typeof ctx.percent === 'number') rows.push(['Length', `${Math.round(ctx.percent)} % of what the model can keep in mind. When it is full, SOMA AI summarizes the older part.`]);
    return [
      el('p', { className: 'st-lead', textContent: 'What the conversation of the open model used so far. A new conversation starts from zero.' }),
      el('div', { className: 'st-kv st-ai-usage' }, ...rows.flatMap(([k, v]) => [el('span', { className: 'k', textContent: k }), el('span', { className: 'v', textContent: v })])),
    ];
  }

  /** Voice input (voice.ts): set up, progress of the download, or the model with a way to remove it. */
  private voiceRow(): HTMLElement {
    const v = this.voice;
    const mk = (label: string, act: string, fn: () => void, cls = 'btn sm') => {
      const b = el('button', { className: cls, textContent: label });
      b.dataset.act = act;
      b.addEventListener('click', fn);
      return b;
    };
    const setup = () => void voiceSetup(this.deps.api, this.deps.toast, v).then(() => this.refresh());
    const title = 'Voice input';
    if (!v) return field(title, 'Speak to SOMA AI instead of typing.', el('span'));
    if (!v.available) return field(title, v.unavailable ?? 'Voice input does not work on this computer.', el('span'));
    if (v.download) {
      const row = field(title, this.voiceProgress(v), el('div', { className: 'st-ai-wait' }, el('span', { className: 'spin' }, icon('spin', 14, 2.4)), mk('Show', 'voice-show', setup), mk('Cancel', 'voice-cancel', () => void this.deps.api.voice.cancel())));
      row.querySelector<HTMLElement>('.st-fl > span')?.setAttribute('data-voice-progress', '');
      return row;
    }
    if (!v.installed) {
      return field(title, `Speak to SOMA AI instead of typing, with the microphone button next to the chat input. Recognition runs on this computer. Needs a one-time download of ${Math.round(VOICE_MODEL.downloadBytes / 1e6)} MB.`,
        mk('Set up …', 'voice-setup', setup, 'btn sm acc'), v.error ? el('div', { className: 'ai-err', textContent: `The last download did not work: ${v.error}` }) : null);
    }
    const lang = VOICE_LANGUAGES.find((l) => l.id === v.language)?.label;
    return field(title, `Ready. ${VOICE_MODEL.name} by ${VOICE_MODEL.by} (license ${VOICE_MODEL.license}), ${Math.round(VOICE_MODEL.diskBytes / 1e6)} MB on this computer${lang ? `, set up for ${lang}` : ''}. It understands 25 European languages and recognizes which one you speak.`,
      mk('Remove', 'voice-remove', () => void this.removeVoice()));
  }

  private voiceProgress(v: VoiceStatus): string {
    const d = v.download;
    if (!d) return '';
    return d.phase === 'unpack' ? 'Unpacking the speech model …' : `Downloading the speech model: ${Math.round(d.received / 1e6)} of ${Math.round(d.total / 1e6)} MB …`;
  }

  private async removeVoice(): Promise<void> {
    const i = await ask({ title: 'Voice input', message: 'Remove the speech model?', detail: `This frees ${Math.round(VOICE_MODEL.diskBytes / 1e6)} MB. Voice input then downloads it again on the next use.`, buttons: ['Remove', 'Cancel'] });
    if (i !== 0) return;
    const r = await this.deps.api.voice.remove().catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) this.deps.toast('The speech model was removed.');
    else this.deps.toast(r.error ?? 'The speech model could not be removed.', 'error');
    await this.refresh();
  }

  private safety(): HTMLElement[] {
    const li = (ic: string, b: string, t: string) => el('li', {}, icon(ic, 14, 1.9), el('span', {}, el('b', { textContent: b }), ` ${t}`));
    const again = el('button', { className: 'btn sm', textContent: 'Show again' });
    again.dataset.act = 'note';
    again.addEventListener('click', () => { this.deps.showNote(); this.deps.toast('The chat shows the note again before you go on.'); });
    return [
      el('ul', { className: 'st-ai-rules' },
        li('folder', 'In the model’s folder', 'it reads, writes and runs commands without asking. Every step is in the History.'),
        li('help', 'It asks first', 'before it works with files outside the model, opens a website (once per site), downloads something or installs software.'),
        li('shield', 'Never', 'going back in the History, reading sign-ins and keys, and commands known to be dangerous.')),
      field('Note before the first message', 'The risks of working with SOMA AI, as the chat shows them before the first message.', again),
    ];
  }

  render(): void {
    const s = this.status;
    const kids: (HTMLElement | null)[] = [
      ...head('SOMA AI', 'The agent built into SOMA. It works in the folder of the open model and thinks with an AI service you sign in to. Sign-ins stay on this computer.'),
    ];
    if (s && !s.available) {
      kids.push(el('div', { className: 'st-problem' }, icon('alert', 14, 2), el('span', { textContent: 'SOMA AI is missing from this installation. Reinstalling SOMA brings it back.' })));
      this.root.replaceChildren(el('div', { className: 'st-pg' }, ...kids));
      return;
    }
    kids.push(
      group('Sign-ins',
        ...(this.accounts.length ? this.accounts.map((a) => this.accountRow(a)) : [el('p', { className: 'st-lead', textContent: 'Not signed in yet. SOMA AI needs one of these to work.' })]),
        ...this.signInRows()),
      group('Model', this.modelRow(), this.effortRow()),
      group('Voice input', this.voiceRow()),
      group('Usage', ...this.usageRows()),
      group('Safety', ...this.safety()),
      s?.version ? el('p', { className: 'st-lead st-ai-pi', textContent: `SOMA AI runs on pi ${s.version} (pi.dev, MIT license). Its sign-ins, settings and conversations are listed under Storage.` }) : null,
    );
    this.root.replaceChildren(el('div', { className: 'st-pg st-ai' }, ...kids));
  }

  state() {
    return {
      text: this.root.innerText, accounts: this.accounts, models: this.models?.length ?? null, current: this.current, effort: this.effort, signing: this.signing,
      usage: !!this.usage, modelsError: this.modelsError, voice: this.voice,
    };
  }
}
