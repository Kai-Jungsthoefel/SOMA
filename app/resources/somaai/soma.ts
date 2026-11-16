// SOMA's own extension for pi (SOMA AI, app/src/main/somaai.ts). pi loads it at start with -e.
import { Type } from 'typebox';

/**
 * Start of the title of a question from ask_user. The chat (app/src/renderer/chat.ts, ASK_MARK) shows such a select
 * as a question of SOMA AI with answer buttons and a field for an own answer, not as a permission question.
 */
const ASK_MARK = 'SOMA AI asks:\n';

interface Option { label: string; description?: string }
interface AskParams { question: string; options: Option[] }
interface Ui { select(title: string, options: string[]): Promise<string | undefined> }
interface Ctx { hasUI: boolean; ui: Ui }
interface Pi {
  registerTool(tool: {
    name: string; label: string; description: string; parameters: unknown;
    execute(id: string, params: AskParams, signal: AbortSignal | undefined, onUpdate: unknown, ctx: Ctx): Promise<{ content: { type: 'text'; text: string }[]; details: Record<string, unknown> }>;
  }): void;
}

export default function soma(pi: Pi): void {
  // SOMA starts pi with the Electron of the app as plain Node (ELECTRON_RUN_AS_NODE=1), so nobody has to install Node.
  // The commands pi runs inherit the environment: an Electron app started from there (another program, `soma render`
  // going through a browser) would also start as plain Node. So the variable goes away as soon as pi is up.
  delete process.env.ELECTRON_RUN_AS_NODE;

  // Questions to the person, like AskUserQuestion in Claude Code: answers to click instead of a question in the reply
  // that ends the turn (wish of the user, 2026-11-16). One question per call, an own answer is always possible.
  pi.registerTool({
    name: 'ask_user',
    label: 'Ask the user',
    description: 'Ask the person a question when you need their decision (a size, a material, which of two variants, '
      + 'whether to go on). Offer 2 to 5 short answers to click; they can also type their own. Prefer this over asking '
      + 'in your reply. Ask one thing per call. The result is their answer.',
    parameters: Type.Object({
      question: Type.String({ description: 'The question, short and in plain words, in the language of the person.' }),
      options: Type.Array(Type.Object({
        label: Type.String({ description: 'The answer, a few words.' }),
        description: Type.Optional(Type.String({ description: 'What this answer means for the model, one short sentence.' })),
      }), { minItems: 1, maxItems: 6 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: {} });
      if (!ctx.hasUI) return text('Nobody can answer right now. Decide yourself and say what you assumed.');
      const shown = params.options.map((o) => (o.description ? `${o.label} — ${o.description}` : o.label));
      const answer = await ctx.ui.select(`${ASK_MARK}${params.question}`, shown);
      if (answer === undefined || !answer.trim()) return text('The person skipped the question. Decide yourself and say what you assumed, or ask in your reply.');
      const picked = params.options[shown.indexOf(answer)];
      return { ...text(`The person answered: ${picked ? picked.label : answer}`), details: { answer: picked ? picked.label : answer, own: !picked } };
    },
  });
}
