// Test der Sperre in `soma build`: Zwei Builds desselben Modells laufen nacheinander statt gleichzeitig in dieselben
// Dateien (App und Agent im Terminal). Ein abgestürzter Build hinterlässt keine Sperre, zu langes Warten endet mit einer
// verständlichen Meldung. Ohne App, nur Python. Aufruf: node test/buildlock.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checker, cleanup, sleep } from './harness.mjs';

const t = checker();
const { check } = t;

const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'soma-dev', 'venv', 'Scripts', 'python.exe');
const ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

// Meldet seinen Start mit einer Datei, dann wartet es SLEEP Sekunden: So hält ein Build die Sperre, solange der Test will
const MODEL = `import os, time
from pathlib import Path
import cadquery as cq
from soma import add_part

Path(__file__).with_name(f"started-{os.getpid()}.txt").write_text("1")
time.sleep(float(os.environ.get("SLEEP", "0")))
add_part("Box", cq.Workplane().box(10, 10, 10))
`;

/** `soma build` im Hintergrund, Ergebnis als Promise mit Ausgaben und Exitcode. */
function build(dir, env = {}) {
  const child = spawn(PY, ['-m', 'soma', 'build', '--project', dir], { env: { ...ENV, ...env }, windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
  return { child, done };
}
const started = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('started-')).length;
async function until(what, pred, ms = 60000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`Zeitlimit: ${what}`); await sleep(100); }
}
const killTree = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-lock-'));
try {
  fs.writeFileSync(path.join(dir, 'model.py'), MODEL);

  // 1) Zwei Builds gleichzeitig: Der zweite wartet, beide gelingen, am Ende passt alles zusammen
  const a = build(dir, { SLEEP: '10' }); // länger als ein Python-Start unter Last
  await until('erster Build läuft', () => started(dir) >= 1);
  const b = build(dir);
  const [ra, rb] = await Promise.all([a.done, b.done]);
  check('Zwei Builds gleichzeitig: beide ok', ra.code === 0 && rb.code === 0, (ra.err + rb.err).slice(-200));
  check('Der zweite wartet auf den ersten und sagt es', rb.err.includes('Waiting for another build'), rb.err.slice(0, 120));
  const soma = path.join(dir, '.soma');
  const map = JSON.parse(fs.readFileSync(path.join(soma, 'model.map.json'), 'utf8'));
  const geo = fs.readdirSync(path.join(soma, 'geometry'));
  check('model.map.json zeigt auf eine vorhandene Geometrie, nur diese liegt noch da, keine Zwischendateien',
    geo.filter((f) => f.endsWith('.brep')).join() === `${map.build}.brep` && !geo.some((f) => f.endsWith('.tmp')), geo.join(', '));
  const last = JSON.parse(fs.readFileSync(path.join(soma, 'build.json'), 'utf8'));
  const firstStart = Math.min(...fs.readdirSync(dir).filter((f) => f.startsWith('started-')).map((f) => fs.statSync(path.join(dir, f)).mtimeMs));
  check('Der zweite Build beginnt erst nach dem ersten (der 10 s schläft)', last.status === 'ok' && last.started * 1000 >= firstStart + 9900,
    `${((last.started * 1000 - firstStart) / 1000).toFixed(2)} s nach dem Start des ersten`);

  // 2) Abgestürzter Build: Die Sperre endet mit dem Prozess
  for (const f of fs.readdirSync(dir)) if (f.startsWith('started-')) fs.rmSync(path.join(dir, f));
  const c = build(dir, { SLEEP: '60' });
  await until('Build hält die Sperre', () => started(dir) >= 1);
  killTree(c.child.pid);
  await c.done;
  const rd = await build(dir).done;
  check('Nach einem abgebrochenen Build: nächster Build ohne Warten ok', rd.code === 0 && !rd.err.includes('Waiting'), rd.err.slice(-200));

  // 3) Zu langes Warten: verständliche Meldung, build.json des laufenden Builds bleibt unangetastet
  for (const f of fs.readdirSync(dir)) if (f.startsWith('started-')) fs.rmSync(path.join(dir, f));
  const before = fs.readFileSync(path.join(soma, 'build.json'), 'utf8');
  const e = build(dir, { SLEEP: '60' });
  await until('Build hält die Sperre', () => started(dir) >= 1);
  const rf = await build(dir, { SOMA_BUILD_LOCK_WAIT_S: '1' }).done;
  check('Zeitlimit beim Warten: Build ERROR mit Hinweis auf den anderen Build', rf.code === 1 && rf.err.includes('Another build of this model has been running'), rf.err.slice(-200));
  check('build.json bleibt die des laufenden Builds', fs.readFileSync(path.join(soma, 'build.json'), 'utf8') === before);
  killTree(e.child.pid);
  await e.done;
} catch (err) {
  console.log('ABBRUCH:', err.message);
  t.fail();
}
await sleep(300);
cleanup(dir);
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
