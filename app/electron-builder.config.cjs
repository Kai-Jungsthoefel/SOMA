// Installationspakete mit electron-builder (`npm run dist`, Ablauf in app/README.md). Gebaut wird je Betriebssystem auf
// diesem System, die Python-Basisumgebung und das Git von dugite sind plattformabhängig (CI: .github/workflows/dist.yml).
//
// Vorher muss die Python-Basisumgebung gebaut sein (python/scripts/build_runtime.py). Sie liegt standardmäßig in
// app/python-runtime, SOMA_RUNTIME zeigt auf einen anderen Ordner. Lokal gehört sie nicht in einen synchronisierten Ordner
// (OneDrive, Netzlaufwerk): rund 1,4 GB in Zehntausenden Dateien. Dasselbe gilt für die Ausgabe (SOMA_RELEASE).
const fs = require('node:fs');
const path = require('node:path');

const runtime = path.resolve(__dirname, process.env.SOMA_RUNTIME || 'python-runtime');
if (!fs.existsSync(path.join(runtime, 'SOMA-RUNTIME.txt'))) {
  throw new Error(`Python runtime missing in ${runtime}. Build it first: python python/scripts/build_runtime.py`);
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'io.github.kai-jungsthoefel.soma',
  productName: 'SOMA',
  copyright: 'Copyright © Kai Jungsthöfel. GPL-3.0-or-later.',
  directories: { output: path.resolve(__dirname, process.env.SOMA_RELEASE || 'release'), buildResources: 'build-resources' },
  artifactName: 'SOMA-${version}-${os}-${arch}.${ext}',
  // Ohne asar: dugite und node-pty starten Programme aus ihrem Paketordner, Vorlage und Skills werden in Projekte kopiert.
  // Aus einem asar-Archiv ginge beides nur über Umwege, und das Paket ist ohnehin vom Python bestimmt.
  asar: false,
  // node-pty bringt fertige Binaries (N-API) mit, unter Linux baut npm install es. Neu bauen für Electron ist nicht nötig.
  npmRebuild: false,
  // Alles außer den beiden nativen Paketen bündelt esbuild nach dist/
  files: [
    'package.json',
    'dist/**',
    '!dist/**/*.map',
    'resources/**',
    '!node_modules/**',
    'node_modules/dugite/**',
    'node_modules/node-pty/**',
    '!node_modules/node-pty/{src,deps,scripts,third_party,typings}/**',
    '!node_modules/node-pty/build/**/*.{obj,pdb,lib,iobj,ipdb,tlog}',
  ],
  afterPack: async (ctx) => {
    const res = ctx.packager.getResourcesDir(ctx.appOutDir);
    // electron-builder lässt .gitignore immer weg, auch über `files`. Die Vorlage für neue Projekte braucht ihre aber.
    for (const rel of ['resources/template/.gitignore']) fs.copyFileSync(path.join(__dirname, rel), path.join(res, 'app', rel));
    // node-pty startet unter macOS jede Shell über spawn-helper, das npm-Paket bringt es ohne Ausführungsrecht mit
    // (sonst „posix_spawnp failed“, kein Terminal). Läuft vor dem Signieren.
    const pty = path.join(res, 'app', 'node_modules', 'node-pty');
    for (const dir of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release']) {
      const helper = path.join(pty, dir, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  },
  extraResources: [
    { from: runtime, to: 'python', filter: ['**/*', '!**/__pycache__/*.opt-?.pyc'] },
    { from: '../LICENSE', to: 'LICENSE.txt' },
    { from: '../MODEL-EXCEPTION.md', to: 'MODEL-EXCEPTION.md' },
  ],

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'resources/icon.ico',
  },
  nsis: {
    // Für den Nutzer installieren (%LOCALAPPDATA%\Programs\SOMA): keine Adminrechte, und das Programm liegt lokal, auf
    // einem Netzlaufwerk starten die Prozesse von Electron nicht
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    license: '../LICENSE',
    deleteAppDataOnUninstall: false,
    shortcutName: 'SOMA',
  },

  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'tar.gz', arch: ['x64'] }],
    icon: 'build-resources/icon.png',
    category: 'Graphics',
    synopsis: 'Design 3D models in CadQuery with an AI agent of your choice',
  },

  mac: {
    // Nur Apple Silicon: Für Intel-Macs gibt es nicht mehr alle Wheels der Basisumgebung (cryptography)
    target: [{ target: 'dmg', arch: ['arm64'] }],
    icon: 'build-resources/icon.png',
    category: 'public.app-category.graphics-design',
    // Ohne Zertifikat ad-hoc signiert (Apple Silicon startet unsignierte Programme nicht), ohne Notarisierung
    identity: process.env.CSC_LINK ? undefined : '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  dmg: { title: 'SOMA ${version}' },
};
