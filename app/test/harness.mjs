// Gemeinsame Testhilfe: startet die echte Electron-App mit isolierten App-Daten und steuert sie per CDP.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { electronExe } from '../scripts/electron-local.mjs';
import { connectPage } from './cdp.mjs';

export const APP = path.resolve(import.meta.dirname, '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ist der Port frei? Probeweise belegen, wie Electron es für den Debug-Port tut. */
const portFree = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});

/**
 * Startet die App. Standard: Fenster unsichtbar (SMOKE_VISIBLE=1 zeigt es), eigener App-Daten-Ordner,
 * Watchdog (hängt etwas, wird alles hart beendet). `userData` erlaubt einen Neustart mit denselben Daten, `env` setzt weitere
 * Umgebungsvariablen (etwa `SOMA_TEST_START: 'home'`: Start auf der Startseite wie außerhalb der Tests, statt gleich mit einem Modell).
 */
export async function startApp({ port = Number(process.env.SOMA_TEST_PORT) || 9333, userData, watchdogMs = (Number(process.env.SOMA_TEST_WATCHDOG_S) || 6 * 60) * 1000, name = 'test', env = {} } = {}) {
  // SMOKE_VISIBLE=1 sichtbar, =offscreen angezeigt außerhalb des Bildschirms (frische Screenshots, kein Fokusklau), sonst unsichtbar
  const mode = process.env.SMOKE_VISIBLE;
  const visible = mode === '1';
  const ud = userData ?? fs.mkdtempSync(path.join(os.tmpdir(), `soma-${name}-`));
  // Nach einem harten Beenden kann ein Kindprozess der alten App den Debug-Port noch kurz halten (geerbter Socket):
  // warten, sonst startet Electron ohne Debug-Port und der Test findet kein Fenster
  for (const t0 = Date.now(); !(await portFree(port)) && Date.now() - t0 < 30000;) await sleep(300);
  const child = spawn(electronExe(APP), ['.', `--remote-debugging-port=${port}`], {
    cwd: APP, env: { ...process.env, SOMA_USER_DATA: ud, SOMA_TEST: '1', SOMA_HIDDEN: visible ? '0' : mode === 'offscreen' ? 'offscreen' : '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const kill = () => {
    if (process.platform !== 'win32') { child.kill('SIGKILL'); return; }
    if (spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).status === 0) return;
    // taskkill /T lässt den ganzen Baum stehen, sobald sich ein Kind nicht beenden lässt. Das passiert mit den kurzlebigen
    // Hilfsprozessen von node-pty (entstehen beim Schließen eines Terminals). Und unter Last braucht der Hauptprozess nach
    // dem Beenden teils viele Sekunden, bis er wirklich weg ist (etwa wenn App und Git auf einem Netzlaufwerk liegen). Solange hält er
    // Debug-Port und App-Daten fest, ein Neustart mit denselben Daten fände kein Fenster. Deshalb: Kinder einzeln beenden
    // (sie können den Port geerbt haben), dann den Hauptprozess, warten, bis er weg ist, und noch einmal die Kinder.
    const killKids = () => {
      const kids = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}").ProcessId`], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
      for (const pid of kids.split(/\s+/).filter((p) => /^\d+$/.test(p))) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true });
    };
    killKids();
    const alive = () => new RegExp(`\\b${child.pid}\\b`).test(spawnSync('tasklist', ['/FI', `PID eq ${child.pid}`, '/NH'], { encoding: 'utf8', windowsHide: true }).stdout ?? '');
    for (const t0 = Date.now(); alive() && Date.now() - t0 < 60000;) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/F'], { windowsHide: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    killKids();
  };
  const dog = setTimeout(() => { console.log('ABBRUCH: Watchdog'); kill(); process.exit(1); }, watchdogMs);
  dog.unref();

  const page = await connectPage(port, 'index.html', 60000);
  if (!page) { kill(); throw new Error('Electron nicht erreichbar oder kein Fenster. ' + log.slice(-600)); }

  const ev = (fn, arg) => page.evaluate(fn, arg);
  const app = {
    ud, page, ev, visible, log: () => log,
    /** Wartet, bis fn im Fenster einen wahren Wert liefert. */
    async waitFor(desc, fn, timeout = 60000, arg) {
      const t0 = Date.now();
      for (;;) {
        try { const v = await ev(fn, arg); if (v) return v; } catch { /* Seite lädt noch */ }
        if (Date.now() - t0 > timeout) throw new Error(`Zeitüberschreitung: ${desc}`);
        await sleep(200);
      }
    },
    domClick: (id) => ev((i) => document.getElementById(i).click(), id),
    /** Antworten für die nächsten nativen Dialoge (Pfade, Knopf-Indizes). */
    answers: (list) => ev((a) => window.soma.test.answers(a), list),
    /** Screenshot des Fensters (über Electron, funktioniert auch bei unsichtbarem Fenster). */
    screenshot: (file) => ev((f) => window.soma.test.screenshot(f), file),
    /** Beendet die App hart (wie ein Absturz). */
    crash() { clearTimeout(dog); page.close(); kill(); },
    async stop() { clearTimeout(dog); page.close(); kill(); await sleep(600); },
  };
  return app;
}

/** Sammelt Prüfungen und gibt sie einheitlich aus. */
export function checker() {
  let fails = 0;
  // SOMA_TEST_TIMES=1: Sekunden seit Start vor jeder Prüfung, um langsame Stellen zu finden
  const t0 = Date.now();
  const stamp = () => process.env.SOMA_TEST_TIMES ? `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ` : '';
  const check = (label, ok, detail = '') => { console.log((ok ? 'OK     ' : 'FEHLER ') + stamp() + label.padEnd(68) + detail); if (!ok) fails++; };
  return { check, fail: () => { fails++; }, get fails() { return fails; } };
}

export function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Dateien noch gesperrt */ } }
