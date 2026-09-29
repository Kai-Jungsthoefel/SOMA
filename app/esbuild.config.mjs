// Bundelt Hauptprozess, Preload und Renderer nach dist/. Kein Framework, nur TypeScript.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };
await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs',
          external: ['electron', 'node-pty'] }),
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js', platform: 'node', format: 'cjs',
          external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/main.ts'], outfile: 'dist/renderer/main.js', platform: 'browser', format: 'iife' }),
]);
fs.mkdirSync('dist/renderer', { recursive: true });
fs.copyFileSync('src/renderer/index.html', 'dist/renderer/index.html');
fs.copyFileSync('src/renderer/style.css', 'dist/renderer/style.css');
fs.copyFileSync(path.join('node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'dist/renderer/xterm.css');
