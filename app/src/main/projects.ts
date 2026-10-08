import { shell, type BrowserWindow, type WebContents } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AnimBuildResult, AnimList, ExportResult, GitLog, MeasureEntity, MeasurePrepared, MeasureRequest, MeasureResponse, ModelMap, OpenResult, PreviewResult,
  ParamResult, ParamState, ParamValue, ProjectInfo, RemoveResult, RenderResult, RestoreResult, ResultEntry, SaveResult, SaveState, SkillInfo, SkillResult,
} from '../shared/types';
import { affectsAnimation } from '../shared/editable';
import { AnimBuilder, listResults, readAnimList, rerunResult, samePath } from './animations';
import { BuildManager, buildIsStale, currentBuild, newestSourceMtime, runSoma } from './build';
import { checkRequest, RenderService, type RenderRequest } from './render';
import { choose, chooseExportTarget, choosePath, documentsDir, trashItem } from './dialogs';
import { GitRepo, type GitStatus } from './git';
import { MeasureService } from './measure';
import { ensureEnv, envIsCurrent, installMissing, missingPackages } from './packages';
import { checkParamValue, isParamValue, readUserParams, writeUserParams } from './params';
import { previewsDir, skillBackupsDir, skillsDir } from './paths';
import { storeBuildAsPreview } from './previews';
import {
  agentsEntries, bundledSkill, checkValue, cleanValues, copySkill, isSkillId, isSkillMode, listSkills, modeOf, removeSkill, withMode, writeAgentsList, type SkillValues,
} from './skills';
import { TerminalManager } from './terminals';
import { watchProject } from './watcher';
import {
  backupWorkspace, createProject, discardWorkspace, extractProject, forgetProject, getAppState, inspectProject, isProjectId, isUntouched, patchAppState, projectDir,
  getSkillDefaults, readProjectJson, readSkillModes, renameProject, setLastProject, setSkillDefault, stampAppVersion, updateProjectSkills,
} from './workspace';
import { readZipTexts, saveProjectZip, ZIP_INFO_PATH, type ZipInfo } from './zip';

/** Alles, was zu einem geöffneten Projekt gehört. Beim Wechsel wird es vollständig abgebaut. */
interface Session {
  id: string;
  dir: string;
  builds: BuildManager;
  terminals: TerminalManager;
  git: GitRepo;
  measure: MeasureService;
  /** Animationen bauen (E58), ausgelöst vom Watcher, der Oberfläche oder vor einem Video. */
  anims: AnimBuilder;
  animTimer?: NodeJS.Timeout;
  stopWatch: () => void;
  poll: NodeJS.Timeout;
  signature: string;
  /** Legt gerade den Build als Vorschau des letzten Commits ab (cachePreview). */
  caching?: boolean;
  /** Projektumgebung bereit (E67): Fehlertext oder null. */
  env: Promise<string | null>;
}

const POLL_MS = 2000;
const safeFileName = (n: string) => n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Model';

/**
 * Das offene Projekt und alles, was mit Speichern, Öffnen und Verlauf zu tun hat.
 *
 * Grundsätze: Speichern nur ausdrücklich (E21). Nichts wird still überschrieben oder gelöscht: ein Arbeitsordner, den eine
 * ZIP ersetzt, wandert in die Sicherungen. Der Agent committet selbst, die App legt nur beim Speichern einen Snapshot an (E8).
 */
export class ProjectController {
  session: Session | null = null;
  /** Unsichtbares Fenster für Bilder und Videos (E58), eins für die App. */
  readonly renders = new RenderService();

  constructor(private readonly getWin: () => BrowserWindow | null, private readonly wc: WebContents) {}

  private send(channel: string, ...args: unknown[]) { if (!this.wc.isDestroyed()) this.wc.send(channel, ...args); }
  need(): Session { if (!this.session) throw new Error('No project open'); return this.session; }

  // ---- Sitzung ----------------------------------------------------------------------------------------------------

  info(): ProjectInfo {
    const s = this.need();
    const { name, problems } = inspectProject(s.id);
    return { id: s.id, name, dir: s.dir, problems, autoBuild: s.builds.autoBuild };
  }

  close(): void {
    const s = this.session;
    if (!s) return;
    clearInterval(s.poll);
    clearTimeout(s.animTimer);
    s.stopWatch();
    s.anims.dispose();
    s.builds.dispose();
    s.terminals.killAll();
    s.measure.stop();
    this.session = null;
  }

  /**
   * Verlässt das offene Modell (Wechsel zu einem anderen, Beenden der App). Ein neues Modell, das noch genau der Vorlage
   * entspricht, verschwindet dabei (E69): Es gibt nichts, was verloren gehen könnte, und die Startseite füllt sich nicht
   * mit leeren „Neues Modell“. Alles andere bleibt liegen wie bisher.
   */
  async leave(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const untouched = await isUntouched(s.id);
    // Die Shells halten den Ordner fest, bis sie wirklich beendet sind
    const shells = untouched ? s.terminals.killAllAndWait() : null;
    this.close();
    if (shells) await shells;
    if (untouched && !(await discardWorkspace(s.id))) console.error(`[soma] Could not discard the unchanged model ${s.id} (folder in use), it stays.`);
  }

  async open(id: string): Promise<ProjectInfo> {
    // Dasselbe Modell neu öffnen (etwa „Arbeitsstand behalten“ beim Öffnen seiner ZIP) verwirft es nie
    if (this.session?.id === id) this.close(); else await this.leave();
    const dir = projectDir(id);
    const builds = new BuildManager(dir);
    const terminals = new TerminalManager(this.wc, dir);
    const git = new GitRepo(dir);
    void git.ensureIgnored(); // ältere Projekte: Zwischenergebnisse auch aus den Commits des Agenten heraushalten
    const anims = new AnimBuilder(dir, () => this.send('anim:changed'));
    const stopWatch = watchProject(dir, (rel) => builds.sourceChanged(rel ? path.join(dir, rel) : null), () => this.send('fs:changed'),
      (rel) => this.animFileChanged(rel));
    // Projektumgebung (E67): Meist steht sie schon, sonst legt `soma env` sie in rund 0,5 s an. Die Terminals kennen ihre
    // Pfade vorab, gewartet wird nur vor dem Installieren von Paketen
    const env = envIsCurrent(dir) ? Promise.resolve(null) : ensureEnv(dir);
    const session: Session = { id, dir, builds, terminals, git, measure: new MeasureService(dir), anims, stopWatch, signature: '', env, poll: setInterval(() => void this.pollGit(), POLL_MS) };
    this.session = session;
    void env.then((err) => { if (err) { console.error('[soma]', err); builds.reportPackageError(err); } });
    builds.on('status', (st) => {
      this.send('build:status', st);
      if (st.state === 'ok' && !st.stale) void this.cachePreview(session);
    });
    setLastProject(id);
    // Gilt der letzte Build noch (seit seinem Start nichts geändert), zeigt der Viewer ihn gleich, statt neu zu bauen. Sonst
    // erster Build direkt beim Öffnen, damit der Viewer nicht leer ist (der Nutzer kann Auto-Build danach abschalten).
    const last = currentBuild(dir);
    // Fehlen Pakete aus requirements.txt (ZIP von einem anderen Rechner), erst installieren, dann bauen
    if (!this.installPackages(session, !last) && !last) builds.start('project opened');
    const info = this.info();
    this.send('project:changed', info);
    // Erst nach project:changed: Das Fenster räumt beim Projektwechsel den Viewer leer und lädt danach das Modell
    if (last) builds.adopt(last);
    return info;
  }

  async create(): Promise<ProjectInfo> {
    const { id } = await createProject();
    return this.open(id);
  }

  /**
   * Fehlen Pakete aus requirements.txt in der Projektumgebung, werden sie installiert (E67), und Builds warten so lange.
   * `build`: danach bauen. Gibt zurück, ob installiert wird.
   */
  private installPackages(s: Session, build: boolean): boolean {
    const missing = missingPackages(s.dir);
    if (!missing.length) return false;
    void s.builds.installFirst(missing, async () => (await s.env) ?? installMissing(s.dir), build);
    return true;
  }

  /** Meldet dem Fenster, wenn sich Verlauf oder Änderungsstand geändert haben (auch durch Commits des Agenten). */
  private async pollGit(): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      const hasRepo = fs.existsSync(path.join(s.dir, '.git'));
      const st = hasRepo ? await s.git.status() : { head: null, changed: 0 };
      const sig = `${hasRepo ? 1 : 0}|${st.head}|${st.changed}`;
      if (this.session !== s || sig === s.signature) return;
      s.signature = sig;
      this.send('versions:changed');
      this.send('save:state', await this.saveState());
      if (hasRepo) void this.cachePreview(s, st as GitStatus);
    } catch { /* nächster Durchlauf */ }
  }

  /**
   * Vorschau-Cache für die Zeitleiste: Ist der Arbeitsordner sauber (alles wie im letzten Commit) und gilt der letzte Build,
   * zeigt das aktuelle Modell genau diesen Commit. Dann wird es als dessen Vorschau abgelegt, und ein Sprung zurück muss die
   * STEP-Datei nicht wieder einlesen und vernetzen (bei großen Modellen rund 10 s). Ausgelöst von neuen Commits (auch des
   * Agenten) und fertigen Builds. Was nicht passt, bleibt einfach ohne Cache.
   */
  private async cachePreview(s: Session, known?: GitStatus): Promise<void> {
    if (this.session !== s || s.caching || s.builds.busy) return;
    s.caching = true;
    try {
      const st = known ?? (fs.existsSync(path.join(s.dir, '.git')) ? await s.git.status() : null);
      if (!st || st.dirty || !st.head || this.session !== s || s.builds.busy) return;
      const target = path.join(previewsDir(), s.id, st.head);
      if (fs.existsSync(path.join(target, 'model.glb')) && fs.existsSync(path.join(target, 'geometry'))) return;
      const last = currentBuild(s.dir);
      if (!last) return;
      await storeBuildAsPreview(s.dir, target, last, () => this.session === s && !s.builds.busy);
    } catch { /* ohne Cache: Die Vorschau entsteht beim Ansehen aus der STEP-Datei */ } finally { s.caching = false; }
  }

  // ---- Speicherstand ----------------------------------------------------------------------------------------------

  async saveState(): Promise<SaveState> {
    const s = this.need();
    const hasRepo = await s.git.isRepo();
    const st = hasRepo ? await s.git.status() : { dirty: false, changed: 0, head: null };
    // Erst nach den Git-Abfragen lesen: Läuft währenddessen ein Speichern durch, wäre der Stand sonst veraltet, und eine
    // Abfrage der Verlaufsleiste könnte nach der frischen Meldung noch „nicht gespeichert“ schicken
    const app = getAppState(s.id);
    let unsaved: boolean;
    if (!app.zipPath) unsaved = true;
    else if (hasRepo) unsaved = st.dirty || st.head !== (app.savedHead ?? null);
    else unsaved = newestSourceMtime(s.dir) > (app.savedAt ?? 0); // ohne Git bleibt nur der Zeitvergleich
    return { zipPath: app.zipPath ?? null, savedHead: app.savedHead ?? null, head: st.head, dirtyFiles: st.changed, unsaved, hasRepo, savedAt: app.zipPath ? app.savedAt ?? null : null };
  }

  /** ZIP im Dateimanager zeigen. Noch nicht gespeichert (oder ZIP verschwunden): den Arbeitsordner öffnen. */
  async reveal(): Promise<void> {
    const s = this.need();
    const zip = getAppState(s.id).zipPath;
    if (zip && fs.existsSync(zip)) shell.showItemInFolder(zip);
    else await shell.openPath(s.dir);
  }

  /**
   * Export über `soma export` (E34) mit Dateidialog: ein Bauteil in eine gewählte Datei, alle Bauteile (ohne Referenz- und
   * Zukaufteile) als je eine Datei in einen gewählten Ordner. soma schreibt in einen leeren Ordner unter Temp, die App
   * kopiert danach. So landet nichts in exports/ des Projekts, und eine vorhandene Datei wird nie ohne Rückfrage ersetzt.
   */
  async exportModel(format: string, part: string | null): Promise<ExportResult> {
    const s = this.need();
    if (!/^[a-z0-9]{2,5}$/.test(format)) return { ok: false, files: [], error: `Unknown format: ${format}` };
    const last = getAppState(s.id).exportDir;
    const startDir = last && fs.existsSync(last) ? last : documentsDir();
    const target = await chooseExportTarget(this.getWin(), part
      ? { kind: 'file', title: `Export “${part}”`, defaultPath: path.join(startDir, `${safeFileName(part)}.${format}`), ext: format }
      : { kind: 'dir', title: 'Choose a folder for the export', defaultPath: startDir });
    if (!target) return { ok: false, files: [], cancelled: true };
    let tmp: string | null = null;
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-export-'));
      // `--` vor dem Namen: Bauteilnamen dürfen mit einem Minus beginnen, ohne als Option zu gelten
      const args = ['export', '--format', format, '--project', s.dir, '--out', tmp, ...(part ? ['--', part] : ['--all'])];
      const r = await runSoma(args, s.dir, 5 * 60 * 1000);
      if (!r.ok) {
        const msg = (r.err || r.out).trim().split(/\r?\n/).slice(-3).join('\n');
        return { ok: false, files: [], error: msg || 'Export failed' };
      }
      // Alles aus dem Ordner übernehmen, nicht nur die gemeldeten Dateien (glTF kann eine .bin daneben schreiben)
      const dir = tmp;
      const made = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile());
      if (!made.length) return { ok: false, files: [], error: 'soma did not write a file.' };
      const plan: [string, string][] = [];
      if (part) {
        const main = made.find((n) => n.toLowerCase().endsWith(`.${format}`)) ?? made[0];
        const dest = path.extname(target) ? target : `${target}.${format}`;
        plan.push([path.join(dir, main), dest]);
        for (const n of made) if (n !== main) plan.push([path.join(dir, n), path.join(path.dirname(dest), n)]);
      } else for (const n of made) plan.push([path.join(dir, n), path.join(target, n)]);
      // Beim Einzelexport hat der Speichern-Dialog für die Hauptdatei schon gefragt, alles andere fragt die App
      const exists = plan.filter(([, d], i) => !(part && i === 0) && fs.existsSync(d)).map(([, d]) => path.basename(d));
      if (exists.length) {
        const c = await choose(this.getWin(), {
          title: 'Export', message: exists.length === 1 ? 'This file already exists in the folder:' : `These ${exists.length} files already exist in the folder:`,
          detail: `${exists.slice(0, 10).join('\n')}${exists.length > 10 ? `\n… and ${exists.length - 10} more` : ''}`, buttons: ['Replace', 'Cancel'],
        });
        if (c !== 0) return { ok: false, files: [], cancelled: true };
      }
      for (const [src, dest] of plan) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
      const dest = part ? plan[0][1] : target;
      patchAppState(s.id, { exportDir: part ? path.dirname(dest) : target });
      return { ok: true, files: plan.map(([, d]) => d), target: dest };
    } catch (e) {
      return { ok: false, files: [], error: `Export failed: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Speichern: Snapshot im Verlauf, dann ZIP. Fragt beim ersten Mal nach dem Ort. */
  async save(saveAs = false): Promise<SaveResult> {
    const s = this.need();
    const app = getAppState(s.id);
    let zipPath = saveAs ? undefined : app.zipPath;
    if (zipPath && !fs.existsSync(path.dirname(zipPath))) zipPath = undefined; // Zielordner weg (z. B. USB-Stick ab): neu fragen
    if (!zipPath) {
      const pj = readProjectJson(s.id);
      const chosen = await choosePath(this.getWin(), 'save', `${safeFileName(pj?.name ?? 'Model')}.zip`);
      if (!chosen) return { cancelled: true };
      zipPath = /\.zip$/i.test(chosen) ? chosen : `${chosen}.zip`;
      renameProject(s.id, path.basename(zipPath).replace(/\.zip$/i, '')); // der Modellname folgt dem Dateinamen
    }
    const warnings: string[] = [];
    try {
      // Die ZIP soll das aktuelle Ergebnis enthalten: laufenden Build abwarten, veralteten vorher nachholen.
      if (!s.builds.busy && buildIsStale(s.dir)) s.builds.start('before saving');
      await s.builds.whenIdle();
      if (s.builds.status.state === 'error') warnings.push('The last build failed. The ZIP contains the last successful version of output/model.step.');

      stampAppVersion(s.id); // mit welcher Version zuletzt gespeichert (E68), steht so auch im Snapshot
      let snapshot: string | null = null;
      if (await s.git.isRepo()) {
        try { snapshot = await s.git.snapshot('Automatic snapshot on save'); }
        catch (e) { warnings.push(`Could not add a snapshot to the history: ${e instanceof Error ? e.message : String(e)}`); }
      } else warnings.push('No Git history: no snapshot was created.');

      const head = await s.git.head();
      const pj = readProjectJson(s.id);
      const info: ZipInfo = { savedAt: new Date().toISOString(), head, id: s.id, name: pj?.name ?? s.id };
      const r = await saveProjectZip(s.dir, zipPath, info);
      patchAppState(s.id, { zipPath, savedHead: head, savedAt: Date.now() });
      this.send('save:state', await this.saveState());
      this.send('versions:changed');
      return { cancelled: false, zipPath, snapshot, files: r.files, bytes: r.bytes, warnings };
    } catch (e) {
      return { cancelled: false, error: `Saving failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // ---- Öffnen -----------------------------------------------------------------------------------------------------

  async openZip(): Promise<OpenResult> {
    const picked = await choosePath(this.getWin(), 'open', '');
    if (!picked) return { cancelled: true };
    return this.openZipFile(picked);
  }

  /**
   * Öffnet eine ZIP als Projekt (E21). Existiert der Arbeitsordner schon, entscheidet der Nutzer bei Abweichungen:
   * Arbeitsstand behalten oder ZIP laden. Beim Laden wandert der Arbeitsordner in die Sicherungen, nichts wird gelöscht.
   */
  async openZipFile(zipPath: string): Promise<OpenResult> {
    let texts: Record<string, string | null>;
    try { texts = await readZipTexts(zipPath, ['.soma/project.json', ZIP_INFO_PATH]); }
    catch (e) { return { cancelled: false, error: `Cannot read the ZIP: ${e instanceof Error ? e.message : String(e)}` }; }
    let id: string;
    let info: ZipInfo | null = null;
    try {
      id = (JSON.parse(texts['.soma/project.json'] ?? '') as { id?: string }).id ?? '';
      if (texts[ZIP_INFO_PATH]) info = JSON.parse(texts[ZIP_INFO_PATH]!) as ZipInfo;
    } catch { id = ''; }
    if (!isProjectId(id)) return { cancelled: false, error: 'This is not a SOMA file (.soma/project.json is missing or invalid).' };

    const dir = projectDir(id);
    const remember = () => patchAppState(id, { zipPath, savedHead: info?.head ?? null, savedAt: Date.now() });

    if (!fs.existsSync(dir)) {
      try { await extractProject(zipPath, id); } catch (e) { return { cancelled: false, error: `Unpacking failed: ${e instanceof Error ? e.message : String(e)}` }; }
      remember();
      await this.open(id);
      return { cancelled: false, opened: true };
    }

    // Arbeitsordner existiert: vergleichen
    const git = new GitRepo(dir);
    const wsHead = (await git.isRepo()) ? await git.head() : null;
    const st = wsHead ? await git.status() : { dirty: false };
    if (info?.head && info.head === wsHead && !st.dirty) { // identisch: nichts zu entscheiden, Chats und Arbeitsordner bleiben
      remember();
      await this.open(id);
      return { cancelled: false, opened: true };
    }
    let why: string;
    if (st.dirty) why = 'The working folder has unsaved changes.';
    else if (info?.head && wsHead && (await git.isAncestor(info.head, wsHead))) why = 'The working folder is newer than the ZIP.';
    else if (info?.head && wsHead && (await git.isAncestor(wsHead, info.head))) why = 'The ZIP is newer than the working folder.';
    else why = 'The working folder and the ZIP have different versions.';
    const choice = await choose(this.getWin(), {
      title: 'Working folder and ZIP differ',
      message: `${why} What do you want to open?`,
      detail: 'Keep current work: the model opens as it is on this computer.\n' +
        'Load ZIP: the version from the ZIP opens. The previous working folder is backed up, nothing is deleted.',
      buttons: ['Keep current work', 'Load ZIP', 'Cancel'],
    });
    if (choice === 0) { patchAppState(id, { zipPath }); await this.open(id); return { cancelled: false, opened: true }; }
    if (choice !== 1) return { cancelled: true };
    try {
      if (this.session?.id === id) this.close(); // offene Handles würden das Umbenennen blockieren
      await backupWorkspace(id);
      await extractProject(zipPath, id);
    } catch (e) { return { cancelled: false, error: `Loading the ZIP failed: ${e instanceof Error ? e.message : String(e)}` }; }
    remember();
    await this.open(id);
    return { cancelled: false, opened: true };
  }

  // ---- Verlauf ----------------------------------------------------------------------------------------------------

  async gitLog(): Promise<GitLog> {
    const s = this.need();
    const problems = await s.git.problems();
    const hasRepo = await s.git.isRepo();
    const commits = hasRepo ? await s.git.log() : [];
    const st = hasRepo ? await s.git.status() : { changed: 0, head: null };
    return { commits, problems, head: st.head, dirtyFiles: st.changed };
  }

  /** Vorschau eines alten Standes: STEP per `git show` holen und im Basismodus umwandeln. Der Arbeitsordner bleibt unberührt. */
  async preview(hash: string): Promise<PreviewResult> {
    const s = this.need();
    const empty = { commit: null, glb: new ArrayBuffer(0), map: { version: 0, parts: [] } as ModelMap };
    if (!/^[0-9a-f]{7,40}$/.test(hash)) return { ...empty, error: 'Invalid version' };
    const commit = (await s.git.log()).find((c) => c.hash === hash) ?? null;
    const dir = path.join(previewsDir(), s.id, hash);
    try {
      // Ältere Vorschauen haben noch keine Geometrie zum Messen: dann neu erzeugen
      if (!fs.existsSync(path.join(dir, 'model.glb')) || !fs.existsSync(path.join(dir, 'geometry'))) {
        const step = path.join(dir, 'model.step');
        await s.git.exportFile(hash, 'output/model.step', step);
        const r = await runSoma(['glb', step, '--out', dir], s.dir);
        if (!r.ok) throw new Error((r.err || r.out).trim().split('\n').pop() || 'Conversion failed');
      }
      const glb = fs.readFileSync(path.join(dir, 'model.glb'));
      const map = JSON.parse(fs.readFileSync(path.join(dir, 'model.map.json'), 'utf8')) as ModelMap;
      return { commit, glb: glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, map };
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      const msg = e instanceof Error ? e.message : String(e);
      return { ...empty, commit, error: /exists on disk, but not in|does not exist|Path .* does not exist|invalid object/i.test(msg)
        ? 'This version contains no output/model.step (not built yet).' : `Preview not possible: ${msg}` };
    }
  }

  /**
   * Exakte Messung (E9). Der Renderer nennt nur die Quelle (aktueller Stand oder Vorschau), den Ordner bestimmt der
   * Hauptprozess. Die Anfrage wird auf die erwartete Form gebracht, bevor sie an den Python-Dienst geht.
   */
  async measure(source: unknown, req: unknown): Promise<MeasureResponse> {
    const s = this.need();
    const folder = this.measureFolder(s, source);
    if (!folder) return { ok: false, error: 'Unknown source for the measurement.' };
    const r = req as { build?: unknown; a?: unknown; b?: unknown } | null;
    const ent = (v: unknown): MeasureEntity | null => {
      const e = v as { part?: unknown; kind?: unknown; id?: unknown; point?: unknown; check?: unknown } | null;
      if (!e || typeof e.part !== 'string' || (e.kind !== 'face' && e.kind !== 'edge' && e.kind !== 'vertex') || !Number.isInteger(e.id)) return null;
      const pt = Array.isArray(e.point) && e.point.length === 3 && e.point.every((x) => Number.isFinite(x)) ? (e.point as number[]) : null;
      return { part: e.part, kind: e.kind, id: e.id as number, point: pt, check: Number.isFinite(e.check) ? (e.check as number) : undefined };
    };
    const a = ent(r?.a), b = r?.b == null ? undefined : ent(r.b);
    if (!a || b === null || typeof r?.build !== 'string') return { ok: false, error: 'Invalid measurement request.' };
    const clean: MeasureRequest = { build: r.build, a, ...(b ? { b } : {}) };
    return s.measure.request(folder, clean);
  }

  /** Ordner des gemessenen Stands, den bestimmt der Hauptprozess. Unbekannte Quelle: null. */
  private measureFolder(s: Session, source: unknown): string | null {
    const hash = (source as { preview?: unknown } | null)?.preview;
    if (source === 'live') return path.join(s.dir, '.soma');
    if (typeof hash === 'string' && /^[0-9a-f]{7,40}$/.test(hash)) return path.join(previewsDir(), s.id, hash);
    return null;
  }

  /** Messdienst vorab starten, sobald der Nutzer den Messmodus einschaltet. */
  async measureStart(): Promise<MeasurePrepared> {
    return this.need().measure.warm();
  }

  /** Den angezeigten Stand vorab in den Messdienst laden. */
  async measurePrepare(source: unknown, build: unknown): Promise<MeasurePrepared> {
    const s = this.need();
    const folder = this.measureFolder(s, source);
    if (!folder || typeof build !== 'string') return { ok: false, error: 'Invalid measurement request.' };
    return s.measure.prepare(folder, build);
  }

  async restore(hash: string): Promise<RestoreResult> {
    const s = this.need();
    const commit = (await s.git.log()).find((c) => c.hash === hash);
    if (!commit) return { cancelled: false, error: 'This version no longer exists in the history.' };
    const c = await choose(this.getWin(), {
      title: 'Restore version',
      message: `Restore “${commit.subject}” (${commit.short})?`,
      detail: 'The files of this version are copied into the working folder and added to the history as a new version. ' +
        'Unsaved changes are first kept as a version of their own. The history stays complete.',
      buttons: ['Restore', 'Cancel'],
    });
    if (c !== 0) return { cancelled: true };
    try {
      const r = await s.git.restore(hash);
      // Ein alter Stand kann andere Zusatzpakete brauchen (E67)
      if (!this.installPackages(s, true)) s.builds.start('version restored');
      this.send('versions:changed');
      this.send('save:state', await this.saveState());
      return { cancelled: false, ...r };
    } catch (e) {
      return { cancelled: false, error: `Restoring failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // ---- Animationen, Ergebnisse, Bilder und Videos (E58) ------------------------------------------------------------

  animList(): AnimList {
    const s = this.need();
    return readAnimList(s.dir, s.anims.busy);
  }

  /** Animationen bauen: eine Datei (animations/x.py) oder alle. */
  animBuild(file: unknown): Promise<AnimBuildResult> {
    const s = this.need();
    const f = file == null ? null : String(file).replace(/\\/g, '/');
    if (f !== null && !affectsAnimation(f)) return Promise.resolve({ ...readAnimList(s.dir), ok: false, error: 'Not an animation file (animations/*.py).' });
    return s.anims.request(f);
  }

  /** Watcher: Eine Animationsdatei hat sich geändert. Mit Auto-Build gleich neu bauen (entprellt), sonst nur melden. */
  private animFileChanged(rel: string): void {
    const s = this.session;
    if (!s) return;
    clearTimeout(s.animTimer);
    s.animTimer = setTimeout(() => {
      if (this.session !== s) return;
      if (s.builds.autoBuild && fs.existsSync(path.join(s.dir, rel))) void s.anims.request(rel);
      else this.send('anim:changed');
    }, 700);
  }

  results(): ResultEntry[] { return listResults(this.need().dir); }

  rerunResult(id: unknown): Promise<{ ok: boolean; error?: string }> {
    const s = this.need();
    return rerunResult(s.dir, String(id ?? ''));
  }

  /** Bild oder Video rendern. Vorher den laufenden Build abwarten, damit das aktuelle Modell zu sehen ist. */
  private async render(req: RenderRequest, byAgent: boolean): Promise<RenderResult> {
    const s = this.need();
    await s.builds.whenIdle();
    const warnings: string[] = [];
    if (s.builds.status.state === 'error') warnings.push('The last build failed. The last successful version is shown.');
    else if (s.builds.status.stale) warnings.push('The code is newer than the last build (auto build is off). The last build is shown.');
    const r = await this.renders.run(s.dir, req, (f) => this.send('render:progress', f));
    const res = { ...r, warnings: [...warnings, ...r.warnings] };
    this.send('render:notice', { ...res, kind: req.kind, byAgent });
    if (r.ok) this.send('fs:changed');
    return res;
  }

  /** Auftrag von `soma render` aus einem Terminal der App (über bridge.ts). */
  async renderForAgent(body: unknown): Promise<{ status: number; body: unknown }> {
    const s = this.session;
    if (!s) return { status: 409, body: { ok: false, error: 'No model is open in the app.' } };
    const project = String((body as { project?: unknown } | null)?.project ?? '');
    if (!project || !samePath(project, s.dir)) {
      return { status: 409, body: { ok: false, error: 'This folder is not the model that is open in the app. soma render only works in the open model.' } };
    }
    const req = checkRequest(s.dir, body);
    if (typeof req === 'string') return { status: 400, body: { ok: false, error: req } };
    const r = await this.render(req, true);
    return { status: r.ok ? 200 : 500, body: r };
  }

  /** Knopf „Video erzeugen“: Animation (falls veraltet) neu bauen, dann rendern nach renders/<id>.mp4. */
  async renderVideo(animId: unknown): Promise<RenderResult> {
    const s = this.need();
    let entry = readAnimList(s.dir).animations.find((a) => a.id === animId);
    if (!entry) return { ok: false, files: [], warnings: [], error: 'This animation does not exist (any more).' };
    if (entry.stale) {
      const file = entry.file;
      const b = await s.anims.request(file);
      entry = b.animations.find((a) => a.id === animId);
      if (!entry) return { ok: false, files: [], warnings: [], error: b.errors.find((e) => e.file === file)?.message ?? b.error ?? 'The animation could not be rebuilt.' };
    }
    return this.render({ kind: 'video', size: [1280, 720], view: null, at: 0, grid: [3, 3], fps: 30, anim: entry.glb, result: null, out: `renders/${entry.id}.mp4` }, false);
  }

  // ---- Beenden ----------------------------------------------------------------------------------------------------

  /**
   * Darf das Fenster schließen? Bei ungespeicherten Änderungen fragt die App. Der Arbeitsstand bleibt in jedem Fall erhalten,
   * Eingaben im Editor (`editor.dirty`) aber nur, wenn sie gespeichert werden. „Nicht speichern“ legt sie als Sicherung ab.
   */
  // ---- Parameter (param() im Code, Werte des Nutzers in parameters.json) -------------------------------------------

  paramState(): ParamState {
    const s = this.need();
    const u = readUserParams(s.dir);
    return { params: s.builds.params, values: u.values, ...(u.error ? { error: u.error } : {}), ...(s.builds.paramsStale ? { stale: true } : {}) };
  }

  /**
   * Werte des Nutzers setzen (null: zurück auf den Wert aus dem Code) und gleich bauen, wie Strg+S im Editor (E39), auch
   * ohne Auto-Build: Der Nutzer hat ausdrücklich etwas geändert und will das Ergebnis sehen. Erst alles prüfen, dann schreiben.
   */
  setParams(values: unknown): ParamResult {
    const s = this.need();
    const fail = (message: string): ParamResult => ({ ok: false, message, ...this.paramState() });
    if (typeof values !== 'object' || values === null || Array.isArray(values)) return fail('No values given.');
    const defs = new Map((s.builds.params ?? []).map((p) => [p.name, p]));
    const changes: Record<string, ParamValue | null> = {};
    for (const [name, v] of Object.entries(values as Record<string, unknown>)) {
      if (v === null) { changes[name] = null; continue; }
      if (!isParamValue(v)) return fail(`The value for ${name} cannot be stored.`);
      const why = checkParamValue(defs.get(name), v);
      if (why) return fail(why);
      changes[name] = v;
    }
    if (!Object.keys(changes).length) return { ok: true, ...this.paramState() };
    const err = writeUserParams(s.dir, changes);
    if (err) return fail(err);
    s.builds.start('parameter changed');
    return { ok: true, ...this.paramState() };
  }

  /** Alle Werte des Nutzers entfernen. */
  resetAllParams(): ParamResult {
    const s = this.need();
    const u = readUserParams(s.dir);
    if (u.error) return { ok: false, message: `${u.error} Nothing was changed.`, ...this.paramState() };
    return this.setParams(Object.fromEntries(Object.keys(u.values).map((k) => [k, null])));
  }

  // ---- Skills (E17) -----------------------------------------------------------------------------------------------

  skills(): SkillInfo[] {
    const s = this.need();
    return listSkills(s.dir, skillsDir(), readSkillModes(s.id), readProjectJson(s.id)?.skill_settings ?? null, getSkillDefaults());
  }

  /** Stufe für neue Modelle festlegen (E46, E55). Gilt für die App, das offene Modell bleibt, wie es ist. */
  setSkillDefault(skill: unknown, mode: unknown): SkillResult {
    this.need();
    const list = () => this.skills();
    const b = isSkillId(skill) ? bundledSkill(skillsDir(), skill) : undefined;
    if (!b) return { ok: false, error: 'The app does not include this skill. New models cannot get it.', skills: list() };
    if (!isSkillMode(mode)) return { ok: false, error: `Unknown level “${String(mode)}”.`, skills: list() };
    try {
      setSkillDefault(b.id, mode, b.defaultMode);
      return { ok: true, skills: list() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), skills: list() };
    }
  }

  /** Gültige, vom Standard abweichende Werte eines Skills laut project.json. */
  private skillValues(id: string, skill: string): SkillValues {
    const b = bundledSkill(skillsDir(), skill);
    return b ? cleanValues(b.vars, readProjectJson(id)?.skill_settings?.[skill]) : {};
  }

  /**
   * Stufe eines Skills setzen (E55): Aus entfernt die Kopie in .soma/skills/, Bei Bedarf und Immer schreiben sie (mit oder
   * ohne Hinweis für den Agenten). Abweichendes kommt vorher in die Sicherung. Danach project.json und den Abschnitt in
   * AGENTS.md nachziehen. Erst die Prüfung, dann die Änderungen.
   */
  setSkill(skill: unknown, mode: unknown): SkillResult {
    const s = this.need();
    const modes = readSkillModes(s.id);
    const list = () => this.skills();
    if (!isSkillId(skill)) return { ok: false, error: 'Unknown skill.', skills: list() };
    if (!isSkillMode(mode)) return { ok: false, error: `Unknown level “${String(mode)}”.`, skills: list() };
    if (!modes) return { ok: false, error: '.soma/project.json is missing or unreadable. Without it no skill can be switched.', skills: list() };
    try {
      const values = this.skillValues(s.id, skill);
      const was = modeOf(modes, skill);
      // Von einer eingeschalteten Stufe aus ist die bisherige Kopie der App unverändert ersetzbar, von Aus aus nicht (Reste)
      const backup = mode === 'off'
        ? removeSkill(s.dir, skillsDir(), skill, skillBackupsDir(s.id), values)
        : copySkill(s.dir, skillsDir(), skill, skillBackupsDir(s.id), values, mode, was === 'off' ? undefined : values);
      const next = withMode(modes, skill, mode);
      updateProjectSkills(s.id, { modes: next });
      const warning = writeAgentsList(s.dir, agentsEntries(s.dir, skillsDir(), next));
      return { ok: true, backup, ...(warning ? { warning } : {}), skills: list() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), skills: list() };
    }
  }

  /**
   * Einstellungen eines Skills ändern (null: zurück zum Standard). Erst alles prüfen, dann speichern. Ist der Skill nicht
   * aus, wird seine Kopie mit den neuen Werten geschrieben (von Hand Geändertes vorher in die Sicherung).
   */
  configureSkill(skill: unknown, values: unknown): SkillResult {
    const s = this.need();
    const list = () => this.skills();
    const b = isSkillId(skill) ? bundledSkill(skillsDir(), skill) : undefined;
    if (!isSkillId(skill) || !b) return { ok: false, error: 'The app does not include this skill, it cannot be configured.', skills: list() };
    const pj = readProjectJson(s.id);
    if (!pj) return { ok: false, error: '.soma/project.json is missing or unreadable. Without it nothing can be configured.', skills: list() };
    if (!values || typeof values !== 'object') return { ok: false, error: 'No values.', skills: list() };
    const prev = this.skillValues(s.id, skill);
    const next: SkillValues = { ...prev };
    for (const [name, raw] of Object.entries(values as Record<string, unknown>)) {
      const v = b.vars.find((x) => x.name === name);
      if (!v) return { ok: false, error: `The skill has no setting “${name}”.`, skills: list() };
      if (raw === null) { delete next[name]; continue; }
      const r = checkValue(v, raw);
      if ('error' in r) return { ok: false, error: r.error, skills: list() };
      if (r.value === v.default) delete next[name]; else next[name] = r.value;
    }
    try {
      updateProjectSkills(s.id, { skill_settings: { ...(pj.skill_settings ?? {}), [skill]: next } });
      const modes = readSkillModes(s.id);
      const mode = modes ? modeOf(modes, skill) : 'off';
      const backup = mode !== 'off' ? copySkill(s.dir, skillsDir(), skill, skillBackupsDir(s.id), next, mode, prev) : null;
      return { ok: true, backup, skills: list() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), skills: list() };
    }
  }

  async confirmClose(editor: { dirty: string[]; save(): Promise<boolean>; discard(): Promise<void> }): Promise<boolean> {
    if (!this.session || process.env.SOMA_TEST === '1') return true;
    // Ein unverändertes neues Modell hat nichts zu speichern, es verschwindet beim Beenden (leave, E69)
    if (!editor.dirty.length && (await isUntouched(this.session.id))) return true;
    const st = await this.saveState();
    if (!st.unsaved && !editor.dirty.length) return true;
    const inEditor = editor.dirty.length ? `Not yet saved in the editor: ${editor.dirty.join(', ')}. ` : '';
    const c = await choose(this.getWin(), {
      title: 'Quit SOMA',
      message: 'The model has unsaved changes.',
      detail: `${inEditor}Your current work stays on this computer, the start page shows it among the recent models. The ZIP file is only updated when you save.`,
      buttons: ['Save', 'Don’t save', 'Cancel'],
    });
    if (c === 2) return false;
    if (c === 0) {
      if (!(await editor.save())) return false;
      const r = await this.save(false);
      if (r.cancelled || r.error) return false;
    } else await editor.discard();
    return true;
  }

  /**
   * Modell von der Startseite entfernen (E69): Der Arbeitsordner kommt in den Papierkorb (dort lässt er sich wiederherstellen),
   * die Daten der App dazu werden gelöscht, Sicherungen bleiben. Die Rückfrage sagt, was dabei verloren geht: nichts, wenn
   * der Stand in der ZIP-Datei steckt, sonst die Änderungen seit dem Speichern bzw. das ganze Modell. Ein unverändertes neues
   * Modell geht ohne Rückfrage. Das gerade geöffnete Modell nicht (erst ein anderes öffnen).
   */
  async remove(id: string): Promise<RemoveResult> {
    if (!isProjectId(id) || !fs.existsSync(projectDir(id))) return { removed: false, error: 'This model no longer exists on this computer.' };
    if (this.session?.id === id) return { removed: false, error: 'The open model cannot be removed. Open another one first.' };
    const dir = projectDir(id);
    if (!(await isUntouched(id))) {
      const name = readProjectJson(id)?.name ?? id.slice(0, 8);
      const app = getAppState(id);
      const git = new GitRepo(dir);
      const st = (await git.isRepo()) ? await git.status() : null;
      const zip = app.zipPath && fs.existsSync(app.zipPath) ? app.zipPath : null;
      const inZip = !!zip && !!st && !st.dirty && st.head === (app.savedHead ?? null);
      const where = 'The working folder on this computer goes to the Recycle Bin, where it can be restored.';
      const c = await choose(this.getWin(), {
        title: 'Remove model',
        message: inZip ? `Remove “${name}” from this computer?` : zip ? `“${name}” has changes that are not in the ZIP file.` : `“${name}” was never saved.`,
        detail: inZip ? `${where} The ZIP file stays (${zip}), opening it brings the model back.`
          : zip ? `${where} The ZIP file (${zip}) stays, but it lacks the changes since the last save.`
            : `${where} If it is deleted there, the model is lost.`,
        buttons: ['Remove', 'Cancel'],
      });
      if (c !== 0) return { removed: false, cancelled: true };
    }
    // Ein eben verlassenes Modell hält seine beendete Shell unter Windows noch einige Sekunden fest: mehrere Versuche
    for (let attempt = 0; ; attempt++) {
      try { await trashItem(dir); break; } catch (e) {
        if (attempt >= 20) return { removed: false, error: `Could not move the working folder to the Recycle Bin (still in use?), nothing was removed: ${e instanceof Error ? e.message : String(e)}` };
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    forgetProject(id);
    return { removed: true };
  }
}
