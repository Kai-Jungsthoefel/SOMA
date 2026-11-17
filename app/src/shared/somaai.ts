/**
 * SOMA AI (main/somaai.ts): the ways in that SOMA offers, and the models it recommends. Shared by the main process
 * (checks what the chat asks for) and the chat (shows it).
 *
 * Decisions of the user (2026-11-16): ChatGPT through "Sign in with ChatGPT" and API keys. No login with a Claude
 * subscription (Anthropic does not allow it in other apps) and none with GitHub Copilot. A recommendation for the best
 * models instead of quality levels: they would have to be kept up to date for every provider.
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

/** Model SOMA chooses after signing in, per provider. Providers without an entry keep pi's choice. */
export const RECOMMENDED_MODEL: Record<string, string> = {
  openai: 'gpt-6-astra',
  anthropic: 'claude-opus-5-5',
  opencode: 'claude-opus-5-5',
  openrouter: 'anthropic/claude-opus-5.5',
};

/** The models the recommendation names, under every provider that offers them. */
export const isRecommendedModel = (id: string) => /^(claude-opus-5-5|gpt-6-astra|anthropic\/claude-opus-5\.5|openai\/gpt-6-astra)$/.test(id);

/** A model SOMA AI can use (pi's provider and model id, the name people see). */
export interface AiModel { provider: string; id: string; name: string }

/** An earlier conversation of the open model: its first message (or name), last activity (ms), number of messages. */
export interface AiSession { id: string; title: string; modified: number; messages: number }

/** A saved sign-in, without its secret. `type`: account login (oauth) or API key. */
export interface AiAccount { provider: string; type: 'oauth' | 'api_key' }

/** What people see as the name of a sign-in. */
export function accountLabel(a: AiAccount): string {
  if (a.provider === CHATGPT_PROVIDER && a.type === 'oauth') return 'ChatGPT';
  return AI_KEY_PROVIDERS.find((p) => p.id === a.provider)?.label ?? a.provider;
}
