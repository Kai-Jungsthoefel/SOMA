import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { exec } from 'dugite';
import type { AboutInfo, AgentInfo, ComponentInfo } from '../shared/types';
import { SOMA_VERSION } from '../shared/version';
import { pythonExe, userDataDir, userSkillsDir, warmDir } from './paths';

/**
 * Angaben für „About“ in den Einstellungen (E81): Versionen, Komponenten mit Lizenz, gefundene Agenten, Pfade. Alles wird
 * gelesen, nichts geschätzt: npm-Pakete aus components.json (beim Bauen aus node_modules geschrieben), Python-Pakete aus
 * ihren Metadaten. Fehlt etwas, steht das dort, statt dass die Seite scheitert.
 */

/**
 * Python-Teil: Version, Interpreter und die Pakete, die `soma` benutzt, mit Version und Lizenz aus den Metadaten (ohne sie
 * zu importieren, cadquery zu laden dauerte Sekunden). `soma` nennt keine Abhängigkeiten (cadquery kommt mit der
 * Basisumgebung), deshalb die feste Liste dessen, was soma importiert, dazu was künftig in seinen Metadaten steht. Die
 * Version von soma kommt aus dem Paket selbst (leichter Import): Die Metadaten einer Entwicklungsinstallation bleiben auf
 * dem Stand der Installation stehen. Die Lizenz steht je nach Paket in `License-Expression`, kurz in `License` oder nur in
 * den Klassifikatoren.
 */
const PY_INFO = String.raw`
import importlib.metadata as m, json, re, sys
def info(name):
    try:
        d = m.distribution(name)
    except Exception:
        return None
    md = d.metadata
    lic = (md.get('License-Expression') or '').strip()
    if not lic:
        l = (md.get('License') or '').strip()
        if l and '\n' not in l and len(l) <= 40:
            lic = l
    if not lic:
        lic = ', '.join(c.split('::')[-1].strip() for c in (md.get_all('Classifier') or []) if c.startswith('License ::'))
    return {'name': md.get('Name') or name, 'version': d.version, 'license': lic}
names = ['soma', 'cadquery', 'cadquery-ocp', 'ezdxf', 'numpy', 'scipy', 'matplotlib', 'vtk', 'gmsh', 'pyamg']
try:
    for r in m.requires('soma') or []:
        if 'extra ==' in r:
            continue
        n = re.split(r'[\s<>=!~;\[(]', r.strip(), maxsplit=1)[0]
        if n and n.lower() not in [x.lower() for x in names]:
            names.append(n)
except Exception:
    pass
packages = [p for p in map(info, names) if p]
try:
    import soma
    for p in packages:
        if p['name'].lower() == 'soma':
            p['version'] = soma.__version__
except Exception:
    pass
try:
    # CalculiX ist kein Python-Paket: soma findet es neben der Umgebung (E84) und fragt es nach seiner Version
    from soma import ccx
    v = ccx.version()
    packages.append({'name': 'CalculiX (ccx)', 'version': v or ('not found' if ccx.find() is None else 'does not start'), 'license': 'GPL-2.0-or-later'})
except Exception:
    pass
print(json.dumps({'version': sys.version.split()[0], 'executable': sys.executable, 'packages': packages}))
`;

let pyCache: Promise<AboutInfo['python']> | null = null;

/** Einmal je Sitzung: Die Basisumgebung ändert sich nicht, während die App läuft. Ein Fehler wird beim nächsten Mal neu versucht. */
function pythonInfo(): Promise<AboutInfo['python']> {
  if (pyCache) return pyCache;
  const exe = pythonExe();
  pyCache = new Promise((resolve) => {
    const cwd = warmDir();
    try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* dann eben ohne */ }
    // Leerer Startordner: Python setzt ihn bei -c vorn in den Suchpfad (siehe warmDir)
    execFile(exe, ['-c', PY_INFO], { cwd, timeout: 30000, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } }, (err, out, errOut) => {
      if (err) { pyCache = null; resolve({ exe, packages: [], error: (String(errOut).trim().split('\n').pop() || err.message).slice(0, 300) }); return; }
      try {
        const j = JSON.parse(String(out).trim().split('\n').pop() ?? '') as { version: string; executable: string; packages: ComponentInfo[] };
        resolve({ exe: j.executable || exe, version: j.version, packages: j.packages });
      } catch { pyCache = null; resolve({ exe, packages: [], error: 'Python did not report its packages.' }); }
    });
  });
  return pyCache;
}

/** npm-Pakete, die die App mitbringt (dependencies aus package.json), geschrieben von esbuild.config.mjs. */
function npmComponents(): ComponentInfo[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'components.json'), 'utf8')) as unknown;
    return Array.isArray(raw) ? raw.filter((c): c is ComponentInfo => !!c && typeof c.name === 'string' && typeof c.version === 'string').map((c) => ({ name: c.name, version: c.version, license: String(c.license ?? '') })) : [];
  } catch { return []; }
}

async function gitVersion(): Promise<string | null> {
  try {
    const r = await exec(['--version'], userDataDir());
    return /git version (\S+)/.exec(r.stdout)?.[1] ?? null;
  } catch { return null; }
}

function osName(): string {
  const rel = os.release();
  if (process.platform === 'win32') {
    // Windows 11 meldet sich weiter als 10.0, erst die Build-Nummer ab 22000 unterscheidet
    const build = Number(rel.split('.')[2]);
    return `Windows ${build >= 22000 ? '11' : '10'} (${rel})`;
  }
  return `${os.type()} ${rel}`;
}

export async function aboutInfo(agents: () => Promise<AgentInfo[]>): Promise<AboutInfo> {
  const [python, git, found] = await Promise.all([pythonInfo(), gitVersion(), agents().catch(() => [])]);
  return {
    version: SOMA_VERSION,
    electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '', node: process.versions.node,
    os: `${osName()} ${process.arch}`,
    git, python, agents: found,
    paths: [
      { label: 'App data', path: userDataDir() },
      { label: 'Your skills', path: userSkillsDir() },
      { label: 'Python', path: python.exe },
      { label: 'Program', path: app.getAppPath() },
    ],
    components: npmComponents(),
  };
}

/** Text zum Kopieren, etwa für eine Fehlermeldung. Englisch wie die Oberfläche, Zahlen wie gelesen. */
export function aboutText(a: AboutInfo): string {
  const pkg = (n: string) => a.python.packages.find((p) => p.name.toLowerCase() === n)?.version;
  const lines = [
    `SOMA ${a.version}`,
    `soma (Python) ${pkg('soma') ?? 'not found'}, Python ${a.python.version ?? 'not found'}, CadQuery ${pkg('cadquery') ?? '?'}, OCP ${pkg('cadquery-ocp') ?? '?'}`,
    `Electron ${a.electron}, Chromium ${a.chrome}, Node.js ${a.node}, Git ${a.git ?? 'not found'}`,
    `OS: ${a.os}`,
    `Agents: ${a.agents.map((x) => `${x.label} (${x.found ? 'found' : 'not installed'})`).join(', ') || 'none detected'}`,
    ...a.paths.map((p) => `${p.label}: ${p.path}`),
  ];
  if (a.python.error) lines.push(`Python problem: ${a.python.error}`);
  return lines.join('\n');
}
