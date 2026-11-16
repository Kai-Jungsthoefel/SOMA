// Lists from pi's SDK for SOMA AI (app/src/main/somaaiauth.ts), without pi running: offline, pi's folder from
// PI_CODING_AGENT_DIR. Arguments: pi's bundle (index.js), then
//   models          the models of the saved sign-ins (pi's catalog plus models.json), for Settings > SOMA AI
//   sessions <dir>  the conversations of a model folder, newest first, for "Earlier conversations" in the chat
// One JSON line on stdout: {models: [{provider, id, name}]}, {sessions: [{id, path, title, modified, messages}]} or {error}.
import { pathToFileURL } from 'node:url';

const [, , piIndex, what, dir] = process.argv;
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

try {
  const pi = await import(pathToFileURL(piIndex).href);
  if (what === 'models') {
    const runtime = await pi.ModelRuntime.create({ refreshOnCreate: false });
    const list = await runtime.getAvailable();
    say({ models: list.map((m) => ({ provider: m.provider, id: m.id, name: m.name || m.id })) });
  } else if (what === 'sessions' && dir) {
    const list = await pi.SessionManager.list(dir);
    say({
      sessions: list.filter((s) => s.messageCount > 0).map((s) => ({
        id: s.id, path: s.path, title: (s.name || s.firstMessage || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        modified: s.modified instanceof Date ? s.modified.getTime() : 0, messages: s.messageCount,
      })),
    });
  } else say({ error: `Unknown list: ${what}` });
  process.exit(0);
} catch (e) {
  say({ error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
