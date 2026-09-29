// Startet die App für die Entwicklung (nach `npm run build`). Weitere Argumente gehen an Electron durch.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { electronExe } from './electron-local.mjs';

const app = path.resolve(import.meta.dirname, '..');
const child = spawn(electronExe(app), ['.', ...process.argv.slice(2)], { cwd: app, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
