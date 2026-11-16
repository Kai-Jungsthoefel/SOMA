// SOMA's own extension for pi (SOMA AI, app/src/main/somaai.ts). pi loads it at start with -e.
import { Type } from 'typebox';

/**
 * Start of the title of the input dialog from ask_user, followed by the questions as JSON. The chat
 * (app/src/renderer/chat.ts, ASK_MARK) shows it as a card with all questions and answers {"answers": [...]} as JSON.
 */
const ASK_MARK = 'SOMA AI asks:\n';

interface Option { label: string; description?: string }
interface Question { question: string; header?: string; options: Option[]; multiSelect?: boolean }
interface AskParams { questions: Question[] }
/** One answer of the chat: answers clicked, words typed. null: skipped. */
interface Answer { picked?: unknown; own?: unknown }
interface Ui { input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined> }
interface Ctx { hasUI: boolean; ui: Ui }
interface Pi {
  registerTool(tool: {
    name: string; label: string; description: string; parameters: unknown;
    execute(id: string, params: AskParams, signal: AbortSignal | undefined, onUpdate: unknown, ctx: Ctx): Promise<{ content: { type: 'text'; text: string }[]; details: Record<string, unknown> }>;
  }): void;
}

/** What the person answered to one question: in words for the model, and as the chat shows it. null: skipped. */
function answerText(q: Question, a: Answer | null | undefined): { text: string; shown: string; own: boolean } | null {
  if (!a || typeof a !== 'object') return null;
  const labels = new Set(q.options.map((o) => o.label));
  const picked = (Array.isArray(a.picked) ? a.picked : []).filter((p): p is string => typeof p === 'string' && labels.has(p));
  const own = typeof a.own === 'string' ? a.own.trim() : '';
  if (!picked.length && !own) return null;
  return {
    text: [...picked, ...(own ? [`in their own words: "${own}"`] : [])].join(', '),
    shown: [...picked, ...(own ? [own] : [])].join(', '),
    own: !!own,
  };
}

export default function soma(pi: Pi): void {
  // SOMA starts pi with the Electron of the app as plain Node (ELECTRON_RUN_AS_NODE=1), so nobody has to install Node.
  // The commands pi runs inherit the environment: an Electron app started from there (another program, `soma render`
  // going through a browser) would also start as plain Node. So the variable goes away as soon as pi is up.
  delete process.env.ELECTRON_RUN_AS_NODE;

  // Questions to the person, like AskUserQuestion in Claude Code: answers to click instead of a question in the reply
  // that ends the turn (wish of the user, 2026-11-16). Several questions in one call, so they are answered together
  // and not one after the other; an own answer is always possible.
  pi.registerTool({
    name: 'ask_user',
    label: 'Ask the user',
    description: 'Ask the person when you need their decisions (sizes, a material, which variant, whether to go on). '
      + 'Put everything you need to know right now into one call: 1 to 4 questions, each with 2 to 4 short answers to '
      + 'click. They can always type their own answer instead, so do not add an "Other" answer. Prefer this over asking '
      + 'in your reply. The result has their answers.',
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        question: Type.String({ description: 'The question, short and in plain words, in the language of the person.' }),
        header: Type.Optional(Type.String({ description: 'A very short label for the question, 1 to 3 words, e.g. "Material".' })),
        options: Type.Array(Type.Object({
          label: Type.String({ description: 'The answer, a few words.' }),
          description: Type.Optional(Type.String({ description: 'What this answer means for the model, one short sentence.' })),
        }), { minItems: 1, maxItems: 6 }),
        multiSelect: Type.Optional(Type.Boolean({ description: 'true when several answers can apply at once.' })),
      }), { minItems: 1, maxItems: 6 }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: 'text' as const, text: t }], details });
      const qs = params.questions;
      if (!ctx.hasUI) return text('Nobody can answer right now. Decide yourself and say what you assumed.');
      // The signal: when the person stops SOMA AI, the question goes away instead of waiting forever
      const raw = await ctx.ui.input(`${ASK_MARK}${JSON.stringify({ questions: qs })}`, 'Your answers', { signal });
      if (raw === undefined || !raw.trim()) {
        return text(`The person skipped ${qs.length > 1 ? 'the questions' : 'the question'}. Decide yourself and say what you assumed, or ask in your reply.`,
          { answers: qs.map((q) => ({ question: q.question, header: q.header, answer: null })) });
      }
      let answers: (Answer | null)[] = [];
      try { const p = JSON.parse(raw) as { answers?: unknown }; if (Array.isArray(p.answers)) answers = p.answers as (Answer | null)[]; }
      // Not from SOMA's chat (another client of pi): their words as the answer to the first question
      catch { answers = [{ own: raw }]; }
      const results = qs.map((q, i) => ({ q, a: answerText(q, answers[i]) }));
      const lines = results.map(({ q, a }, i) => `${qs.length > 1 ? `${i + 1}. ` : ''}${q.question} → ${a ? a.text : 'skipped, decide yourself and say what you assumed'}`);
      return text(`The person answered:\n${lines.join('\n')}`,
        { answers: results.map(({ q, a }) => ({ question: q.question, header: q.header, answer: a ? a.shown : null, own: a?.own ?? false })) });
    },
  });
}
