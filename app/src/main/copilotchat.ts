import type { CopilotClient, CopilotSession } from '@microsoft/copilot-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AiModel } from '../shared/somaai';
import type { AiResult } from '../shared/types';
import { copilotModels, openSignedInCopilotClient } from './copilotauth';
import { aiDir } from './paths';

type Message = {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string }[];
  timestamp: number;
  stopReason?: 'error' | 'aborted';
  errorMessage?: string;
};

/** Text-only preview. The SDK gets neither the model folder nor tools; only explicitly sent text leaves SOMA. */
export class CopilotChat {
  private sessionId = randomUUID();
  private messages: Message[] = [];
  private client?: CopilotClient;
  private session?: CopilotSession;
  private turn?: { cancelled: boolean; done?: Promise<void> };
  private selection: AiModel;

  constructor(model: AiModel, private readonly emit: (record: Record<string, unknown>) => void) { this.selection = model; }

  get busy(): boolean { return !!this.turn; }
  get model(): AiModel { return this.selection; }

  state() {
    return { model: this.model, sessionId: this.sessionId, isStreaming: this.busy };
  }

  async select(model: AiModel): Promise<AiResult> {
    if (this.busy) return { ok: false, error: 'Stop the current reply before changing models.' };
    try {
      if (this.session && model.id !== this.model.id) await this.session.setModel(model.id);
      this.selection = model;
      return { ok: true, data: model };
    } catch {
      return { ok: false, error: 'GitHub Copilot could not change to that model.' };
    }
  }

  async command(c: Record<string, unknown>): Promise<AiResult> {
    switch (c.type) {
      case 'get_state': return { ok: true, data: this.state() };
      case 'get_messages': return { ok: true, data: { messages: this.messages } };
      case 'get_available_thinking_levels': return { ok: true, data: { levels: [] } };
      case 'get_commands': return { ok: true, data: { commands: [] } };
      case 'get_session_stats': return { ok: true, data: {
        userMessages: this.messages.filter((m) => m.role === 'user').length,
        assistantMessages: this.messages.filter((m) => m.role === 'assistant').length,
      } };
      case 'abort':
        await this.abort();
        return { ok: true };
      case 'new_session':
        if (this.busy) return { ok: false, error: 'Stop the current reply before starting a new conversation.' };
        await this.closeSession();
        this.messages = [];
        this.sessionId = randomUUID();
        return { ok: true };
      case 'prompt':
        if (this.busy) return { ok: false, error: 'Wait for the current Copilot reply or stop it first.' };
        if (Array.isArray(c.images) && c.images.length) return { ok: false, error: 'The Copilot preview accepts text only. Remove the pictures and try again.' };
        if (typeof c.message !== 'string' || !c.message.trim()) return { ok: false, error: 'Enter a message first.' };
        if (!copilotModels().some((m) => m.id === this.model.id)) return { ok: false, error: 'Your GitHub Copilot sign-in has expired. Sign in again in Settings > SOMA AI.' };
        this.submit(c.message);
        return { ok: true };
      default: return { ok: false, error: 'The Copilot text preview does not support this action.' };
    }
  }

  private submit(text: string): void {
    const turn = { cancelled: false, done: Promise.resolve() };
    this.turn = turn;
    this.emit({ type: 'agent_start' });
    const input: Message = { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
    this.messages.push(input);
    this.emit({ type: 'message_start', message: input });
    this.emit({ type: 'message_start', message: { role: 'assistant' } });
    turn.done = this.reply(text, turn);
  }

  private async reply(text: string, turn: { cancelled: boolean }): Promise<void> {
    const message: Message = { role: 'assistant', content: [], timestamp: Date.now() };
    try {
      this.client ??= await openSignedInCopilotClient();
      if (turn.cancelled) return;
      if (!this.session) {
        const workingDirectory = path.join(aiDir(), 'copilot-runtime', 'text-preview');
        fs.mkdirSync(workingDirectory, { recursive: true });
        this.session = await this.client.createSession({
          workingDirectory, model: this.model.id, enableConfigDiscovery: false,
          tools: { availableTools: [] },
          permissions: { onRequest: () => ({ kind: 'denied-by-rules', rules: [] }) },
          instructions: { skipCustomInstructions: true },
          git: { enableHostGitOperations: false },
          github: { telemetryEnabled: false },
          state: { enableCrossSessionStore: false },
          systemMessage: { mode: 'append', content: 'You are answering a CAD design question in SOMA. This chat is text-only. You cannot see or edit the project, run commands, or use tools. Do not claim you performed those actions.' },
        });
      }
      if (turn.cancelled) return;
      const response = await this.session.sendAndWait(text, 90_000);
      if (turn.cancelled) return;
      if (!response?.data.content.trim()) throw new Error('Empty response.');
      message.content.push({ type: 'text', text: response.data.content });
      this.messages.push(message);
    } catch {
      if (!turn.cancelled) {
        message.stopReason = 'error';
        message.errorMessage = 'GitHub Copilot did not answer. Try another model or check your subscription and connection.';
        await this.abort();
      }
    } finally {
      if (turn.cancelled && !message.stopReason) message.stopReason = 'aborted';
      this.turn = undefined;
      this.emit({ type: 'message_end', message });
      this.emit({ type: 'agent_settled' });
    }
  }

  private async abort(): Promise<void> {
    if (!this.turn) return;
    this.turn.cancelled = true;
    try { await this.session?.abort(); }
    catch { console.warn('[somaai] Copilot did not acknowledge the abort.'); }
  }

  private async closeSession(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.session = undefined;
    try { await client?.stop(); }
    catch { console.warn('[somaai] Copilot runtime did not stop cleanly.'); }
  }

  async stop(): Promise<void> {
    const turn = this.turn;
    await this.abort();
    await this.closeSession();
    await turn?.done;
    await this.closeSession();
  }
}
