// Bundelt Hauptprozess, Preload und Renderer nach dist/. Kein Framework, nur TypeScript.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

// Versionsnummer von SOMA (E68) aus package.json, für alle Teile gleich (src/shared/version.ts)
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022', define: { __SOMA_VERSION__: JSON.stringify(version) } };
await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs',
          external: ['electron', 'node-pty', 'dugite'] }),
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js', platform: 'node', format: 'cjs',
          external: ['electron'] }),
  // Unsichtbares Render-Fenster für soma render (E58): eigener Preload und eigene Seite, derselbe Viewer
  build({ ...common, entryPoints: ['src/preload/render-preload.ts'], outfile: 'dist/preload/render-preload.js', platform: 'node', format: 'cjs',
          external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/render.ts'], outfile: 'dist/renderer/render.js', platform: 'browser', format: 'iife' }),
  build({ ...common, entryPoints: ['src/renderer/main.ts'], outfile: 'dist/renderer/main.js', platform: 'browser', format: 'iife' }),
  // Worker von pdf.js als klassisches Skript: Module aus file:// lädt Chromium nicht (E54)
  build({ ...common, sourcemap: false, entryPoints: ['node_modules/pdfjs-dist/build/pdf.worker.mjs'], outfile: 'dist/renderer/pdf.worker.js', platform: 'browser', format: 'iife' }),
]);
// Komponenten für „About“ in den Einstellungen (E81): Name, Version und Lizenz der npm-Pakete, die die App mitbringt,
// gelesen aus ihren package.json. Electron selbst nennt die App zur Laufzeit.
const { dependencies = {} } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const components = Object.keys(dependencies).sort().map((name) => {
  try {
    const p = JSON.parse(fs.readFileSync(path.join('node_modules', name, 'package.json'), 'utf8'));
    return { name, version: p.version ?? '', license: typeof p.license === 'string' ? p.license : p.license?.type ?? '' };
  } catch { return { name, version: '', license: '' }; }
});
fs.writeFileSync('dist/main/components.json', `${JSON.stringify(components, null, 2)}\n`);

// Lizenztexte der npm-Pakete nach dist/licenses/<paket>/ (THIRD_PARTY_NOTICES.md). esbuild übernimmt beim Bündeln nur
// Kommentare mit @license, MIT und Co. verlangen aber den Text bei jeder Weitergabe. Gesammelt werden alle Laufzeit-
// Abhängigkeiten samt ihren eigenen, aufgelöst wie Node (erst verschachtelt, dann flach). Optionale, die npm auf diesem
// System nicht installiert hat, fehlen eben. Lieber ein Paket zu viel als eins zu wenig.
fs.rmSync('dist/licenses', { recursive: true, force: true });
const licensed = new Set();
const appDir = path.resolve('.');
const collect = (name, from) => {
  let dir = from;
  while (!fs.existsSync(path.join(dir, 'node_modules', name, 'package.json'))) {
    if (dir === appDir) return;
    dir = path.dirname(dir);
  }
  const pkgDir = path.join(dir, 'node_modules', name);
  if (licensed.has(pkgDir)) return;
  licensed.add(pkgDir);
  const p = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const out = path.join('dist/licenses', `${name.replace('/', '__')}@${p.version}`);
  for (const f of fs.readdirSync(pkgDir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f))) {
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(path.join(pkgDir, f), path.join(out, f));
  }
  for (const dep of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) collect(dep, pkgDir);
};
for (const name of Object.keys(dependencies)) collect(name, appDir);
// winpty liegt in node-pty unter deps/, das die Paketierung weglässt (electron-builder.config.cjs)
const winpty = path.join('node_modules', 'node-pty', 'deps', 'winpty', 'LICENSE');
if (fs.existsSync(winpty)) {
  fs.mkdirSync('dist/licenses/node-pty__winpty', { recursive: true });
  fs.copyFileSync(winpty, 'dist/licenses/node-pty__winpty/LICENSE');
}

fs.mkdirSync('dist/renderer', { recursive: true });
fs.copyFileSync('src/renderer/index.html', 'dist/renderer/index.html');
fs.copyFileSync('src/renderer/render.html', 'dist/renderer/render.html');
fs.copyFileSync('src/renderer/style.css', 'dist/renderer/style.css');
// App-Icon für den Ladebildschirm (index.html), der zeigt sich, bevor icons.ts geladen ist
fs.copyFileSync('resources/icon.svg', 'dist/renderer/logo.svg');
fs.copyFileSync(path.join('node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'dist/renderer/xterm.css');

// Daten von pdf.js (Apache 2.0): Zeichentabellen für asiatische Schriften, Ersatz für nicht eingebettete Standardschriften,
// Decoder für JPEG 2000 und JBIG2. Ohne sie zeigt pdf.js manche Dateien nur unvollständig.
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  fs.cpSync(path.join('node_modules', 'pdfjs-dist', dir), path.join('dist/renderer/pdfjs', dir), { recursive: true });
}
fs.copyFileSync(path.join('node_modules', 'pdfjs-dist', 'LICENSE'), 'dist/renderer/pdfjs/LICENSE');

// Schriften liegen lokal bei (die Content-Security-Policy erlaubt nur eigene Dateien, offline muss es auch gehen).
// IBM Plex steht unter der SIL Open Font License.
fs.mkdirSync('dist/renderer/fonts', { recursive: true });
for (const [pkg, weights] of [['ibm-plex-sans', [400, 500, 600]], ['ibm-plex-mono', [400, 500, 700]]]) {
  for (const w of weights) {
    for (const subset of ['latin', 'latin-ext']) {
      const file = `${pkg}-${subset}-${w}-normal.woff2`;
      fs.copyFileSync(path.join('node_modules', '@fontsource', pkg, 'files', file), path.join('dist/renderer/fonts', file));
    }
  }
}
