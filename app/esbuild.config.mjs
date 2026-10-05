// Bundelt Hauptprozess, Preload und Renderer nach dist/. Kein Framework, nur TypeScript.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };
await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs',
          external: ['electron', 'node-pty', 'dugite'] }),
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js', platform: 'node', format: 'cjs',
          external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/main.ts'], outfile: 'dist/renderer/main.js', platform: 'browser', format: 'iife' }),
  // Worker von pdf.js als klassisches Skript: Module aus file:// lädt Chromium nicht (E54)
  build({ ...common, sourcemap: false, entryPoints: ['node_modules/pdfjs-dist/build/pdf.worker.mjs'], outfile: 'dist/renderer/pdf.worker.js', platform: 'browser', format: 'iife' }),
]);
fs.mkdirSync('dist/renderer', { recursive: true });
fs.copyFileSync('src/renderer/index.html', 'dist/renderer/index.html');
fs.copyFileSync('src/renderer/style.css', 'dist/renderer/style.css');
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
for (const [pkg, weights] of [['ibm-plex-sans', [400, 500, 600]], ['ibm-plex-mono', [400, 500]]]) {
  for (const w of weights) {
    for (const subset of ['latin', 'latin-ext']) {
      const file = `${pkg}-${subset}-${w}-normal.woff2`;
      fs.copyFileSync(path.join('node_modules', '@fontsource', pkg, 'files', file), path.join('dist/renderer/fonts', file));
    }
  }
}
