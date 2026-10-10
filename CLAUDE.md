# CLAUDE.md

Anweisungen für Claude Code bei der Entwicklung von SOMA (*Solid Object Modeling with Agents*). Nicht verwechseln mit `app/resources/template/CLAUDE.md`, der Vorlage für Nutzerprojekte.

## Worum es geht

Eine Desktop-App (Electron, TypeScript), in der ein Nutzer mit einem CLI-Agenten seiner Wahl (Claude Code, OpenCode …) 3D-Modelle in CadQuery entwirft. Wir bauen **keinen eigenen Harness**. Die App liefert Terminal, 3D-Viewer, das Projektformat `.soma` (eine ZIP mit Git, E79) und die Python-Hilfsbibliothek `soma`.

### Arbeitsdokumente (nur lokal, E88)

`PLAN.md`, `DECISIONS.md` und `IDEA.md` stehen in `.gitignore` (im Git-Verlauf bis `v0.5.0`). Fehlen sie, gibt es nichts nachzuziehen.

- `PLAN.md`: gültiger Plan, Phasenstand (Abschnitt 10), offene Punkte (Abschnitt 11). Geht vor `IDEA.md`.
- `DECISIONS.md`: Entscheidungslog. `(E12)` in Plan und Code verweist darauf. Neue Entscheidungen des Nutzers als neue Zeile ans Ende, alte Zeilen nie umschreiben.
- `IDEA.md`: Ursprungsidee, bleibt unverändert.

## Aufbau

Details in `app/README.md`.

**`app/`** Electron-App
- `src/main/` Hauptprozess. Projekte: `projects.ts` (Speichern, Öffnen, Verlauf, Export), `git.ts`, `zip.ts`, `workspace.ts`, `files.ts`, `watcher.ts`. Bauen und Anzeigen: `build.ts` (vorgewärmter Python-Prozess), `previews.ts`, `measure.ts`, `dxf.ts` (E80), `render.ts` + `bridge.ts` (`soma render`), `animations.ts`. Agent und Skills: `terminals.ts`, `agents.ts`, `skills.ts`, `skilllibrary.ts` (eigene Skills, E78). Umgebung: `packages.ts` (Projektumgebung, E67), `params.ts` (Parameter-Panel, E74). App: `settings.ts`, `storage.ts`, `about.ts` (E81), `help.ts` (E83), `dialogs.ts`.
- `src/preload/` einzige Brücke zum Renderer.
- `src/renderer/` Oberfläche, verdrahtet in `main.ts`. Viewer: `viewer.ts`, `viewcube.ts`, `tree.ts` (Strukturbaum, E82), Werkzeuge `sectiontool.ts`, `explodetool.ts`, `measuretool.ts`, `markup.ts`. Panels: `code.ts`, `pdfview.ts`, `dxfview.ts`, `markdown.ts`, `filetree.ts`, `versions.ts`, `terminals.ts`, `params.ts`, `skills.ts`, `help.ts`, `settings.ts` + `settingspages.ts`. Animation und Analyse: `animtool.ts`, `animpanel.ts`, `animdata.ts`, `overlay.ts`, `resulttool.ts`, `resultview.ts`, `analysispanel.ts`, `videoview.ts`. Render-Fenster: `render.ts`/`render.html`. Allgemein: `ui.ts`, `icons.ts`, `busy.ts`, `shortcuts.ts`, `style.css`.
- `src/shared/` `types.ts` (IPC-Vertrag), `settings.ts` (Vorgaben, Prüfung, Mausbelegungen, E81), `editable.ts`, `help.ts`, `skillname.ts`, `version.ts`.
- `resources/` `template/` (Vorlage für Nutzerprojekte inkl. `AGENTS.md`), `skills/` (mitgelieferte Skills, darunter `soma-app.md` als Nutzeranleitung für Hilfe und Agent, E83), `help/` (Bilder der Anleitung), `icon.*` (erzeugt mit `scripts/make-icon.py`).
- `test/` Testsuiten, CDP-Client, Screenshots.

**`python/soma/`** Hilfsbibliothek und CLI
- API: `add_part` (mit `group=`, `role=`), `param` (`params.py`, E74), `import_step`, `import_assembly`, Normteile in `fasteners.py` (Maßtabellen aus bd_warehouse in `data/fasteners/`).
- CLI: `soma build`, `export`, `glb`, `serve` (Messdienst, `measure.py`), `anim` (`anim.py`, `animrun.py`), `analyze` (`analysis.py`, FEM in `fem.py`, CalculiX über `ccx.py`, E84), `drawing` (`drawing.py`, `drawrun.py`, E76), `dxfview` (E80), `render` (nur über die App), `env` (`env.py`, `.soma/env` und `requirements.txt`, E67).
- `python/scripts/`: `setup_env.ps1` (Entwicklungsumgebung aus `python/requirements-base.txt`), `fetch_ccx.py` (CalculiX).

**`design/`** freigegebene Oberflächenentwürfe, im Browser öffnen, Pfeiltasten blättern
- `ui-entwurf-2.html` „Aufgeräumt“ (E62): Maßstab für Aufbau, Farben und Texte. Bild 6 ist das Parameter-Panel (E74).
- `strukturbaum-entwurf.html` (E82, umgesetzt): Strukturbaum, Reiter Analysis und Animation, Bericht der Analyse. Ersetzt in Entwurf 2 den Reiter Bauteile und den Umschalter oben links.
- `ui-entwurf.html` (E38): erster Entwurf, Farben und Bausteine gelten weiter, der Aufbau nicht mehr.

**`docs/`** `images/` für die README, `phase0-ergebnisse.md` (abgeschlossener Prototyp, Code im Git-Verlauf bis `v0.5.0`).

## Befehle

```
# einmalig: Python-Umgebung unter %LOCALAPPDATA%\soma-dev\venv mit soma, holt CalculiX nach venv/ccx
powershell -File python/scripts/setup_env.ps1

# App (in app/)
npm install
npm start                            # baut und startet
npm run typecheck
npm test                             # baut, dann alle Suiten parallel über test/run-all.mjs
node test/run-all.mjs smoke editor   # einzelne Suiten parallel, nach npm run build
npm run test:unit                    # ohne Build, prüft u. a. die Versionsnummer
npm run help:shots                   # Bilder der Nutzeranleitung neu erzeugen

# soma direkt
"$LOCALAPPDATA/soma-dev/venv/Scripts/soma.exe" build --project <ordner>
```

## Grundsätze für den Code

- **Robustheit:** Arbeitsordner und Agent sind nicht vertrauenswürdig. Jede Konvention braucht einen Rückfallweg, Fehler werden erkannt und erklärt statt abzustürzen.
- **Melden statt reparieren (E28):** keine automatischen Reparaturen und keine Reparier-Knöpfe ohne Rücksprache mit dem Nutzer.
- **Nichts still überschreiben oder löschen:** Was ersetzt wird, wandert in eine Sicherung (z. B. `workspace-backups/`).
- **Git in Nutzerprojekten nur vorwärts (E35):** neue Commits, kein Reset, Checkout, Rebase oder Branch. Schreibende Git-Aufrufe laufen über `GitRepo` nacheinander.
- **Renderer ohne Node-Zugriff:** alles über `preload.ts` und `src/shared/types.ts`. Dateizugriffe nur über `resolveInside`. Texte aus dem Projekt nie per `innerHTML`.
- **STEP-Namen nur ASCII** (`ascii_name`), Anzeigenamen stehen in `model.map.json`. `output/` zählt nicht als ungespeicherte Änderung (STEP-Dateien sind nicht byte-stabil).
- **Erst die volle Variante (E37):** im Prototyp erst vollständig und funktionierend, nicht früh optimieren.
- Kommentare erklären das Warum, im Stil des umgebenden Codes.

### Sprache (E73)

- **Englisch:** alles, was Nutzer oder Agent sehen: Oberfläche, Meldungen, Dialoge, Ausgaben und Fehler von `soma`, Docstrings der öffentlichen API, Skills samt Kopf, Übergabe-Notizen an den Agenten, `AGENTS.md` und `model.py` der Vorlage. Zahlen mit Dezimalpunkt.
- **Deutsch:** Doku, Code-Kommentare, Commit-Nachrichten, Testbeschreibungen.
- Was die App aus älteren Projekten wiedererkennt (Commit-Betreffe, Trailer), erkennt sie auch in der alten deutschen Form.
- `README.md` im Hauptordner ist die Startseite auf GitHub (E70): Englisch, schlicht und knapp, ohne Emojis, Bilder in `docs/images/`.

### Oberfläche

- Farben mit fester Bedeutung: Orange Aktion und Auswahl, Violett Vorschau, Grün/Gelb/Rot Status. Tokens oben in `style.css`.
- Symbole nur über `icons.ts`, keine Emoji.
- Menüeinträge, die Tests oder Kurzbefehle brauchen, stehen fest in `index.html`.

## Tests

- Nach Änderungen `npm run typecheck` und `npm test`. Die npm-Skripte bauen vorher, `node test/*.mjs` ohne Build testet veraltete `dist/`-Dateien.
- Die Suiten starten die echte App. Fenster bleiben unsichtbar (`SOMA_HIDDEN=1`), sonst blitzen sie beim Nutzer auf. Unsichtbare Fenster zeichnen nicht neu: für Screenshots `SMOKE_VISIBLE=offscreen`, bei Änderungen an der Oberfläche zusätzlich `SMOKE_SHOTS=1` und die Bilder in `app/test/shots/` ansehen.
- **Nutzeranleitung (E83):** Ändert sich die Oberfläche, `npm run help:shots` laufen lassen, die Bilder in `app/resources/help/` ansehen und `app/resources/skills/soma-app.md` nachziehen. Ausschnitte und Nummern stehen in `app/test/helpshots-spec.mjs`, die Bezeichnungen dort und unter den Bildern müssen gleich sein.
- Native Dialoge über `app.answers([...])` beantworten (`src/main/dialogs.ts`).
- Steuerung per eigenem CDP-Client (`test/cdp.mjs`). puppeteer-core geht mit Electron 44 nicht (`Input.dispatchMouseEvent` und `Page.captureScreenshot` hängen in unsichtbaren Fenstern).
- Lange Läufe in eine Datei umleiten statt durch `grep` zu pipen (Pufferung verdeckt Hänger).
- Getestet ist nur Windows. Das beim Berichten dazusagen.

## Entwicklung unter Windows

- **Netzlaufwerke:** Dort starten die sandboxed Prozesse von Electron nicht (schwarzes Fenster, `launch-failed` Code 18). Electron läuft deshalb aus einer lokalen Kopie (`app/scripts/electron-local.mjs`), nie `node_modules/electron/dist/electron.exe` direkt starten. Die Python-Umgebung liegt aus demselben Grund lokal.
- **Proxy:** Node-Downloads (Electron-Binary, dugite) brauchen `NODE_USE_ENV_PROXY=1`.
- **Ports:** Einzeltests ohne `SOMA_TEST_PORT` nutzen 9333, `run-all.mjs` holt freie Ports. Bei mehreren gleichzeitigen Sessions braucht jede eigene Ports.
- **Prozesse** nur gezielt beenden (Pfad des Repos oder `soma-dev` in der Kommandozeile), nie pauschal alle `electron.exe` oder `node.exe`.
- **Kurznamen** (`NAME~1`) in Temp-Pfaden: Pfade nicht als Strings vergleichen.

## Stolpersteine

- Dateien mit Backslash-Escapes (`\n` in Strings) nicht per Bash-Heredoc schreiben, die Escapes werden zu echten Zeilenumbrüchen. Edit- oder Write-Werkzeug nutzen.
- Python-Patches: `pathlib.Path.write_text(..., newline="\n")` statt `open(..., "w")` (sonst CRLF), jede Ersetzung mit `assert s.count(old) == 1` absichern.
- Zeilenenden: `.gitattributes` checkt alle Textdateien mit LF aus, auch bei `core.autocrlf=true`. Vorlage und Skills gehen so in Nutzerprojekte, Tests vergleichen mit `\n`.
- CadQuery fest pinnen: cadquery 2.8.0 braucht `cadquery-ocp<8` und `multimethod<2`.
- `dugite` bleibt im esbuild-Bundle extern (sein Git-Pfad ist relativ zum Paket).

## Doku und Arbeitsweise

- Der Nutzer spricht Deutsch. Ist eine Entscheidung wirklich seine, eine einzelne Frage stellen. Was ich ohne Rückfrage entscheide, kommt in `PLAN.md` unter „Noch nicht ausdrücklich bestätigt“.
- Nach einem Schritt nachziehen:
  - `PLAN.md`: Phasenstand, offene Punkte, Risiken.
  - `app/README.md`, wenn sich Befehle oder Aufbau ändern, und dieser Aufbau hier.
  - `CHANGELOG.md`: was der Nutzer merkt, kurz unter „Unveröffentlicht“ (E70).
  - `README.md` nur bei neuen großen Funktionen.
- Commits nur auf Wunsch, thematisch aufgeteilt (z. B. `python/`, `app/`, Doku), mit deutscher Nachricht.
- **Versionsnummer (E68):** Major.minor.bugfix, eine für App und `soma`, in `app/package.json` und `python/soma/__init__.py` (beide gleich ändern, `npm run test:unit` prüft es). Hochzählen nur auf Wunsch: bugfix für Fehlerbehebungen, minor für neue Funktionen, major für Brüche mit älteren Modellen oder Agenten-Anweisungen. Dabei wird „Unveröffentlicht“ im Changelog zur neuen Version mit Datum, dazu ein annotiertes Tag `vX.Y.Z`.
