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
export interface BuildStatus { state: BuildState; result?: BuildResult; startedAt?: number; queued?: boolean; reason?: string }

export interface FileNode { name: string; path: string; dir: boolean; children?: FileNode[] }

export interface AgentInfo { id: string; label: string; command: string; found: boolean }

export interface PartMap {
  id: string; name: string; step_name: string; role: string;
  file?: string; line?: number; end_line?: number; volume?: number;
}
export interface ModelMap { version: number; parts: PartMap[] }

export interface CadideApi {
  testMode: boolean;
  project: {
    current(): Promise<ProjectInfo>;
    create(): Promise<ProjectInfo>;
    list(): Promise<ProjectListEntry[]>;
    open(id: string): Promise<ProjectInfo>;
    onChanged(cb: (p: ProjectInfo) => void): void;
  };
  build: {
    run(): Promise<void>;
    cancel(): Promise<void>;
    setAuto(on: boolean): Promise<void>;
    status(): Promise<BuildStatus>;
    onStatus(cb: (s: BuildStatus) => void): void;
  };
  fs: {
    list(): Promise<FileNode[]>;
    readText(rel: string): Promise<string>;
    readBinary(rel: string): Promise<ArrayBuffer>;
    onChanged(cb: () => void): void;
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
}

declare global { interface Window { cadide: CadideApi } }
