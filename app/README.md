# CAD-IDE: Desktop-App (Arbeitsname)

Electron-App (TypeScript) für 3D-Modelle mit einem Coding-Agenten im Terminal. Plan: [../PLAN.md](../PLAN.md). Stand: **Phase 1, Schritte 1 und 2** (Gerüst, Git und ZIP).

## Voraussetzungen

- Node.js 22 oder neuer, Python 3.12 mit CadQuery (Basisumgebung), `cadide` darin installiert.
- Entwicklung: die Umgebung aus Phase 0 (`prototype/phase0/setup_env.ps1`) und darin `uv pip install -e ../python`. Die App findet sie unter `%LOCALAPPDATA%\cadide-phase0\venv-full` oder über `CADIDE_PYTHON`.
- Hinter einem Proxy lädt Node den Electron-Download nur mit `NODE_USE_ENV_PROXY=1`:
  `NODE_USE_ENV_PROXY=1 node node_modules/electron/install.js` (falls `npm install` das Binary nicht geholt hat).

## Starten und Testen

```
npm install
npm start            # baut und startet
npm run typecheck
npm run test:smoke      # echte App, unsichtbar: Projekt, Viewer, Terminal, Auto-Build, Fehlerfall (21 Prüfungen)
npm run test:versions   # Git-Verlauf, Speichern, Öffnen, Vorschau, Wiederherstellen, Störfälle (46 Prüfungen)
npm test                # beide
```

`SMOKE_VISIBLE=1` zeigt das Fenster. `SMOKE_VISIBLE=offscreen` zeigt es weit außerhalb des Bildschirms ohne Fokus, dann sind Screenshots (`test/versions.png`) frisch. Ein unsichtbares Fenster zeichnet nicht neu, seine Screenshots sind veraltet, die DOM-Prüfungen sind davon nicht betroffen.

**Windows und Netzlaufwerk:** Liegt `node_modules` auf einem Netzlaufwerk, starten die sandboxed Prozesse von Electron nicht (`launch-failed`, Code 18, schwarzes Fenster). `npm start` und der Test nutzen deshalb automatisch eine lokale Kopie von Electron unter `%LOCALAPPDATA%\cadide-dev\` (`scripts/electron-local.mjs`, einmalig rund 370 MB). Die App selbst darf auf dem Netzlaufwerk liegen. Eine installierte App muss lokal liegen, sonst zeigt sie eine Fehlermeldung.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `src/main/` | Hauptprozess: `projects.ts` (offenes Projekt, Speichern, Öffnen, Verlauf, Wiederherstellen), `git.ts` (mitgeliefertes Git über dugite), `zip.ts` (ZIP schreiben und sicher entpacken), `workspace.ts` (UUID-Arbeitsordner, Projektzustand doppelt, Projekt-Check nur melden), `build.ts` (Build als Einmal-Prozess mit Entprellung, Warteschlange, Zeitlimit), `dialogs.ts` (native Dialoge, im Test beantwortbar), `watcher.ts`, `terminals.ts` (node-pty, `cadide` und `git` im PATH), `files.ts` (Pfadschutz), `agents.ts` |
| `src/preload/` | Schmale, feste Schnittstelle zum Renderer (kein Node-Zugriff dort) |
| `src/renderer/` | Oberfläche: `viewer.ts` (three.js, Klick auf Code, Ansichten), `versions.ts` (Verlaufsleiste), `terminals.ts` (xterm.js, Tabs), `main.ts` (Baum, Status, Dateien, Speichern) |
| `src/shared/types.ts` | Typen des IPC-Vertrags |
| `resources/template/` | Vorlage für neue Projekte: `model.py`, `AGENTS.md`, `CLAUDE.md`, `NOTES.md`, `.gitignore` |
| `../python/cadide/` | Hilfsbibliothek und Kommandozeile (`cadide build`, `cadide export`, `cadide glb` für Vorschauen) |
| `test/` | `smoke.mjs`, `versions.mjs` (Ende-zu-Ende), `harness.mjs` (App starten und steuern), `cdp.mjs` (kleiner DevTools-Client, puppeteer scheitert an Electron 44) |

## Noch nicht enthalten (siehe PLAN.md, Abschnitt 10)

Projektumgebung mit `pip freeze`, Editor, Screenshot mit Markup, Auto-Start des Agenten, `cadide check`, Bündelung von Python und Installer, macOS und Linux (nur Windows getestet).
