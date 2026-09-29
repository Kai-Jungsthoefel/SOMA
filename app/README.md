# CAD-IDE: Desktop-App (Arbeitsname)

Electron-App (TypeScript) für 3D-Modelle mit einem Coding-Agenten im Terminal. Plan: [../PLAN.md](../PLAN.md). Dies ist der Stand von **Phase 1, Schritt 1** (lauffähiges Gerüst).

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
npm run test:smoke   # startet die echte App unsichtbar und prüft 21 Punkte (SMOKE_VISIBLE=1 zeigt das Fenster und macht einen Screenshot)
```

**Windows und Netzlaufwerk:** Liegt `node_modules` auf einem Netzlaufwerk, starten die sandboxed Prozesse von Electron nicht (`launch-failed`, Code 18, schwarzes Fenster). `npm start` und der Test nutzen deshalb automatisch eine lokale Kopie von Electron unter `%LOCALAPPDATA%\cadide-dev\` (`scripts/electron-local.mjs`, einmalig rund 370 MB). Die App selbst darf auf dem Netzlaufwerk liegen. Eine installierte App muss lokal liegen, sonst zeigt sie eine Fehlermeldung.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `src/main/` | Hauptprozess: `workspace.ts` (UUID-Arbeitsordner, Projektzustand doppelt, Projekt-Check nur melden), `build.ts` (Build als Einmal-Prozess mit Entprellung, Warteschlange, Zeitlimit), `watcher.ts`, `terminals.ts` (node-pty, `cadide` im PATH), `files.ts` (Pfadschutz), `agents.ts` |
| `src/preload/` | Schmale, feste Schnittstelle zum Renderer (kein Node-Zugriff dort) |
| `src/renderer/` | Oberfläche: `viewer.ts` (three.js, Klick auf Code, Ansichten), `terminals.ts` (xterm.js, Tabs), `main.ts` (Baum, Status, Dateien) |
| `src/shared/types.ts` | Typen des IPC-Vertrags |
| `resources/template/` | Vorlage für neue Projekte: `model.py`, `AGENTS.md`, `CLAUDE.md`, `NOTES.md`, `.gitignore` |
| `../python/cadide/` | Hilfsbibliothek und Kommandozeile (`cadide build`, `cadide export`) |
| `test/` | `smoke.mjs` (Ende-zu-Ende), `cdp.mjs` (kleiner DevTools-Client, puppeteer scheitert an Electron 44) |

## Noch nicht enthalten (siehe PLAN.md, Abschnitt 10)

ZIP speichern und öffnen, Git, Projektumgebung mit `pip freeze`, Editor, Screenshot mit Markup, Auto-Start des Agenten, `cadide check`, Bündelung von Python und Installer, macOS und Linux (nur Windows getestet).
