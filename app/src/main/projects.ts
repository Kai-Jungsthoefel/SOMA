import { shell, type BrowserWindow, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ExportResult, GitLog, MeasureEntity, MeasureRequest, MeasureResponse, ModelMap, OpenResult, PreviewResult, ProjectInfo, RestoreResult, SaveResult, SaveState, SkillInfo, SkillResult } from '../shared/types';
import { BuildManager, buildIsStale, newestSourceMtime, runSoma } from './build';
import { choose, choosePath } from './dialogs';
import { GitRepo } from './git';
import { MeasureService } from './measure';
import { previewsDir, skillBackupsDir, skillsDir } from './paths';
import { copySkill, isSkillId, listSkills, removeSkill, skillName, writeAgentsList } from './skills';
import { TerminalManager } from './terminals';
import { watchProject } from './watcher';
import {
  backupWorkspace, createProject, extractProject, getAppState, inspectProject, isProjectId, patchAppState, projectDir,
  readProjectJson, renameProject, setLastProject, setProjectSkills,
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
    s.stopWatch();
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
    builds.on('status', (st) => this.send('build:status', st));
    const stopWatch = watchProject(dir, (rel) => builds.sourceChanged(rel ? path.join(dir, rel) : null), () => this.send('fs:changed'));
    const session: Session = { id, dir, builds, terminals, git, measure: new MeasureService(dir), stopWatch, signature: '', poll: setInterval(() => void this.pollGit(), POLL_MS) };
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

  /** Einzelexport über `soma export` (E34). Der Export baut das Modell selbst, der Viewer bleibt davon unberührt. */
  async exportModel(format: string, part: string | null): Promise<ExportResult> {
    const s = this.need();
    if (!/^[a-z0-9]{2,5}$/.test(format)) return { ok: false, files: [], error: `Unbekanntes Format: ${format}` };
    // `--` vor dem Namen: Bauteilnamen dürfen mit einem Minus beginnen, ohne als Option zu gelten
    const args = ['export', '--format', format, '--project', s.dir, ...(part ? ['--', part] : ['--all'])];
    const r = await runSoma(args, s.dir, 5 * 60 * 1000);
    const files = [...r.out.matchAll(/^exportiert: (.+)$/gm)].map((m) => m[1].trim());
    if (r.ok) return { ok: true, files };
    const msg = (r.err || r.out).trim().split(/\r?\n/).slice(-3).join('\n');
    return { ok: false, files, error: msg || 'Export fehlgeschlagen' };
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

  // ---- Beenden ----------------------------------------------------------------------------------------------------

  /**
   * Darf das Fenster schließen? Bei ungespeicherten Änderungen fragt die App. Der Arbeitsstand bleibt in jedem Fall erhalten,
   * Eingaben im Editor (`editor.dirty`) aber nur, wenn sie gespeichert werden. „Nicht speichern“ legt sie als Sicherung ab.
   */
  // ---- Skills (E17) -----------------------------------------------------------------------------------------------

  /** Aktive Skills laut project.json, null wenn sie unlesbar ist. */
  private activeSkills(id: string): string[] | null {
    const pj = readProjectJson(id);
    return pj ? (Array.isArray(pj.skills) ? pj.skills.filter(isSkillId) : []) : null;
  }

  skills(): SkillInfo[] {
    const s = this.need();
    return listSkills(s.dir, skillsDir(), this.activeSkills(s.id));
  }

  /**
   * Skill ein- oder ausschalten: Kopie in .soma/skills/ anlegen oder entfernen (Abweichendes vorher in die Sicherung),
   * project.json und den Abschnitt in AGENTS.md nachziehen. Erst die Prüfung, dann die Änderungen.
   */
  setSkill(skill: unknown, on: unknown): SkillResult {
    const s = this.need();
    const active = this.activeSkills(s.id);
    const list = () => this.skills();
    if (!isSkillId(skill)) return { ok: false, error: 'Unbekannter Skill.', skills: list() };
    if (!active) return { ok: false, error: '.soma/project.json fehlt oder ist unlesbar. Ohne sie lässt sich kein Skill ein- oder ausschalten.', skills: list() };
    try {
      const backup = on ? copySkill(s.dir, skillsDir(), skill, skillBackupsDir(s.id)) : removeSkill(s.dir, skillsDir(), skill, skillBackupsDir(s.id));
      const next = on ? [...new Set([...active, skill])] : active.filter((x) => x !== skill);
      setProjectSkills(s.id, next);
      const warning = writeAgentsList(s.dir, next.map((id) => ({ id, name: skillName(s.dir, skillsDir(), id) })));
      return { ok: true, backup, ...(warning ? { warning } : {}), skills: list() };
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
