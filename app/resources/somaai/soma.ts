// SOMA's own extension for pi (SOMA AI, app/src/main/somaai.ts). pi loads it at start with -e.
import { Type } from 'typebox';
import {
  DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_BYTES, MAX_TEXT_BYTES, TEXT_TIMEOUT_MS,
  decodeBody, downloadTarget, fetchChecked, htmlToText, pageOf, readLimited, refusalText, refuseUrl, saveBody, sizeText,
} from './webfetch.ts';

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
interface Ui {
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}
interface Ctx { hasUI: boolean; ui: Ui; cwd: string }
type ToolResult = { content: { type: 'text'; text: string }[]; details: Record<string, unknown> };
interface Pi {
  registerTool<P>(tool: {
    name: string; label: string; description: string; parameters: unknown;
    execute(id: string, params: P, signal: AbortSignal | undefined, onUpdate: unknown, ctx: Ctx): Promise<ToolResult>;
  }): void;
}
interface FetchParams { url: string; path?: string; offset?: number }

/**
 * Start of the question before web_fetch opens a website. The chat (app/src/renderer/chat.ts) shows it like the
 * questions of the permission extension: "Permission Required" and one fact per line.
 */
const WEB_SURFACE = 'web_fetch';
/** The honest name of SOMA AI towards websites (the version comes from the app, somaai.ts). */
const userAgent = () => `SOMA-AI/${process.env.SOMA_VERSION ?? '1'} (+https://github.com/Kai-Jungsthoefel/SOMA)`;

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
  pi.registerTool<AskParams>({
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

  // Websites the person allowed until the model is closed (one pi per open model, somaai.ts)
  const allowedSites = new Set<string>();
  let asking: Promise<unknown> = Promise.resolve();
  const site = (u: URL) => u.hostname.replace(/^www\./, '').toLowerCase();

  pi.registerTool<FetchParams>({
    name: 'web_fetch',
    label: 'Open a website',
    description: 'Read a web page as text, or download a file from the internet into the model folder. Use it for product '
      + 'pages, data sheets and CAD downloads (STEP files of parts) instead of curl, wget or scripts: SOMA asks the person '
      + 'once per website. Without `path` it returns the page as text with its links, the links to files (STEP, ZIP, PDF …) '
      + 'and product data (price, part number) when the shop provides them. With `path` (e.g. "inputs/608zz.step") it saves '
      + 'the file there; existing files are never overwritten. Pages that build their content with JavaScript, need a '
      + 'sign-in or refuse programs cannot be read: then tell the person and ask them to download the file themselves. Never '
      + 'try to get around a refusal.',
    parameters: Type.Object({
      url: Type.String({ description: 'The full address, starting with https:// or http://.' }),
      path: Type.Optional(Type.String({ description: 'Download: where to save the file inside the model folder, e.g. "inputs/motor.step". Leave out to read the page.' })),
      offset: Type.Optional(Type.Number({ description: 'Reading a long page: where to continue, as the previous result says.' })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: 'text' as const, text: t }], details });
      let url: URL;
      try { url = new URL(String(params.url ?? '').trim()); } catch { throw new Error(`"${String(params.url).slice(0, 200)}" is not a web address.`); }
      const refused = await refuseUrl(url);
      if (refused) throw new Error(refused);
      const target = params.path ? downloadTarget(ctx.cwd, params.path) : null;
      if (target && 'error' in target) throw new Error(target.error);

      const host = site(url);
      if (!allowedSites.has(host)) {
        if (!ctx.hasUI) throw new Error('Nobody can allow opening websites right now. Say which page you need and why.');
        // One question at a time: models open several pages at once, the chat answers one question after the other.
        // After waiting, the site may have been allowed meanwhile
        const turn = asking.then(async () => {
          if (allowedSites.has(host)) return 'Yes';
          const session = `Yes, allow ${host} until the model is closed`;
          const title = ['Permission Required', `surface : ${WEB_SURFACE}`, `site : ${host}`, `url : ${url.href}`,
            ...(params.path ? [`save to : ${params.path}`] : [])].join('\n');
          const choice = await ctx.ui.select(title, ['Yes', session, 'No'], { signal });
          if (choice === session) allowedSites.add(host);
          return choice === session ? 'Yes' : choice;
        });
        asking = turn.catch(() => undefined);
        if ((await turn) !== 'Yes') throw new Error(`The person denied opening ${host}. Do not try to reach it another way: work without it or ask them.`);
      }

      const download = !!target;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error('timeout')), download ? DOWNLOAD_TIMEOUT_MS : TEXT_TIMEOUT_MS);
      const onAbort = () => ctl.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const got = await fetchChecked(url, ctl.signal, userAgent(), download ? '*/*' : 'text/html, application/xhtml+xml, text/plain;q=0.9, */*;q=0.5');
        if (typeof got === 'string') throw new Error(got);
        const { response, url: final, redirects } = got;
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(refusalText(response.status, final)); }
        const type = response.headers.get('content-type') ?? '';
        const moved = redirects.length ? `\nFinal address: ${final.href}` : '';

        if (target && 'file' in target) {
          const saved = await saveBody(response, target.file, MAX_DOWNLOAD_BYTES);
          if ('error' in saved) throw new Error(saved.error);
          return text(`Saved ${params.path} (${sizeText(saved.bytes)}${saved.kind ? `, ${saved.kind}` : ''}).${moved}`
            + (saved.kind === 'ZIP' ? '\nIt is a ZIP archive: unpack it (python -m zipfile -e) and use the file you need.' : ''),
          { url: final.href, path: params.path, bytes: saved.bytes, kind: saved.kind });
        }

        const textual = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|javascript)|image\/svg)/i.test(type) || !type;
        if (!textual) {
          await response.body?.cancel().catch(() => {});
          const len = Number(response.headers.get('content-length'));
          return text(`This address is a file (${type.split(';')[0]}${len > 0 ? `, ${sizeText(len)}` : ''}), not a page. To use it, call web_fetch again with \`path\`, e.g. "inputs/${decodeURIComponent(final.pathname.split('/').pop() || 'download')}".${moved}`, { url: final.href, type });
        }
        const { data, cut } = await readLimited(response, MAX_TEXT_BYTES);
        const body = decodeBody(data, type);
        const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
        if (!/html|xml/i.test(type) && !/^\s*<(!doctype html|html)/i.test(body)) {
          return text(`${final.href}${cut ? ' (only the start, the page is very large)' : ''}\n\n${pageOf(body, offset)}`, { url: final.href, type });
        }
        const page = htmlToText(body, final);
        const head = [
          `# ${page.title || final.href}`, `Address: ${final.href}`,
          ...(offset === 0 && page.facts.length ? ['', 'Product data of the page:', ...page.facts.map((f) => `- ${f}`)] : []),
          ...(offset === 0 && page.files.length ? ['', 'Links to files:', ...page.files.slice(0, 40).map((f) => `- ${f}`)] : []),
          ...(page.scripted ? ['', 'Note: this page builds most of its content with JavaScript, which web_fetch does not run. What it shows may be missing here. Do not try to get around it: search for another source or ask the person.'] : []),
          ...(cut ? ['', 'Note: the page is very large, only its start was read.'] : []),
        ].join('\n');
        return text(`${head}\n\n${pageOf(page.text, offset)}`, { url: final.href, title: page.title, files: page.files.length, chars: page.text.length });
      } catch (e) {
        if (signal?.aborted) throw new Error('Stopped.');
        if (ctl.signal.aborted) throw new Error(`${host} did not answer in time.`);
        throw e instanceof Error && !/fetch failed/i.test(e.message) ? e
          : new Error(`${host} could not be reached (${e instanceof Error ? ((e as { cause?: { code?: string } }).cause?.code ?? e.message) : String(e)}).`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  });
}
