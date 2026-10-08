import { exec, spawn } from 'dugite';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from './files';

export interface Commit { hash: string; short: string; author: string; date: string; subject: string; byApp: boolean }
export interface RunResult { ok: boolean; code: number; out: string; err: string }
export interface GitStatus { dirty: boolean; changed: number; head: string | null }

/**
 * Markiert Commits der App, damit die Verlaufsleiste sie von Commits des Agenten unterscheiden kann. Der Autor taugt dafür
 * nicht: Agent und App committen mit derselben Git-Identität. Ältere Projekte ohne Trailer erkennt die Leiste am Betreff.
 */
const APP_TRAILER = ['--trailer', 'Created-by: SOMA'];
// Ältere Projekte haben deutsche Betreffe und den Trailer `Erstellt-von` (vor E73), beide gelten weiter
const APP_SUBJECT = /^(New model created|Automatic snapshot on save|Backup before restore|Restored version: |Neues Modell angelegt|Automatischer Snapshot beim Speichern|Sicherung vor Wiederherstellung|Stand wiederhergestellt: )/;

/** Gilt für jeden Aufruf: UTF-8-Pfade lesbar, keine Zeilenenden-Umwandlung (ZIPs wandern zwischen Systemen). */
const COMMON = ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false'];
/**
 * Zwischenergebnisse der App, die nie in den Verlauf gehören: Geometrie für das Messen, gebaute Animationen, Ergebnisse
 * von soma analyze (bis zu 70 MB je Auswertung), Bilder und Videos von soma render und die Projektumgebung mit den
 * Zusatzpaketen (E67, im Verlauf steht nur requirements.txt). Ältere Projekte haben sie noch
 * nicht in der .gitignore, deshalb klammert die App sie selbst aus, beim Status und beim Hinzufügen (siehe addAll), und
 * trägt sie beim Öffnen in .git/info/exclude ein, damit auch die Commits des Agenten sie nicht aufnehmen (ensureIgnored).
 */
const APP_CACHES = ['.soma/geometry', '.soma/anim', '.soma/results', '.soma/drawings', '.soma/env', 'renders'];
/** `output/` zählt nicht als Änderung: STEP-Dateien sind nicht byte-stabil (Zeitstempel, teils Reihenfolge). */
const NOT_OUTPUT = ['--', '.', ':(exclude)output', ...APP_CACHES.map((p) => `:(exclude)${p}`)];
/** Was die Vorlage in der .gitignore hat (resources/template/.gitignore), für ältere Projekte in .git/info/exclude. */
const APP_IGNORES = ['.soma/model.glb', '.soma/model.map.json', '.soma/build.json', '.soma/zip-info.json', '.soma/feedback/',
  ...APP_CACHES.map((p) => `${p}/`)];
const HASH = /^[0-9a-f]{7,40}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Das Git-Repository eines Projekts (mitgeliefertes Git, E31). Der Agent committet unabhängig von der App (E7),
 * deshalb: App-eigene Schreibvorgänge laufen nacheinander und wiederholen sich bei gesperrtem Index,
 * lesende Aufrufe nehmen keine Sperren. Nichts hier baut den Verlauf um (kein Reset, kein Checkout, keine Branches, E35).
 */
export class GitRepo {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly dir: string) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.chain.then(fn, fn);
    this.chain = r.catch(() => undefined);
    return r;
  }

  /** Ein Git-Aufruf. `write` = ändert das Repository (mit Wiederholung bei index.lock). */
  async run(args: string[], write = false): Promise<RunResult> {
    for (let attempt = 0; ; attempt++) {
      const r = await exec([...COMMON, ...args], this.dir, { env: write ? {} : { GIT_OPTIONAL_LOCKS: '0' } });
      const res: RunResult = { ok: r.exitCode === 0, code: r.exitCode, out: String(r.stdout), err: String(r.stderr) };
      const locked = !res.ok && /index\.lock|Unable to create .*\.lock|another git process/i.test(res.err);
      if (!locked || attempt >= 8) return res;
      await sleep(250);
    }
  }

  /**
   * Alles vormerken außer den Zwischenergebnissen (APP_CACHES). Ein Ausschluss im Pfad (`:(exclude)…`) ginge nicht: Steht
   * der Ordner in der .gitignore (neue Projekte), bricht `git add` dann mit Fehler ab. Deshalb danach aus dem Index nehmen,
   * was dort liegt. Hat ein älteres Projekt sie schon im Verlauf, nimmt der nächste Snapshot sie heraus (die Dateien bleiben).
   */
  private async addAll(): Promise<void> {
    await this.mustRun(['add', '-A'], true);
    await this.mustRun(['rm', '-r', '--cached', '--ignore-unmatch', '-q', '--', ...APP_CACHES], true);
  }

  /**
   * Trägt die Zwischenergebnisse in .git/info/exclude ein, soweit sie dort fehlen. Gilt auch für `git add -A` des Agenten
   * und ändert keine Datei des Projekts (die .gitignore gehört dem Nutzer). Nur eine Erleichterung: Fehler stören nichts.
   */
  async ensureIgnored(): Promise<void> {
    try {
      if (!(await this.isRepo())) return;
      const file = path.join(this.dir, '.git', 'info', 'exclude');
      const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const lines = new Set(have.split(/\r?\n/).map((l) => l.trim()));
      const missing = APP_IGNORES.filter((p) => !lines.has(p));
      if (!missing.length) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const head = have && !have.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(file, `${head}# SOMA: intermediate results of the app (new projects have them in .gitignore)\n${missing.join('\n')}\n`);
    } catch { /* nächster Versuch beim nächsten Öffnen */ }
  }

  private async mustRun(args: string[], write = false): Promise<string> {
    const r = await this.run(args, write);
    if (!r.ok) throw new Error(`git ${args[0]} failed: ${(r.err || r.out).trim().slice(0, 400)}`);
    return r.out;
  }

  /**
   * Ist `dir` selbst ein Repository (und nicht nur Teil eines übergeordneten)? Liegt das Repository direkt hier, meldet
   * `rev-parse --git-dir` schlicht ".git". Ein Pfadvergleich wäre fragil (Windows-Kurznamen wie NAME~1, Groß-/Kleinschreibung).
   */
  async isRepo(): Promise<boolean> {
    if (!fs.existsSync(path.join(this.dir, '.git'))) return false;
    const r = await this.run(['rev-parse', '--git-dir']);
    return r.ok && r.out.trim() === '.git';
  }

  /** Neues Repository mit erstem Commit. Nur für neue Projekte, nie als stille Reparatur. */
  async init(message: string): Promise<string> {
    return this.serial(async () => {
      await this.mustRun(['init', '-b', 'main'], true);
      await this.mustRun(['config', '--local', 'core.autocrlf', 'false'], true);
      await this.mustRun(['config', '--local', 'core.longpaths', 'true'], true);
      // Ohne eingerichtete Identität würden auch die Commits des Agenten scheitern.
      const name = await this.run(['config', 'user.name']);
      const email = await this.run(['config', 'user.email']);
      if (!name.out.trim()) await this.mustRun(['config', '--local', 'user.name', 'SOMA'], true);
      if (!email.out.trim()) await this.mustRun(['config', '--local', 'user.email', 'soma@localhost'], true);
      await this.addAll();
      await this.mustRun(['commit', '--allow-empty', '--no-verify', '-m', message, ...APP_TRAILER], true);
      return (await this.mustRun(['rev-parse', 'HEAD'])).trim();
    });
  }

  async head(): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '-q', 'HEAD']);
    return r.ok ? r.out.trim() : null;
  }

  async status(): Promise<GitStatus> {
    const r = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...NOT_OUTPUT]);
    const changed = r.ok ? r.out.split('\0').filter(Boolean).length : 0;
    return { dirty: changed > 0, changed, head: await this.head() };
  }

  /** Auto-Snapshot (E8): committet nur, wenn Quelltext, Eingaben oder Einstellungen geändert sind. Liefert den neuen Hash. */
  async snapshot(message: string): Promise<string | null> {
    return this.serial(async () => {
      if (!(await this.status()).dirty) return null;
      await this.addAll();
      await this.mustRun(['commit', '--no-verify', '-m', message, ...APP_TRAILER], true);
      return (await this.mustRun(['rev-parse', 'HEAD'])).trim();
    });
  }

  /**
   * Packt die Objekte vor dem Speichern als ZIP (E75). Lose legt Git jede Fassung von output/model.step ganz ab, nur mit
   * zlib komprimiert, gepackt ähnliche Fassungen als Unterschied (Motor: 35 statt 81 MB). Commits und Hashes bleiben, wie
   * sie sind (E35). `--keep-unreachable`: Nichts wird gelöscht, auch nicht Unerreichbares (etwa Blobs, die addAll wieder
   * aus dem Index nimmt, oder Reste nach `git gc` des Agenten), es kommt mit ins Pack. Sonst blieben solche Objekte lose
   * liegen, und jedes Speichern packte neu. `-n`: keine Dateien für Git-Server. Liefert false, wenn nichts lose lag.
   */
  async pack(): Promise<boolean> {
    return this.serial(async () => {
      if (/^count: 0$/m.test(await this.mustRun(['count-objects', '-v']))) return false;
      await this.mustRun(['repack', '-a', '-d', '--keep-unreachable', '-n', '-q'], true);
      return true;
    });
  }

  /** Verlauf, älteste zuerst. Ein kaputtes oder leeres Repository liefert eine leere Liste. */
  async log(limit = 500): Promise<Commit[]> {
    const fmt = '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%(trailers:key=Created-by,key=Erstellt-von,valueonly,separator=%x2c)%x1e';
    const r = await this.run(['log', `-n${limit}`, fmt, 'HEAD']);
    if (!r.ok) return [];
    return r.out.split('\x1e').map((e) => e.trim()).filter(Boolean).map((e) => {
      const [hash, short, author, date, subject, by = ''] = e.split('\x1f');
      return { hash, short, author, date, subject, byApp: by.includes('SOMA') || APP_SUBJECT.test(subject) };
    }).reverse();
  }

  /** Schreibt eine Datei eines Standes in `outFile` (binärsicher, Arbeitsordner bleibt unberührt). */
  exportFile(hash: string, rel: string, outFile: string): Promise<void> {
    if (!HASH.test(hash)) return Promise.reject(new Error('Invalid commit'));
    return new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      const child = spawn([...COMMON, 'show', `${hash}:${rel}`], this.dir, { env: { GIT_OPTIONAL_LOCKS: '0' } });
      const out = fs.createWriteStream(outFile);
      let err = '';
      child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
      child.stdout?.pipe(out);
      child.on('error', reject);
      child.on('close', (code) => {
        out.end();
        if (code === 0) resolve(); else { fs.rmSync(outFile, { force: true }); reject(new Error(err.trim() || `git show ended with code ${code}`)); }
      });
    });
  }

  /**
   * Stand wiederherstellen (E35): Dateien des gewählten Stands in den Arbeitsordner kopieren und als NEUEN Commit ablegen.
   * Vorher wird ein ungesicherter Arbeitsstand als eigener Commit gesichert, damit nichts verloren geht.
   */
  async restore(hash: string): Promise<{ commit: string | null; safety: string | null }> {
    if (!HASH.test(hash)) throw new Error('Invalid commit');
    return this.serial(async () => {
      const type = await this.run(['cat-file', '-t', hash]);
      if (!type.ok || type.out.trim() !== 'commit') throw new Error('This version no longer exists in the history.');
      const subject = (await this.mustRun(['log', '-1', '--format=%s', hash])).trim();
      const short = (await this.mustRun(['rev-parse', '--short', hash])).trim();

      let safety: string | null = null;
      if ((await this.status()).dirty) {
        await this.addAll();
        await this.mustRun(['commit', '--no-verify', '-m', 'Backup before restore', ...APP_TRAILER], true);
        safety = (await this.mustRun(['rev-parse', 'HEAD'])).trim();
      }
      const target = new Set((await this.mustRun(['ls-tree', '-r', '-z', '--name-only', hash])).split('\0').filter(Boolean));
      const current = (await this.mustRun(['ls-files', '-z'])).split('\0').filter(Boolean);
      for (const f of current) {
        if (!target.has(f)) fs.rmSync(resolveInside(this.dir, f), { force: true });
      }
      await this.mustRun(['restore', `--source=${hash}`, '--staged', '--worktree', '--', '.'], true);
      await this.addAll();
      const diff = await this.run(['diff', '--cached', '--quiet']);
      if (diff.ok) return { commit: null, safety }; // Stand war schon identisch
      await this.mustRun(['commit', '--no-verify', '-m', `Restored version: ${subject} (${short})`, ...APP_TRAILER], true);
      return { commit: (await this.mustRun(['rev-parse', 'HEAD'])).trim(), safety };
    });
  }

  /** Auffälligkeiten im Verlauf. Nur melden, nichts reparieren (E28). */
  async problems(): Promise<string[]> {
    if (!(await this.isRepo())) return ['No Git history found (.git is missing or unreadable). The history is not available, saving as ZIP still works.'];
    const out: string[] = [];
    if (!(await this.head())) out.push('The Git history has no commit yet.');
    const branch = await this.run(['symbolic-ref', '-q', '--short', 'HEAD']);
    if (!branch.ok) out.push('Git is on a detached HEAD. New commits belong on the branch main.');
    else if (branch.out.trim() !== 'main') out.push(`Git is on the branch “${branch.out.trim()}” instead of main.`);
    return out;
  }

  async isAncestor(ancestor: string, of: string): Promise<boolean> {
    if (!HASH.test(ancestor) || !HASH.test(of)) return false;
    return (await this.run(['merge-base', '--is-ancestor', ancestor, of])).ok;
  }
}
