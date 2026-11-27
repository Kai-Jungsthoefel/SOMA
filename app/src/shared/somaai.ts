/**
 * SOMA AI (main/somaai.ts): the ways in that SOMA offers, and the models it recommends. Shared by the main process
 * (checks what the chat asks for) and the chat (shows it).
 *
 * Decisions of the user (2026-11-16): ChatGPT through "Sign in with ChatGPT" and API keys. No login with a Claude
 * subscription (Anthropic does not allow it in other apps). A recommendation for the best models instead of quality
 * levels: they would have to be kept up to date for every provider. 2026-11-27 (issue #25): GitHub Copilot too, through
 * pi's own login like ChatGPT, not through a second agent.
 */

/** A provider for an API key. `id` is pi's provider id, `keyUrl` the page where people get a key. */
export interface AiKeyProvider { id: string; label: string; keyUrl: string; placeholder: string }

export const AI_KEY_PROVIDERS: AiKeyProvider[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', keyUrl: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys', placeholder: 'sk-…' },
  { id: 'google', label: 'Google Gemini', keyUrl: 'https://aistudio.google.com/apikey', placeholder: 'AIza…' },
  { id: 'openrouter', label: 'OpenRouter', keyUrl: 'https://openrouter.ai/settings/keys', placeholder: 'sk-or-…' },
  { id: 'opencode', label: 'OpenCode Zen', keyUrl: 'https://opencode.ai/auth', placeholder: 'Your OpenCode key' },
  { id: 'opencode-go', label: 'OpenCode Go', keyUrl: 'https://opencode.ai/auth', placeholder: 'Your OpenCode key' },
];

/** "Sign in with ChatGPT" is pi's provider `openai` with its account login (OpenAI's flow for agents of other makers). */
export const CHATGPT_PROVIDER = 'openai';
/** "Sign in with GitHub Copilot" is pi's provider `github-copilot`: GitHub's device flow, a code to enter on github.com. */
export const COPILOT_PROVIDER = 'github-copilot';

/** An account sign-in through pi's own login. `plan`: what it uses, for the texts. `code`: GitHub's device flow, the user types a code. */
export interface AiAccountProvider { id: string; label: string; plan: string; code: boolean }

export const AI_ACCOUNT_PROVIDERS: AiAccountProvider[] = [
  { id: CHATGPT_PROVIDER, label: 'ChatGPT', plan: 'your ChatGPT Plus or Pro plan', code: false },
  { id: COPILOT_PROVIDER, label: 'GitHub Copilot', plan: 'your GitHub Copilot plan', code: true },
];
export const accountProvider = (id: string) => AI_ACCOUNT_PROVIDERS.find((p) => p.id === id);

/** Model SOMA chooses after signing in, per provider. Providers without an entry keep pi's choice. */
export const RECOMMENDED_MODEL: Record<string, string> = {
  openai: 'gpt-6.2-astra',
  anthropic: 'claude-opus-5-5',
  opencode: 'claude-opus-5-5',
  openrouter: 'anthropic/claude-opus-5.5',
  'github-copilot': 'claude-opus-5.5',
};

/** The models the recommendation names, under every provider that offers them. */
export const isRecommendedModel = (id: string) => /^(claude-opus-5-5|claude-opus-5\.5|gpt-6\.2-astra|anthropic\/claude-opus-5\.5|openai\/gpt-6\.2-astra)$/.test(id);

/**
 * Effort: pi's thinking levels, how long the model thinks before it answers. pi keeps the one for new conversations
 * in settings.json (defaultThinkingLevel, its own default "medium") and clamps it to what the model supports.
 */
export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];
export const EFFORT_LABEL: Record<Effort, string> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
};
/** pi's level when nothing is saved. */
export const PI_DEFAULT_EFFORT: Effort = 'medium';
/** Wish of the user (2026-11-18): the recommendation says that more effort gives better results. */
export const RECOMMENDED_EFFORT: Effort = 'high';
export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);

/** A model SOMA AI can use (pi's provider and model id, the name people see). */
export interface AiModel { provider: string; id: string; name: string }

/** An earlier conversation of the open model: its first message (or name), last activity (ms), number of messages. */
export interface AiSession { id: string; title: string; modified: number; messages: number }

/** A saved sign-in, without its secret. `type`: account login (oauth) or API key. */
export interface AiAccount { provider: string; type: 'oauth' | 'api_key' }

/** What people see as the name of a sign-in. */
export function accountLabel(a: AiAccount): string {
  if (a.type === 'oauth') { const p = accountProvider(a.provider); if (p) return p.label; }
  return AI_KEY_PROVIDERS.find((p) => p.id === a.provider)?.label ?? a.provider;
}
