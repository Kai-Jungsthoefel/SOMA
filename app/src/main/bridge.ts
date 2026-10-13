import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { userDataDir } from './paths';

/**
 * Verbindung von `soma` im Terminal zur App (E58), etwa für `soma render`: ein HTTP-Dienst nur auf 127.0.0.1, mit einem
 * zufälligen Port und einem Schlüssel je App-Start. Beides bekommen nur die Terminals der App als Umgebungsvariablen
 * (SOMA_APP, SOMA_APP_TOKEN). Andere Programme kennen den Schlüssel nicht, Anfragen ohne ihn werden abgelehnt.
 *
 * Manche Agenten führen ihre Befehle nicht in der Shell aus, in der sie gestartet wurden: Codex etwa über einen
 * Hintergrunddienst, der die Umgebung des Programms behält, aus dem er zuerst gestartet wurde (z. B. VS Code), und
 * Variablen mit TOKEN im Namen filtert Codex ohnehin heraus. Deshalb stehen beide zusätzlich in `bridge.json` in den
 * App-Daten, neben `workspaces/`: `soma` findet die Datei vom Arbeitsordner aus. Nie im Projekt, so kann der Schlüssel
 * weder in Git noch in die Modelldatei geraten.
 */
export type BridgeHandler = (route: string, body: unknown) => Promise<{ status: number; body: unknown }>;

const MAX_BODY = 1024 * 1024;

let server: http.Server | null = null;
let port = 0;
const token = crypto.randomBytes(24).toString('hex');

/** Startet den Dienst (einmal je App). Scheitert er, laufen die Terminals ohne SOMA_APP, `soma render` erklärt das dann. */
export function startBridge(handler: BridgeHandler): Promise<void> {
  if (server) return Promise.resolve();
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => void serve(req, res, handler));
    srv.on('error', (e) => { console.error('[soma] Connection for soma render not available:', e); server = null; port = 0; resolve(); });
    // Port 0: das System vergibt einen freien (ein fester Port kann schon belegt sein)
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      port = typeof a === 'object' && a ? a.port : 0;
      server = srv;
      writeBridgeFile();
      resolve();
    });
  });
}

export function stopBridge(): void { server?.close(); server = null; port = 0; removeBridgeFile(); }

const bridgeFile = () => path.join(userDataDir(), 'bridge.json');

/** Nur eine Erleichterung: Scheitert das Schreiben, bleiben die Umgebungsvariablen. */
function writeBridgeFile(): void {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(bridgeFile(), JSON.stringify({ app: `127.0.0.1:${port}`, token, pid: process.pid }), { mode: 0o600 });
  } catch (e) { console.error('[soma] Could not write bridge.json:', e); }
}

/** Nur die eigene: Eine zweite laufende App kann die Datei inzwischen überschrieben haben. */
function removeBridgeFile(): void {
  try {
    const cur = JSON.parse(fs.readFileSync(bridgeFile(), 'utf8')) as { token?: string };
    if (cur.token === token) fs.rmSync(bridgeFile(), { force: true });
  } catch { /* keine Datei oder unlesbar: nichts zu tun */ }
}

/** Umgebungsvariablen für Terminals: Adresse und Schlüssel, leer ohne laufenden Dienst. */
export function bridgeEnv(): Record<string, string> {
  return port ? { SOMA_APP: `127.0.0.1:${port}`, SOMA_APP_TOKEN: token } : {};
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length });
  res.end(data);
}

async function serve(req: http.IncomingMessage, res: http.ServerResponse, handler: BridgeHandler): Promise<void> {
  try {
    const given = String(req.headers['x-soma-token'] ?? '');
    const ok = given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (!ok) { reply(res, 403, { ok: false, error: 'Wrong key. Only the terminals of the app may talk to the app.' }); return; }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/')) { reply(res, 404, { ok: false, error: 'Unknown request' }); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) { reply(res, 413, { ok: false, error: 'Request too large' }); return; }
      chunks.push(c as Buffer);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(res, 400, { ok: false, error: 'Not valid JSON' }); return; }
    const r = await handler(req.url.slice(4), body);
    reply(res, r.status, r.body);
  } catch (e) {
    reply(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
