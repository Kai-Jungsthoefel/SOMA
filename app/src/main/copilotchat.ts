import type { CopilotClient, CopilotSession, Tool, ToolInvocation } from '@microsoft/copilot-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AiModel } from '../shared/somaai';
import type { AiResult } from '../shared/types';
import { copilotModels, openSignedInCopilotClient } from './copilotauth';
import { aiDir } from './paths';
import type { copilotCad } from './copilotcad';

type Message = {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string }[];
  timestamp: number;
  stopReason?: 'error' | 'aborted';
  errorMessage?: string;
};

/** The SDK works outside the project; only SOMA's explicit CAD tools can access its source files. */
export class CopilotChat {
  private sessionId = randomUUID();
  private messages: Message[] = [];
  private client?: CopilotClient;
  private session?: CopilotSession;
  private turn?: { cancelled: boolean; done?: Promise<void> };
  private selection: AiModel;
  private approval?: { id: string; resolve: (approved: boolean) => void };

  constructor(model: AiModel, private readonly emit: (record: Record<string, unknown>) => void,
    private readonly cad: ReturnType<typeof copilotCad>) { this.selection = model; }

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
      default: return { ok: false, error: 'The Copilot CAD preview does not support this action.' };
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
        const definitions = this.tools();
        this.session = await this.client.createSession({
          workingDirectory, model: this.model.id, enableConfigDiscovery: false,
          tools: { definitions, availableTools: definitions.map((tool) => tool.name) },
          permissions: { onRequest: () => ({ kind: 'denied-by-rules', rules: [] }) },
          instructions: { skipCustomInstructions: true },
          git: { enableHostGitOperations: false },
          github: { telemetryEnabled: false },
          state: { enableCrossSessionStore: false },
          systemMessage: { mode: 'append', content: 'You are working on a CadQuery model in SOMA. Use soma_list_project to find its source files and instructions, then soma_read_model to inspect the relevant files. Use soma_edit_model for a small exact replacement in a Python source file; SOMA asks the user to approve it and requests a rebuild. Do not claim the rebuild succeeded without evidence. Do not retry a declined edit. You cannot access arbitrary files or run shell commands.' },
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
    this.approval?.resolve(false);
    try { await this.session?.abort(); }
    catch { console.warn('[somaai] Copilot did not acknowledge the abort.'); }
  }

  respond(id: string, confirmed: boolean): void {
    if (this.approval?.id === id) this.approval.resolve(confirmed);
  }

  private confirmEdit(detail: string, signal?: AbortSignal): Promise<boolean> {
    if (this.approval || this.turn?.cancelled || signal?.aborted) return Promise.resolve(false);
    const id = `copilot-${randomUUID()}`;
    return new Promise((resolve) => {
      const cancel = () => finish(false);
      const finish = (approved: boolean) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        this.approval = undefined;
        resolve(approved);
      };
      const timeout = setTimeout(cancel, 80_000);
      this.approval = { id, resolve: finish };
      signal?.addEventListener('abort', cancel, { once: true });
      this.emit({ type: 'extension_ui_request', id, method: 'confirm', title: 'Apply and rebuild Copilot’s model edit?',
        message: `Approving saves this Python change and runs the script on your computer. Approve only code you trust.\n\n${detail}` });
    });
  }

  private tools(): Tool[] {
    const list = 'soma_list_project', read = 'soma_read_model', edit = 'soma_edit_model';
    const pathArg = { type: 'string', description: 'Project-relative path from soma_list_project. Omit for the active entry script.' };
    const arg = (args: unknown, key: string) =>
      args && typeof args === 'object' && key in args ? Reflect.get(args, key) as unknown : undefined;
    const run = async (invocation: ToolInvocation, action: () => unknown) => {
      const { toolCallId, toolName } = invocation;
      this.emit({ type: 'tool_execution_start', toolCallId, toolName });
      let result: unknown;
      try {
        if (!this.turn || this.turn.cancelled || invocation.signal?.aborted) throw new Error('The Copilot turn has stopped.');
        result = await action();
      } catch (e) {
        result = { ok: false, message: e instanceof Error ? e.message : 'SOMA could not perform the CAD action.' };
      }
      const failed = !!result && typeof result === 'object' && 'ok' in result && result.ok === false;
      this.emit({ type: 'tool_execution_end', toolCallId, isError: failed,
        result: { content: [{ type: 'text', text: toolName === read && !failed ? 'Read a project file.' : JSON.stringify(result) }] } });
      return result;
    };
    return [
      { name: list, description: 'List the active entry, project Python sources, AGENTS.md, and imported STEP filenames.',
        skipPermission: true, handler: (_args, invocation) => run(invocation, () => this.cad.list()) },
      { name: read, description: 'Read a listed Python source or AGENTS.md. Imported assets are listed only.',
        skipPermission: true, parameters: { type: 'object', properties: { path: pathArg }, additionalProperties: false },
        handler: (args, invocation) => run(invocation, () => this.cad.read(arg(args, 'path'))) },
      { name: edit, description: 'Propose replacing one exact, unique snippet in a listed Python source and rebuilding after user approval.',
        skipPermission: true, parameters: { type: 'object', properties: { path: pathArg, before: { type: 'string' }, after: { type: 'string' } }, required: ['before', 'after'], additionalProperties: false },
        handler: (args, invocation) => run(invocation, () => this.cad.replace(arg(args, 'before'), arg(args, 'after'),
          (detail) => this.confirmEdit(detail, invocation.signal),
          () => !!this.turn && !this.turn.cancelled && !invocation.signal?.aborted, arg(args, 'path'))) },
    ];
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
