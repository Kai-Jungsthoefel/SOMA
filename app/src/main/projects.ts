import { shell, type BrowserWindow, type WebContents } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AnimBuildResult, AnimList, ExportResult, GitLog, MeasureEntity, MeasureRequest, MeasureResponse, ModelMap, OpenResult, PreviewResult,
  ProjectInfo, RenderResult, RestoreResult, ResultEntry, SaveResult, SaveState, SkillInfo, SkillResult,
} from '../shared/types';
import { affectsAnimation } from '../shared/editable';
import { AnimBuilder, listResults, readAnimList, rerunResult, samePath } from './animations';
import { BuildManager, buildIsStale, newestSourceMtime, runSoma } from './build';
import { checkRequest, RenderService, type RenderRequest } from './render';
import { choose, chooseExportTarget, choosePath, documentsDir } from './dialogs';
import { GitRepo } from './git';
import { MeasureService } from './measure';
import { previewsDir, skillBackupsDir, skillsDir } from './paths';
import {
  agentsEntries, bundledSkill, checkValue, cleanValues, copySkill, isSkillId, isSkillMode, listSkills, modeOf, removeSkill, withMode, writeAgentsList, type SkillValues,
} from './skills';
import { TerminalManager } from './terminals';
import { watchProject } from './watcher';
import {
  backupWorkspace, createProject, extractProject, getAppState, inspectProject, isProjectId, patchAppState, projectDir,
  getSkillDefaults, readProjectJson, readSkillModes, renameProject, setLastProject, setSkillDefault, updateProjectSkills,
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
}

const POLL_MS = 2000;
const safeFileName = (n: string) => n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Modell';

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
  need(): Session { if (!this.session) throw new Error('Kein Projekt geöffnet'); return this.session; }

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

  async open(id: string): Promise<ProjectInfo> {
    this.close();
    const dir = projectDir(id);
    const builds = new BuildManager(dir);
    const terminals = new TerminalManager(this.wc, dir);
    const git = new GitRepo(dir);
    void git.ensureIgnored(); // ältere Projekte: Zwischenergebnisse auch aus den Commits des Agenten heraushalten
    builds.on('status', (st) => this.send('build:status', st));
    const anims = new AnimBuilder(dir, () => this.send('anim:changed'));
    const stopWatch = watchProject(dir, (rel) => builds.sourceChanged(rel ? path.join(dir, rel) : null), () => this.send('fs:changed'),
      (rel) => this.animFileChanged(rel));
    const session: Session = { id, dir, builds, terminals, git, measure: new MeasureService(dir), anims, stopWatch, signature: '', poll: setInterval(() => void this.pollGit(), POLL_MS) };
    this.session = session;
    setLastProject(id);
    // Erster Build direkt beim Öffnen, damit der Viewer nicht leer ist (der Nutzer kann Auto-Build danach abschalten).
    builds.start('Projekt geöffnet');
    const info = this.info();
    this.send('project:changed', info);
    return info;
  }

  async create(): Promise<ProjectInfo> {
    const { id } = await createProject();
    return this.open(id);
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
    } catch { /* nächster Durchlauf */ }
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
    if (!/^[a-z0-9]{2,5}$/.test(format)) return { ok: false, files: [], error: `Unbekanntes Format: ${format}` };
    const last = getAppState(s.id).exportDir;
    const startDir = last && fs.existsSync(last) ? last : documentsDir();
    const target = await chooseExportTarget(this.getWin(), part
      ? { kind: 'file', title: `„${part}“ exportieren`, defaultPath: path.join(startDir, `${safeFileName(part)}.${format}`), ext: format }
      : { kind: 'dir', title: 'Ordner für den Export wählen', defaultPath: startDir });
    if (!target) return { ok: false, files: [], cancelled: true };
    let tmp: string | null = null;
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-export-'));
      // `--` vor dem Namen: Bauteilnamen dürfen mit einem Minus beginnen, ohne als Option zu gelten
      const args = ['export', '--format', format, '--project', s.dir, '--out', tmp, ...(part ? ['--', part] : ['--all'])];
      const r = await runSoma(args, s.dir, 5 * 60 * 1000);
      if (!r.ok) {
        const msg = (r.err || r.out).trim().split(/\r?\n/).slice(-3).join('\n');
        return { ok: false, files: [], error: msg || 'Export fehlgeschlagen' };
      }
      // Alles aus dem Ordner übernehmen, nicht nur die gemeldeten Dateien (glTF kann eine .bin daneben schreiben)
      const dir = tmp;
      const made = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile());
      if (!made.length) return { ok: false, files: [], error: 'soma hat keine Datei geschrieben.' };
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
          title: 'Exportieren', message: exists.length === 1 ? 'Diese Datei gibt es im Ordner schon:' : `Diese ${exists.length} Dateien gibt es im Ordner schon:`,
          detail: `${exists.slice(0, 10).join('\n')}${exists.length > 10 ? `\n… und ${exists.length - 10} weitere` : ''}`, buttons: ['Ersetzen', 'Abbrechen'],
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
      return { ok: false, files: [], error: `Export fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}` };
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
      const chosen = await choosePath(this.getWin(), 'save', `${safeFileName(pj?.name ?? 'Modell')}.zip`);
      if (!chosen) return { cancelled: true };
      zipPath = /\.zip$/i.test(chosen) ? chosen : `${chosen}.zip`;
      renameProject(s.id, path.basename(zipPath).replace(/\.zip$/i, '')); // der Modellname folgt dem Dateinamen
    }
    const warnings: string[] = [];
    try {
      // Die ZIP soll das aktuelle Ergebnis enthalten: laufenden Build abwarten, veralteten vorher nachholen.
      if (!s.builds.busy && buildIsStale(s.dir)) s.builds.start('vor dem Speichern');
      await s.builds.whenIdle();
      if (s.builds.status.state === 'error') warnings.push('Der letzte Build ist fehlgeschlagen. Die ZIP enthält den letzten erfolgreichen Stand von output/model.step.');

      let snapshot: string | null = null;
      if (await s.git.isRepo()) {
        try { snapshot = await s.git.snapshot('Automatischer Snapshot beim Speichern'); }
        catch (e) { warnings.push(`Snapshot im Verlauf nicht möglich: ${e instanceof Error ? e.message : String(e)}`); }
      } else warnings.push('Kein Git-Verlauf vorhanden: Es wurde kein Snapshot angelegt.');

      const head = await s.git.head();
      const pj = readProjectJson(s.id);
      const info: ZipInfo = { savedAt: new Date().toISOString(), head, id: s.id, name: pj?.name ?? s.id };
      const r = await saveProjectZip(s.dir, zipPath, info);
      patchAppState(s.id, { zipPath, savedHead: head, savedAt: Date.now() });
      this.send('save:state', await this.saveState());
      this.send('versions:changed');
      return { cancelled: false, zipPath, snapshot, files: r.files, bytes: r.bytes, warnings };
    } catch (e) {
      return { cancelled: false, error: `Speichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}` };
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
    catch (e) { return { cancelled: false, error: `Die ZIP lässt sich nicht lesen: ${e instanceof Error ? e.message : String(e)}` }; }
    let id: string;
    let info: ZipInfo | null = null;
    try {
      id = (JSON.parse(texts['.soma/project.json'] ?? '') as { id?: string }).id ?? '';
      if (texts[ZIP_INFO_PATH]) info = JSON.parse(texts[ZIP_INFO_PATH]!) as ZipInfo;
    } catch { id = ''; }
    if (!isProjectId(id)) return { cancelled: false, error: 'Das ist keine SOMA-Datei (.soma/project.json fehlt oder ist ungültig).' };

    const dir = projectDir(id);
    const remember = () => patchAppState(id, { zipPath, savedHead: info?.head ?? null, savedAt: Date.now() });

    if (!fs.existsSync(dir)) {
      try { await extractProject(zipPath, id); } catch (e) { return { cancelled: false, error: `Entpacken fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}` }; }
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
    if (st.dirty) why = 'Der Arbeitsordner enthält ungespeicherte Änderungen.';
    else if (info?.head && wsHead && (await git.isAncestor(info.head, wsHead))) why = 'Der Arbeitsordner ist neuer als die ZIP.';
    else if (info?.head && wsHead && (await git.isAncestor(wsHead, info.head))) why = 'Die ZIP ist neuer als der Arbeitsordner.';
    else why = 'Arbeitsordner und ZIP haben verschiedene Stände.';
    const choice = await choose(this.getWin(), {
      title: 'Arbeitsordner und ZIP weichen ab',
      message: `${why} Was soll geöffnet werden?`,
      detail: 'Arbeitsstand behalten: Das Modell wird so geöffnet, wie es auf diesem Rechner liegt.\n' +
        'ZIP laden: Der Stand aus der ZIP wird geöffnet. Der bisherige Arbeitsordner wird gesichert, nichts wird gelöscht.',
      buttons: ['Arbeitsstand behalten', 'ZIP laden', 'Abbrechen'],
    });
    if (choice === 0) { patchAppState(id, { zipPath }); await this.open(id); return { cancelled: false, opened: true }; }
    if (choice !== 1) return { cancelled: true };
    try {
      if (this.session?.id === id) this.close(); // offene Handles würden das Umbenennen blockieren
      await backupWorkspace(id);
      await extractProject(zipPath, id);
    } catch (e) { return { cancelled: false, error: `ZIP laden fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}` }; }
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
    if (!/^[0-9a-f]{7,40}$/.test(hash)) return { ...empty, error: 'Ungültiger Stand' };
    const commit = (await s.git.log()).find((c) => c.hash === hash) ?? null;
    const dir = path.join(previewsDir(), s.id, hash);
    try {
      // Ältere Vorschauen haben noch keine Geometrie zum Messen: dann neu erzeugen
      if (!fs.existsSync(path.join(dir, 'model.glb')) || !fs.existsSync(path.join(dir, 'geometry'))) {
        const step = path.join(dir, 'model.step');
        await s.git.exportFile(hash, 'output/model.step', step);
        const r = await runSoma(['glb', step, '--out', dir], s.dir);
        if (!r.ok) throw new Error((r.err || r.out).trim().split('\n').pop() || 'Umwandlung fehlgeschlagen');
      }
      const glb = fs.readFileSync(path.join(dir, 'model.glb'));
      const map = JSON.parse(fs.readFileSync(path.join(dir, 'model.map.json'), 'utf8')) as ModelMap;
      return { commit, glb: glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, map };
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      const msg = e instanceof Error ? e.message : String(e);
      return { ...empty, commit, error: /exists on disk, but not in|does not exist|Path .* does not exist|invalid object/i.test(msg)
        ? 'Dieser Stand enthält kein output/model.step (noch nicht gebaut).' : `Vorschau nicht möglich: ${msg}` };
    }
  }

  /**
   * Exakte Messung (E9). Der Renderer nennt nur die Quelle (aktueller Stand oder Vorschau), den Ordner bestimmt der
   * Hauptprozess. Die Anfrage wird auf die erwartete Form gebracht, bevor sie an den Python-Dienst geht.
   */
  async measure(source: unknown, req: unknown): Promise<MeasureResponse> {
    const s = this.need();
    let folder: string;
    const hash = (source as { preview?: unknown } | null)?.preview;
    if (source === 'live') folder = path.join(s.dir, '.soma');
    else if (typeof hash === 'string' && /^[0-9a-f]{7,40}$/.test(hash)) folder = path.join(previewsDir(), s.id, hash);
    else return { ok: false, error: 'Unbekannte Quelle für die Messung.' };
    const r = req as { build?: unknown; a?: unknown; b?: unknown } | null;
    const ent = (v: unknown): MeasureEntity | null => {
      const e = v as { part?: unknown; kind?: unknown; id?: unknown; point?: unknown; check?: unknown } | null;
      if (!e || typeof e.part !== 'string' || (e.kind !== 'face' && e.kind !== 'edge' && e.kind !== 'vertex') || !Number.isInteger(e.id)) return null;
      const pt = Array.isArray(e.point) && e.point.length === 3 && e.point.every((x) => Number.isFinite(x)) ? (e.point as number[]) : null;
      return { part: e.part, kind: e.kind, id: e.id as number, point: pt, check: Number.isFinite(e.check) ? (e.check as number) : undefined };
    };
    const a = ent(r?.a), b = r?.b == null ? undefined : ent(r.b);
    if (!a || b === null || typeof r?.build !== 'string') return { ok: false, error: 'Ungültige Messanfrage.' };
    const clean: MeasureRequest = { build: r.build, a, ...(b ? { b } : {}) };
    return s.measure.request(folder, clean);
  }

  async restore(hash: string): Promise<RestoreResult> {
    const s = this.need();
    const commit = (await s.git.log()).find((c) => c.hash === hash);
    if (!commit) return { cancelled: false, error: 'Dieser Stand existiert im Verlauf nicht mehr.' };
    const c = await choose(this.getWin(), {
      title: 'Stand wiederherstellen',
      message: `„${commit.subject}“ (${commit.short}) wiederherstellen?`,
      detail: 'Die Dateien dieses Standes werden in den Arbeitsordner kopiert und als neuer Stand im Verlauf abgelegt. ' +
        'Ungesicherte Änderungen werden vorher als eigener Stand gesichert. Der Verlauf bleibt vollständig.',
      buttons: ['Wiederherstellen', 'Abbrechen'],
    });
    if (c !== 0) return { cancelled: true };
    try {
      const r = await s.git.restore(hash);
      s.builds.start('Stand wiederhergestellt');
      this.send('versions:changed');
      this.send('save:state', await this.saveState());
      return { cancelled: false, ...r };
    } catch (e) {
      return { cancelled: false, error: `Wiederherstellen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}` };
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
    if (f !== null && !affectsAnimation(f)) return Promise.resolve({ ...readAnimList(s.dir), ok: false, error: 'Keine Animationsdatei (animations/*.py).' });
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
    if (s.builds.status.state === 'error') warnings.push('Der letzte Build ist fehlgeschlagen. Zu sehen ist der letzte erfolgreiche Stand.');
    else if (s.builds.status.stale) warnings.push('Der Code ist neuer als der letzte Build (Auto-Build ist aus). Zu sehen ist der letzte Build.');
    const r = await this.renders.run(s.dir, req, (f) => this.send('render:progress', f));
    const res = { ...r, warnings: [...warnings, ...r.warnings] };
    this.send('render:notice', { ...res, kind: req.kind, byAgent });
    if (r.ok) this.send('fs:changed');
    return res;
  }

  /** Auftrag von `soma render` aus einem Terminal der App (über bridge.ts). */
  async renderForAgent(body: unknown): Promise<{ status: number; body: unknown }> {
    const s = this.session;
    if (!s) return { status: 409, body: { ok: false, error: 'In der App ist kein Modell offen.' } };
    const project = String((body as { project?: unknown } | null)?.project ?? '');
    if (!project || !samePath(project, s.dir)) {
      return { status: 409, body: { ok: false, error: 'Dieser Ordner ist nicht das Modell, das in der App offen ist. soma render läuft nur im offenen Modell.' } };
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
    if (!entry) return { ok: false, files: [], warnings: [], error: 'Diese Animation gibt es nicht (mehr).' };
    if (entry.stale) {
      const file = entry.file;
      const b = await s.anims.request(file);
      entry = b.animations.find((a) => a.id === animId);
      if (!entry) return { ok: false, files: [], warnings: [], error: b.errors.find((e) => e.file === file)?.message ?? b.error ?? 'Die Animation ließ sich nicht neu bauen.' };
    }
    return this.render({ kind: 'video', size: [1280, 720], view: null, at: 0, grid: [3, 3], fps: 30, anim: entry.glb, result: null, out: `renders/${entry.id}.mp4` }, false);
  }

  // ---- Beenden ----------------------------------------------------------------------------------------------------

  /**
   * Darf das Fenster schließen? Bei ungespeicherten Änderungen fragt die App. Der Arbeitsstand bleibt in jedem Fall erhalten,
   * Eingaben im Editor (`editor.dirty`) aber nur, wenn sie gespeichert werden. „Nicht speichern“ legt sie als Sicherung ab.
   */
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
    if (!b) return { ok: false, error: 'Diesen Skill bringt die App nicht mit. Neue Modelle können ihn nicht bekommen.', skills: list() };
    if (!isSkillMode(mode)) return { ok: false, error: `Unbekannte Stufe „${String(mode)}“.`, skills: list() };
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
    if (!isSkillId(skill)) return { ok: false, error: 'Unbekannter Skill.', skills: list() };
    if (!isSkillMode(mode)) return { ok: false, error: `Unbekannte Stufe „${String(mode)}“.`, skills: list() };
    if (!modes) return { ok: false, error: '.soma/project.json fehlt oder ist unlesbar. Ohne sie lässt sich kein Skill umstellen.', skills: list() };
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
    if (!isSkillId(skill) || !b) return { ok: false, error: 'Diesen Skill bringt die App nicht mit, er lässt sich nicht einstellen.', skills: list() };
    const pj = readProjectJson(s.id);
    if (!pj) return { ok: false, error: '.soma/project.json fehlt oder ist unlesbar. Ohne sie lässt sich nichts einstellen.', skills: list() };
    if (!values || typeof values !== 'object') return { ok: false, error: 'Keine Werte.', skills: list() };
    const prev = this.skillValues(s.id, skill);
    const next: SkillValues = { ...prev };
    for (const [name, raw] of Object.entries(values as Record<string, unknown>)) {
      const v = b.vars.find((x) => x.name === name);
      if (!v) return { ok: false, error: `Der Skill hat keine Einstellung „${name}“.`, skills: list() };
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
    const st = await this.saveState();
    if (!st.unsaved && !editor.dirty.length) return true;
    const inEditor = editor.dirty.length ? `Im Editor noch nicht gespeichert: ${editor.dirty.join(', ')}. ` : '';
    const c = await choose(this.getWin(), {
      title: 'SOMA beenden',
      message: 'Das Modell hat ungespeicherte Änderungen.',
      detail: `${inEditor}Der Arbeitsstand bleibt auf diesem Rechner erhalten und wird beim nächsten Start wieder geöffnet. Die ZIP-Datei wird nur beim Speichern aktualisiert.`,
      buttons: ['Speichern', 'Nicht speichern', 'Abbrechen'],
    });
    if (c === 2) return false;
    if (c === 0) {
      if (!(await editor.save())) return false;
      const r = await this.save(false);
      if (r.cancelled || r.error) return false;
    } else await editor.discard();
    return true;
  }
}
