import { net } from 'electron';
import type { UpdateInfo } from '../shared/types';
import { SOMA_VERSION, isNewerVersion, parseVersion } from '../shared/version';

/**
 * Neue Version auf GitHub (Startseite): fragt die Liste unter Releases ab und nimmt die höchste Versionsnummer. Nicht
 * `releases/latest`: Das übergeht Vorabversionen, und die CI veröffentlicht alle 0.x als „Pre-release“. Entwürfe zählen
 * nicht (ohne Anmeldung ohnehin unsichtbar). Nur lesen und anzeigen, die
 * App lädt und installiert nichts (E28). Über net.fetch, damit der Proxy des Systems gilt. Einmal je Sitzung: Ohne Anmeldung
 * erlaubt GitHub 60 Anfragen pro Stunde. Ein Fehler wird höchstens einmal pro Minute wiederholt.
 * `SOMA_UPDATE_URL` ersetzt die Adresse (Tests). Im Test ohne sie gibt es keine Anfrage ins Netz.
 */

const REPO = 'https://github.com/Kai-Jungsthoefel/SOMA';
const API = 'https://api.github.com/repos/Kai-Jungsthoefel/SOMA/releases?per_page=30';
const RELEASES = `${REPO}/releases`;
const RETRY_MS = 60_000;

let done: UpdateInfo | null = null;
let running: Promise<UpdateInfo> | null = null;
let failedAt = 0;
let lastError: UpdateInfo | null = null;

/** `enabled`: Einstellung „updateCheck“. Ausgeschaltet geht keine Anfrage ins Netz. */
export async function checkUpdate(enabled: boolean): Promise<UpdateInfo> {
  if (!enabled) return { state: 'skipped', current: SOMA_VERSION, url: RELEASES };
  if (done) return done;
  if (running) return running;
  if (lastError && Date.now() - failedAt < RETRY_MS) return lastError;
  running = fetchLatest().finally(() => { running = null; });
  const r = await running;
  if (r.state === 'error') { lastError = r; failedAt = Date.now(); } else done = r;
  return r;
}

async function fetchLatest(): Promise<UpdateInfo> {
  const base = { current: SOMA_VERSION, url: RELEASES };
  const url = process.env.SOMA_UPDATE_URL || (process.env.SOMA_TEST === '1' ? '' : API);
  if (!url) return { ...base, state: 'skipped' };
  let res: Response;
  try {
    res = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `SOMA/${SOMA_VERSION}` }, signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...base, state: 'error', error: /abort|timeout/i.test(msg) ? 'GitHub did not answer in time.' : `GitHub could not be reached (${msg}).` };
  }
  // 404: Projekt nicht (mehr) öffentlich, 403/429: Grenze der Anfragen erreicht
  if (res.status === 404) return { ...base, state: 'error', error: 'GitHub does not find the project.' };
  if (res.status === 403 || res.status === 429) return { ...base, state: 'error', error: 'GitHub limits requests at the moment. Try again later.' };
  if (!res.ok) return { ...base, state: 'error', error: `GitHub answered with status ${res.status}.` };
  let body: unknown;
  try { body = await res.json(); } catch { return { ...base, state: 'error', error: 'GitHub sent an answer SOMA cannot read.' }; }
  // Die Antwort ist nicht vertrauenswürdig: nur lesbare Nummern und Links auf die Seite des Projekts übernehmen
  if (!Array.isArray(body)) return { ...base, state: 'error', error: 'GitHub sent an answer SOMA cannot read.' };
  const list = body.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && (x as Record<string, unknown>).draft !== true);
  if (!list.length) return { ...base, state: 'error', error: 'GitHub lists no release yet.' };
  const tagOf = (x: Record<string, unknown>) => (typeof x.tag_name === 'string' ? x.tag_name.trim() : '');
  let b: Record<string, unknown> | null = null;
  for (const x of list) {
    const v = tagOf(x).replace(/^v/i, '');
    if (parseVersion(v) && (!b || isNewerVersion(v, tagOf(b).replace(/^v/i, '')))) b = x;
  }
  if (!b) return { ...base, state: 'error', error: `No release has a version SOMA can read (${tagOf(list[0]).slice(0, 40) || 'none'}).` };
  const latest = tagOf(b).replace(/^v/i, '');
  const page = typeof b.html_url === 'string' && b.html_url.startsWith(`${RELEASES}/`) ? b.html_url : RELEASES;
  const published = typeof b.published_at === 'string' && !Number.isNaN(Date.parse(b.published_at)) ? b.published_at : undefined;
  return { ...base, state: isNewerVersion(latest) ? 'newer' : 'current', latest, url: page, ...(published ? { published } : {}) };
}
