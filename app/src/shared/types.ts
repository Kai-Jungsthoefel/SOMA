// Von Hauptprozess, Preload und Renderer gemeinsam genutzte Typen (IPC-Vertrag).

export interface ProjectInfo {
  id: string;
  name: string;
  dir: string;
  /** Gefundene Auffaelligkeiten im Projekt (nur melden, nie automatisch reparieren, E28). */
  problems: string[];
  autoBuild: boolean;
}

export interface ProjectListEntry { id: string; name: string; modified: number }

export interface BuildError { kind: string; message: string; file: string | null; line: number | null; traceback: string }

export interface BuildResult {
  status: 'ok' | 'error';
  parts?: { name: string; role: string; file: string; line: number }[];
  error?: BuildError;
  timings?: Record<string, number>;
  warnings?: string[];
}

export type BuildState = 'idle' | 'building' | 'ok' | 'error';
export interface BuildStatus {
  state: BuildState; result?: BuildResult; startedAt?: number; queued?: boolean; reason?: string;
  /** Gesamtdauer des letzten Builds in Sekunden, vom Start bis zum Ergebnis (inkl. Python-Start). */
  seconds?: number;
  /** Auto-Build ist aus und der Quelltext hat sich seit dem letzten Build geändert. */
  stale?: boolean;
}

/** Einzelexport über `soma export` (E34). `files` relativ zum Projekt. */
export interface ExportResult { ok: boolean; files: string[]; error?: string }
/** Dateien, die per Ziehen nach inputs/ kopiert wurden (E33). */
export interface ImportResult { files: string[]; errors: string[] }
/**
 * Schreiben aus dem Editor. `conflict`: Die Datei hat sich seit dem Laden außerhalb geändert (meist durch den Agenten),
 * `disk` ist ihr aktueller Inhalt (null: gelöscht). `backup`: Pfad der Sicherung der überschriebenen Fassung.
 */
export interface WriteResult { ok: boolean; conflict?: boolean; disk?: string | null; backup?: string; error?: string }
/** Gespeicherte Markierung (E16). `path` relativ zum Projekt, z. B. `.soma/feedback/markierung-20260930-1405.png`. */
export interface FeedbackResult { ok: boolean; path?: string; error?: string }

/** Anlegen, Umbenennen oder Löschen im Dateibaum. `path` relativ zum Projekt (neuer Pfad), `canceled`: Rückfrage abgelehnt. */
export interface FileOpResult { ok: boolean; path?: string; error?: string; canceled?: boolean }

export interface FileNode { name: string; path: string; dir: boolean; children?: FileNode[] }

export interface AgentInfo { id: string; label: string; command: string; found: boolean }

export interface PartMap {
  id: string; name: string; step_name: string; role: string;
  file?: string; line?: number; end_line?: number; volume?: number;
  /** Gruppe mit „/“ verschachtelt, z. B. „Gehäuse/Schrauben“ (aus add_part(group=…) oder einer importierten Baugruppe). */
  group?: string | null;
  /** Achsparallele Hülle [[xmin, ymin, zmin], [xmax, ymax, zmax]] in mm. */
  bbox?: number[][];
}
/** `build`: Kennung des Builds. Sie verbindet GLB, Mapping und die exakte Geometrie für das Messen. */
export interface ModelMap { version: number; build?: string; parts: PartMap[] }

/** Art eines Elements beim Messen: Fläche, Kante oder Eckpunkt. */
export type MeasureKind = 'face' | 'edge' | 'vertex';
/**
 * Angeklicktes Element (E9). `point`: Klickpunkt auf dem Netz, bei Eckpunkten ihre Lage (zum Abgleich).
 * `check`: Flächeninhalt bzw. Länge laut Viewer, zum Abgleich.
 */
export interface MeasureEntity { part: string; kind: MeasureKind; id: number; point: number[] | null; check?: number }
export interface MeasureRequest { build: string; a: MeasureEntity; b?: MeasureEntity }
/** Exakte Angaben zu einem Element, Längen in mm, Winkel in Grad. `point`: Klickpunkt, exakt auf das Element gelegt. */
export interface MeasureInfo {
  kind: MeasureKind; part: string; name?: string; type: string; point: number[] | null;
  area?: number; length?: number; radius?: number; normal?: number[]; origin?: number[];
  axis?: { point: number[]; dir: number[] }; center?: number[]; start?: number[]; end?: number[]; dir?: number[];
  semiAngle?: number; refRadius?: number; majorRadius?: number; minorRadius?: number; closed?: boolean;
}
/** Eine Strecke: Wert und die beiden Endpunkte (zum Zeichnen). */
export interface MeasureSpan { value: number; p1: number[]; p2: number[]; delta?: number[] }
/**
 * `planes`: Abstand paralleler Ebenen, `axes`: Abstand paralleler Achsen, `min`: kürzester Abstand, `points`: Klickpunkt zu
 * Klickpunkt. Mit einem Eckpunkt: `toPlane`, `toAxis`, `toLine` (Lot auf die unbegrenzte Ebene, Achse bzw. Gerade).
 */
export interface MeasurePair {
  min: MeasureSpan; points?: MeasureSpan; planes?: MeasureSpan; axes?: MeasureSpan;
  toPlane?: MeasureSpan; toAxis?: MeasureSpan; toLine?: MeasureSpan; angle?: number;
}
export interface MeasureResult { build: string; a: MeasureInfo; b?: MeasureInfo; pair?: MeasurePair }
/** `stale`: Die Anfrage gehört zu einem älteren Build, die Auswahl ist neu zu treffen. */
export interface MeasureResponse { ok: boolean; result?: MeasureResult; error?: string; stale?: boolean }

/** Wert einer Einstellung eines Skills: Zahl oder gewählter Eintrag. */
export type SkillValue = number | string;
/** Einstellung eines Skills, im Kopf der Skill-Datei erklärt (`var …`) und im Text als `{{name}}` eingesetzt. */
export interface SkillVar {
  name: string; label: string;
  /** Einheit hinter der Zahl, etwa „mm“ oder „°“, sonst leer. */
  unit: string;
  kind: 'number' | 'choice';
  value: SkillValue; default: SkillValue;
  /** Erlaubter Bereich (Zahlen). */
  min?: number; max?: number;
  /** Auswahl: Wert für den Agenten und Anzeige in der Oberfläche. */
  options?: { value: string; label: string }[];
}

/**
 * Wie ein Skill für ein Modell gilt (E55): `off` (Aus) der Agent sieht ihn nicht, `demand` (Bei Bedarf) er liegt im Projekt
 * und `AGENTS.md` nennt ihn mit Anlass, der Agent liest ihn, wenn das Thema aufkommt, `always` (Immer) der Agent befolgt ihn
 * bei jeder Änderung.
 */
export type SkillMode = 'off' | 'demand' | 'always';

/** Ein Skill (E17): Regelwerk für den Agenten, pro Modell einstellbar. */
export interface SkillInfo {
  id: string;
  /** Titel und Kurzbeschreibung für die Oberfläche, Themen aus den Zwischenüberschriften. */
  title: string; summary: string; topics: string[]; order: number;
  /** Überschrift im Panel, leer: ohne Kategorie (steht unter „Weitere“). */
  category: string;
  /** Bringt diese App mit (sonst liegt er nur im Projekt, etwa aus einer neueren App). */
  bundled: boolean;
  /** Stufe bei neuen Modellen (E46, E55), gilt für die ganze App, nicht für dieses Modell. */
  defaultMode: SkillMode;
  /** Stufe laut project.json. */
  mode: SkillMode;
  /** Kopie im Projekt (`.soma/skills/<id>.md`), null wenn keine da ist. */
  file: string | null;
  /** Die Kopie im Projekt weicht von der mitgelieferten Fassung (mit den eingestellten Werten) ab. */
  changed: boolean;
  /** Einstellungen mit ihren aktuellen Werten (nur bei mitgelieferten Skills). */
  vars: SkillVar[];
  /** Auffälligkeiten, nur gemeldet (E28). */
  problems: string[];
}
export interface SkillResult { ok: boolean; error?: string; warning?: string; backup?: string | null; skills: SkillInfo[] }
/** Was vermessen wird: der aktuelle Stand oder die Vorschau eines alten Stands. */
export type MeasureSource = 'live' | { preview: string };

/** Stand der Speicherung: was ist gesichert, was nicht (E21). */
export interface SaveState {
  zipPath: string | null;
  savedHead: string | null;
  head: string | null;
  /** Geänderte Dateien seit dem letzten Commit (ohne output/). */
  dirtyFiles: number;
  unsaved: boolean;
  hasRepo: boolean;
  /** Zeitpunkt des letzten Speicherns (ms seit 1970), null wenn noch nie gespeichert. */
  savedAt: number | null;
}
export interface SaveResult { cancelled: boolean; zipPath?: string; snapshot?: string | null; files?: number; bytes?: number; warnings?: string[]; error?: string }
export interface OpenResult { cancelled: boolean; opened?: boolean; error?: string }

/** `byApp`: Stand hat die App angelegt (Start, Snapshot, Wiederherstellen), sonst der Agent oder der Nutzer. */
export interface CommitInfo { hash: string; short: string; author: string; date: string; subject: string; byApp: boolean }
export interface GitLog { commits: CommitInfo[]; problems: string[]; head: string | null; dirtyFiles: number }
export interface PreviewResult { commit: CommitInfo | null; glb: ArrayBuffer; map: ModelMap; error?: string }
export interface RestoreResult { cancelled: boolean; commit?: string | null; safety?: string | null; error?: string }

export interface SomaApi {
  testMode: boolean;
  project: {
    current(): Promise<ProjectInfo>;
    create(): Promise<ProjectInfo>;
    list(): Promise<ProjectListEntry[]>;
    open(id: string): Promise<ProjectInfo>;
    onChanged(cb: (p: ProjectInfo) => void): void;
    saveState(): Promise<SaveState>;
    save(saveAs?: boolean): Promise<SaveResult>;
    openZip(): Promise<OpenResult>;
    onSaveState(cb: (s: SaveState) => void): void;
    /** Zeigt die ZIP im Dateimanager (noch nicht gespeichert: den Arbeitsordner). */
    reveal(): Promise<void>;
    /** Vorschaubild des offenen Modells für die Startseite (JPEG als Data-URL). */
    setThumb(dataUrl: string): Promise<void>;
    thumb(id: string): Promise<string | null>;
  };
  versions: {
    log(): Promise<GitLog>;
    preview(hash: string): Promise<PreviewResult>;
    restore(hash: string): Promise<RestoreResult>;
    onChanged(cb: () => void): void;
  };
  /** Nur im Testmodus (SOMA_TEST=1) vorhanden. */
  test?: { answers(a: unknown[]): Promise<void>; screenshot(file: string): Promise<{ width: number; height: number }> };
  build: {
    run(): Promise<void>;
    cancel(): Promise<void>;
    setAuto(on: boolean): Promise<void>;
    status(): Promise<BuildStatus>;
    onStatus(cb: (s: BuildStatus) => void): void;
    /** `part` null = alle Bauteile ohne Referenzen. */
    export(format: string, part: string | null): Promise<ExportResult>;
  };
  fs: {
    list(): Promise<FileNode[]>;
    readText(rel: string): Promise<string>;
    readBinary(rel: string): Promise<ArrayBuffer>;
    onChanged(cb: () => void): void;
    /** Kopiert gezogene Dateien nach inputs/. Vorhandenes wird nie überschrieben. */
    importFiles(files: File[]): Promise<ImportResult>;
    /** Neue, leere Datei oder neuer Ordner in `parent` ('' = Projektordner). Vorhandenes wird nie überschrieben. */
    create(parent: string, name: string, dir: boolean): Promise<FileOpResult>;
    /** Benennt eine Datei oder einen Ordner im selben Ordner um. Vorhandenes wird nie überschrieben. */
    rename(rel: string, name: string): Promise<FileOpResult>;
    /** Fragt nach und verschiebt dann in den Papierkorb. Endgültig gelöscht wird nie. */
    trash(rel: string): Promise<FileOpResult>;
    /** Zeigt die Datei im Explorer ('' = Projektordner). */
    reveal(rel: string): Promise<FileOpResult>;
    /** Öffnet die Datei mit dem Standardprogramm des Systems. Ausführbares lehnt der Hauptprozess ab. */
    openExternal(rel: string): Promise<FileOpResult>;
    /** Legt ein PNG der Markierung in .soma/feedback/ ab. Vorhandenes wird nie überschrieben. */
    saveFeedback(png: Uint8Array): Promise<FeedbackResult>;
    /**
     * Schreibt eine Datei aus dem Editor, nur wenn sie auf der Platte noch `base` entspricht (sonst Konflikt).
     * `force` schreibt trotzdem und sichert vorher die Fassung auf der Platte. `projectId` schützt vor Schreiben ins falsche Modell.
     */
    writeText(projectId: string, rel: string, text: string, base: string | null, force?: boolean): Promise<WriteResult>;
    /** Legt einen Text als Sicherung in den App-Daten ab und gibt den Pfad zurück. */
    backupText(projectId: string, rel: string, text: string): Promise<string>;
    /** Anfragen des Hauptprozesses an den Editor beim Beenden: ungespeicherte Dateien nennen, speichern oder verwerfen. */
    onEditorRequest(cb: (action: 'status' | 'save' | 'discard') => Promise<{ dirty?: string[]; ok?: boolean }>): void;
  };
  term: {
    create(opts?: { command?: string; title?: string }): Promise<number>;
    write(id: number, data: string): void;
    resize(id: number, cols: number, rows: number): void;
    kill(id: number): void;
    onData(cb: (id: number, data: string) => void): void;
    onExit(cb: (id: number, code: number) => void): void;
  };
  agents: { detect(): Promise<AgentInfo[]> };
  /** Exakte Messung über den Python-Dienst (E9, E24). */
  measure: { query(source: MeasureSource, req: MeasureRequest): Promise<MeasureResponse> };
  /** Skills des offenen Modells (E17): auflisten, Stufe wählen (E55). */
  skills: {
    list(): Promise<SkillInfo[]>;
    set(id: string, mode: SkillMode): Promise<SkillResult>;
    /** Einstellungen ändern, null setzt auf den Standard zurück. Die Kopie eines eingeschalteten Skills wird neu geschrieben. */
    configure(id: string, values: Record<string, SkillValue | null>): Promise<SkillResult>;
    /** Stufe für neue Modelle festlegen (für die ganze App, das offene Modell bleibt, wie es ist). */
    setDefault(id: string, mode: SkillMode): Promise<SkillResult>;
  };
  /** Nativer Dialog mit Knöpfen, liefert den Index. Der letzte Knopf gilt als Abbrechen. Im Test über `test.answers` beantwortbar. */
  dialog: { choose(o: { title: string; message: string; detail?: string; buttons: string[] }): Promise<number> };
  /** Öffnet eine Web-Adresse (http, https, mailto) im Browser des Systems. Andere Adressen lehnt der Hauptprozess ab. */
  openUrl(url: string): Promise<FileOpResult>;
}

declare global { interface Window { soma: SomaApi } }
