// Führt die Testdateien parallel aus. Jede App-Suite bekommt einen freien Port vom System (SOMA_TEST_PORT), damit sich
// parallele Läufe und andere Sessions nicht gegenseitig die App fernsteuern. Die Ausgabe einer Suite erscheint am Stück,
// sobald sie fertig ist. Aufruf: npm test (baut vorher). Einzelne Suiten: node test/run-all.mjs smoke editor.
// Langsame Suiten (Animation, FEM, je etwa 6 Minuten) laufen nur mit --all (npm run test:all) oder ausdrücklich genannt:
// Sie betreffen wenige Dateien und verdoppelten sonst die Dauer jedes Laufs.
// SOMA_TEST_JOBS legt fest, wie viele gleichzeitig laufen (Standard 4; 1 = nacheinander wie früher).
// Parallel läuft jede Suite langsamer, deshalb ist ihr Watchdog länger (15 statt 6 Minuten, SOMA_TEST_WATCHDOG_S).
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const DIR = import.meta.dirname;
// Längste zuerst, damit sie nicht am Ende allein laufen
const ALL = ['animation', 'fem', 'versions', 'smoke', 'editor', 'skills', 'params', 'explode', 'fasteners', 'drawing', 'drawview', 'section', 'measure', 'stepview', 'cadquery', 'folder', 'groups', 'dxf', 'packages', 'settings', 'tutorial', 'updates', 'buildlock', 'meshexport', 'unit'];
const SLOW = ['animation', 'fem'];
const args = process.argv.slice(2);
const all = args.includes('--all');
const wanted = args.filter((a) => a !== '--all');
const unknown = wanted.filter((s) => !ALL.includes(s));
if (unknown.length) { console.log(`Unbekannte Suite: ${unknown.join(', ')}. Vorhanden: ${ALL.join(', ')}`); process.exit(2); }
const suites = wanted.length ? ALL.filter((s) => wanted.includes(s)) : all ? ALL : ALL.filter((s) => !SLOW.includes(s));
const skipped = wanted.length || all ? [] : SLOW;
const jobs = Math.max(1, Number(process.env.SOMA_TEST_JOBS) || 4);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const fmt = (ms) => `${(ms / 1000).toFixed(0)} s`;

async function run(name) {
  const port = await freePort();
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(DIR, `${name}.mjs`)], {
      cwd: path.dirname(DIR), env: { SOMA_TEST_WATCHDOG_S: '900', ...process.env, SOMA_TEST_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      const ms = Date.now() - t0;
      const checks = (out.match(/^OK /gm) ?? []).length;
      const fails = (out.match(/^FEHLER /gm) ?? []).length;
      console.log(`\n===== ${name} (Port ${port}, ${fmt(ms)}) =====\n${out.trimEnd()}`);
      resolve({ name, code, ms, checks, fails });
    });
  });
}

const t0 = Date.now();
const queue = [...suites];
const results = [];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) results.push(await run(queue.shift()));
}));

console.log(`\n===== Übersicht (${suites.length} Suiten, ${jobs} gleichzeitig, ${fmt(Date.now() - t0)}) =====`);
for (const r of results.sort((a, b) => ALL.indexOf(a.name) - ALL.indexOf(b.name))) {
  console.log(`${r.code === 0 ? 'OK     ' : 'FEHLER '}${r.name.padEnd(12)}${fmt(r.ms).padStart(7)}   ${r.checks} OK${r.fails ? `, ${r.fails} FEHLER` : ''}${r.code !== 0 && !r.fails ? `, Exit ${r.code}` : ''}`);
}
const bad = results.filter((r) => r.code !== 0);
if (skipped.length) console.log(`\nNicht gelaufen (langsam): ${skipped.join(', ')}. Alle mit npm run test:all`);
console.log(bad.length ? `\n${bad.length} Suite(n) fehlgeschlagen: ${bad.map((r) => r.name).join(', ')}` : '\nALLE SUITEN BESTANDEN');
process.exit(bad.length ? 1 : 0);
