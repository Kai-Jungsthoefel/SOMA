# SOMA: Desktop-App

Electron-App (TypeScript) für 3D-Modelle mit einem Coding-Agenten im Terminal. Plan: [../PLAN.md](../PLAN.md). Stand: **Phase 1, Schritte 1 bis 5** (Gerüst, Git und ZIP, Oberfläche nach dem Entwurf in [../design/ui-entwurf.html](../design/ui-entwurf.html), Markierung, Editor), dazu Messen.

## Voraussetzungen

- Node.js 22 oder neuer, Python 3.12 mit CadQuery (Basisumgebung), `soma` darin installiert.
- Entwicklung: die Umgebung aus Phase 0 (`prototype/phase0/setup_env.ps1`) und darin `uv pip install -e ../python`. Die App findet sie unter `%LOCALAPPDATA%\cadide-phase0\venv-full` oder über `SOMA_PYTHON`.
- Hinter einem Proxy lädt Node den Electron-Download nur mit `NODE_USE_ENV_PROXY=1`:
  `NODE_USE_ENV_PROXY=1 node node_modules/electron/install.js` (falls `npm install` das Binary nicht geholt hat).

## Starten und Testen

```
npm install
npm start            # baut und startet
npm run typecheck
npm run test:unit       # Bausteine ohne Electron: Dateien nach inputs/, Markierung nach .soma/feedback/, Pfadschutz, Schreiben aus dem Editor mit Konfliktprüfung (15 Prüfungen)
npm run test:smoke      # echte App, unsichtbar: Projekt, Viewer, Auswahl, Panels, Terminal, Übergabe an den Agenten, Markierung (Zeichnen, Auswählen, Verschieben, Drehen, Skalieren, Farben), Auto-Build, Fehlerfall, Export, Ansichtswürfel und Drehpunkt (61 Prüfungen)
npm run test:versions   # Git-Verlauf, Speichern, Öffnen, Vorschau (auch markiert), Wiederherstellen, Störfälle (53 Prüfungen)
npm run test:editor     # Editor: Höhe und Scrollen, Speichern nur auf Wunsch mit genau einem Build (nur bei Python und inputs/), Änderungen des Agenten, Konflikte mit Sicherung, Nur lesen, CRLF, Rückfragen bei Modellwechsel und Reiter schließen (29 Prüfungen)
npm run test:measure    # Messen: Fläche, Kante, Punkt, Abstand paralleler Ebenen, zweier Bohrungen, zweier Punkte, Punkt zur Ebene, Verdecktes, neuer Build, Vorschau (21 Prüfungen)
npm run test:groups     # Gruppen: eigene und importierte (STEP-Baugruppe), Baum, Aus-/Einblenden und Transparenz je Gruppe, Klick durch transparente Teile, Ausgabe-STEP (17 Prüfungen)
npm test                # alle sechs
```

`SMOKE_VISIBLE=1` zeigt das Fenster. `SMOKE_VISIBLE=offscreen` zeigt es weit außerhalb des Bildschirms ohne Fokus, dann sind Screenshots (`test/versions.png`) frisch. Ein unsichtbares Fenster zeichnet nicht neu, seine Screenshots sind veraltet, die DOM-Prüfungen sind davon nicht betroffen. Mit `SMOKE_VISIBLE=offscreen` und zusätzlich `SMOKE_SHOTS=1` legt der Smoke-Test Bilder der wichtigsten Zustände in `test/shots/` ab (Arbeitsbereich, Code, Dateien, Fehler, Startseite, Agent eingeklappt, Markieren mit Textfeld, leerer Fläche, Auswahl und Farbmenü, dazu das gespeicherte Bild, wie der Agent es sieht), zum Prüfen von Änderungen an der Oberfläche.

**Windows und Netzlaufwerk:** Liegt `node_modules` auf einem Netzlaufwerk, starten die sandboxed Prozesse von Electron nicht (`launch-failed`, Code 18, schwarzes Fenster). `npm start` und der Test nutzen deshalb automatisch eine lokale Kopie von Electron unter `%LOCALAPPDATA%\soma-dev\` (`scripts/electron-local.mjs`, einmalig rund 370 MB). Die App selbst darf auf dem Netzlaufwerk liegen. Eine installierte App muss lokal liegen, sonst zeigt sie eine Fehlermeldung.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `src/main/` | Hauptprozess: `projects.ts` (offenes Projekt, Speichern, Öffnen, Verlauf, Wiederherstellen), `git.ts` (mitgeliefertes Git über dugite), `zip.ts` (ZIP schreiben und sicher entpacken), `workspace.ts` (UUID-Arbeitsordner, Projektzustand doppelt, Projekt-Check nur melden), `build.ts` (Build als Einmal-Prozess mit Entprellung, Warteschlange, Zeitlimit), `measure.ts` (langlebiger Python-Messdienst, `soma serve`), `dialogs.ts` (native Dialoge, im Test beantwortbar), `watcher.ts`, `terminals.ts` (node-pty, `soma` und `git` im PATH), `files.ts` (Pfadschutz, Dateien nach `inputs/`, Markierungen nach `.soma/feedback/`, Schreiben aus dem Editor mit Konfliktprüfung und Sicherung), `agents.ts` |
| `src/preload/` | Schmale, feste Schnittstelle zum Renderer (kein Node-Zugriff dort) |
| `src/renderer/` | Oberfläche: `main.ts` (Verdrahtung: Kopfzeile, Menüs, Auswahl, Übergabe an den Agenten, Startseite), `viewer.ts` (three.js, Klick auf Code, Ansichten, Drehpunkt, Vorschaubild, Bild für die Markierung), `viewcube.ts` (Ansichtswürfel in 3D), `markup.ts` (Zeichenfläche der Markierung, Formen als bearbeitbare Objekte), `measuretool.ts` (Messen: Ablauf, Karte, Text für den Agenten), `parts.ts` (Bauteilkarte als Baum mit Gruppen, Auge und Transparenz), `code.ts` (Code-Panel mit Editor: CodeMirror 6, Speichern auf Wunsch, Abgleich mit Änderungen des Agenten, Konflikte), `filetree.ts` (Dateien-Panel), `versions.ts` (Verlaufsleiste), `terminals.ts` (xterm.js, Tabs, Einklappen, Einfügen), `ui.ts` (Menüs, Meldungen, Helfer), `icons.ts` (Symbole), `style.css` (Farben mit fester Bedeutung, siehe Kopf der Datei) |
| `src/shared/` | `types.ts` Typen des IPC-Vertrags, `editable.ts` welche Dateien der Editor nur zeigt (gilt in Renderer und Hauptprozess) |
| `resources/template/` | Vorlage für neue Projekte: `model.py`, `AGENTS.md`, `CLAUDE.md`, `NOTES.md`, `.gitignore` |
| `../python/soma/` | Hilfsbibliothek und Kommandozeile (`soma build`, `soma export`, `soma glb` für Vorschauen, `soma serve` Messdienst, `measure.py` exakte Werte mit OCC) |
| `test/` | `smoke.mjs`, `versions.mjs` (Ende-zu-Ende), `unit.mjs` (ohne Electron), `harness.mjs` (App starten und steuern), `cdp.mjs` (kleiner DevTools-Client, puppeteer scheitert an Electron 44) |

## Noch nicht enthalten (siehe PLAN.md, Abschnitt 10)

Projektumgebung mit `pip freeze`, Schnitt, Skills (die Knöpfe stehen schon ausgegraut da), Auto-Start des Agenten, `soma check`, Bündelung von Python und Installer, macOS und Linux (nur Windows getestet).
