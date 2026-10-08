# CLAUDE.md

Anweisungen für Claude Code bei der Entwicklung von SOMA (*Solid Object Modeling with Agents*). Nicht verwechseln mit `app/resources/template/CLAUDE.md`, das ist die Vorlage für Nutzerprojekte.

## Worum es geht

Eine Desktop-App (Electron, TypeScript), in der ein Nutzer mit einem CLI-Agenten seiner Wahl (Claude Code, OpenCode …) 3D-Modelle in CadQuery entwirft. Wir bauen **keinen eigenen Harness**. Die App liefert Terminal, 3D-Viewer, Projektformat (ZIP mit Git) und die Hilfsbibliothek `soma`.

- `PLAN.md` ist der gültige Plan mit Phasenstand (Abschnitt 10) und offenen Punkten (Abschnitt 11). Er geht vor `IDEA.md`.
- `DECISIONS.md` ist das Entscheidungslog. `(E12)` in Plan und Code verweist darauf. Neue Entscheidungen des Nutzers kommen als neue Zeile ans Ende, alte Zeilen werden nicht umgeschrieben.
- `IDEA.md` ist die Ursprungsidee und bleibt unverändert.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `app/` | Electron-App. `src/main/` Hauptprozess (`projects.ts` Speichern/Öffnen/Verlauf/Export, `git.ts`, `zip.ts`, `build.ts` (mit vorgewärmtem Python-Prozess), `previews.ts`, `measure.ts`, `skills.ts`, `workspace.ts`, `terminals.ts`, `packages.ts` (Projektumgebung, E67), `files.ts`, `bridge.ts` Verbindung für `soma render`, `render.ts` Render-Fenster, `animations.ts`), `src/preload/`, `src/renderer/` (`main.ts` Verdrahtung, `viewer.ts`, `viewcube.ts`, `sectiontool.ts`, `explodetool.ts`, `busy.ts`, `skills.ts`, `markup.ts`, `measuretool.ts`, `parts.ts`, `code.ts`, `markdown.ts`, `filetree.ts`, `versions.ts`, `terminals.ts`, `ui.ts`, `icons.ts`, für Animation und Analyse `animtool.ts`, `animdata.ts`, `overlay.ts`, `resulttool.ts`, `resultview.ts`, `videoview.ts`, `render.ts`/`render.html` im Render-Fenster), `src/shared/types.ts` (IPC-Vertrag), `src/shared/editable.ts`, `resources/template/` (Vorlage für Nutzerprojekte inkl. `AGENTS.md`), `resources/skills/` (mitgelieferte Skills), `resources/icon.*` (App-Icon, erzeugt mit `scripts/make-icon.py`), `test/` |
| `design/ui-entwurf-2.html` | Freigegebener Oberflächenentwurf 2 „Aufgeräumt“ (E62), im Browser öffnen, Pfeiltasten blättern. Maßstab für Aufbau, Farben und Texte der Oberfläche. Bild 6 ist das geplante Parameter-Panel |
| `design/ui-entwurf.html` | Erster Oberflächenentwurf (E38), Farben und Bausteine gelten weiter, der Aufbau ist durch Entwurf 2 ersetzt |
| `design/icon-vorschlaege.html` | Die fünf Icon-Entwürfe, aus denen „Dialog“ gewählt wurde (E44). Nur noch Referenz |
| `python/soma/` | Hilfsbibliothek und CLI: `add_part` (mit `group=` und `role=`), `import_step`, `import_assembly`, `fasteners.py` (Normteile, Maßtabellen aus bd_warehouse in `data/fasteners/`), `soma build`, `soma export`, `soma glb`, `soma serve` (Messdienst, `measure.py`), `soma anim` (`anim.py`, `animrun.py`), `soma analyze` (`analysis.py`, FEM in `fem.py`), `soma render` (`render.py`, über die App), `soma env` (`env.py`, Projektumgebung `.soma/env` und `requirements.txt`, E67) |
| `prototype/phase0/` | Abgeschlossener technischer Prototyp mit `ERGEBNISSE.md`. Nur noch Referenz |

Details: `app/README.md`.

## Befehle

```
# einmalig: Python-Umgebung (lokal) und soma darin
powershell -File prototype/phase0/setup_env.ps1
uv pip install --python "$LOCALAPPDATA/cadide-phase0/venv-full/Scripts/python.exe" -e python

# App (in app/)
npm install
npm start               # baut und startet
npm run typecheck
npm test                # baut, dann alle Suiten (unit, smoke, versions, editor, measure, groups, section, explode, skills, fasteners, animation, fem, packages) parallel über test/run-all.mjs (echte App, unsichtbares Fenster)
node test/run-all.mjs smoke editor   # einzelne Suiten parallel, nach npm run build

# soma direkt
"$LOCALAPPDATA/cadide-phase0/venv-full/Scripts/soma.exe" build --project <ordner>
```

## Grundsätze für den Code

- **Robustheit (PLAN.md Abschnitt 9):** Der Arbeitsordner und der Agent sind nicht vertrauenswürdig. Jede Konvention braucht einen Rückfallweg, Fehler werden erkannt und erklärt statt abzustürzen.
- **Melden statt reparieren (E28):** Keine automatischen Reparaturen und keine Reparier-Knöpfe ohne Rücksprache mit dem Nutzer.
- **Nichts still überschreiben oder löschen:** Was ersetzt wird, wandert in eine Sicherung (z. B. `workspace-backups/`).
- **Git in Nutzerprojekten nur vorwärts (E35):** neue Commits, kein Reset, Checkout, Rebase oder Branch. Schreibende Git-Aufrufe der App laufen über `GitRepo` nacheinander.
- **Renderer ohne Node-Zugriff:** Alles geht über `preload.ts` und die Typen in `src/shared/types.ts`. Dateizugriffe nur über `resolveInside`. Texte aus dem Projekt nie per `innerHTML`.
- **STEP-Namen nur ASCII** (`ascii_name`), Anzeigenamen stehen in `model.map.json`. `output/` zählt nicht als ungespeicherte Änderung, weil STEP-Dateien nicht byte-stabil sind.
- **Sprache:** Oberfläche, Doku, Code-Kommentare und Commit-Nachrichten auf Deutsch. `AGENTS.md` und `model.py` der Vorlage auf Englisch (Agenten folgen englischen Anweisungen zuverlässiger).
- Kommentare erklären das Warum, im Stil des umgebenden Codes.

## Tests

- Nach Änderungen `npm run typecheck` und `npm test`. Die npm-Skripte bauen vorher. `node test/*.mjs` ohne Build testet veraltete `dist/`-Dateien.
- Testfenster bleiben unsichtbar (`SOMA_HIDDEN=1`), sonst blitzen beim Nutzer Fenster auf. Unsichtbare Fenster zeichnen nicht neu: Für frische Screenshots `SMOKE_VISIBLE=offscreen`. Bei Änderungen an der Oberfläche `SMOKE_VISIBLE=offscreen` plus `SMOKE_SHOTS=1` und die Bilder in `app/test/shots/` ansehen.
- Oberfläche: Farben mit fester Bedeutung (Orange Aktion und Auswahl, Violett Vorschau, Grün/Gelb/Rot Status), Tokens stehen oben in `style.css`. Symbole nur über `icons.ts`, keine Emoji. Menüeinträge, die Tests oder Kurzbefehle brauchen, stehen fest in `index.html`.
- Native Dialoge im Test über `app.answers([...])` beantworten (`src/main/dialogs.ts`).
- Steuerung per eigenem CDP-Client (`test/cdp.mjs`). puppeteer-core funktioniert mit Electron 44 nicht, `Input.dispatchMouseEvent` und `Page.captureScreenshot` hängen in unsichtbaren Fenstern.
- Lange Läufe in eine Datei umleiten statt durch `grep` zu pipen (Pufferung verdeckt Hänger).
- Getestet ist bisher nur Windows. Das beim Berichten dazusagen.

## Entwicklung unter Windows

- **Netzlaufwerke:** Liegt das Repo auf einem Netzlaufwerk, starten die sandboxed Prozesse von Electron nicht (schwarzes Fenster, `launch-failed` Code 18). Electron läuft deshalb aus einer lokalen Kopie (`app/scripts/electron-local.mjs`). Nie `node_modules/electron/dist/electron.exe` direkt starten. Die Python-Umgebung liegt lokal unter `%LOCALAPPDATA%\cadide-phase0\venv-full`.
- **Proxy:** Node-Downloads (Electron-Binary, dugite) brauchen `NODE_USE_ENV_PROXY=1`.
- **Ports:** Feste Ports können von anderen Programmen belegt sein. Eigene Ports: 8791 (Phase 0), 9333 (Tests einzeln ohne `SOMA_TEST_PORT`; `run-all.mjs` holt freie Ports). Laufen mehrere Sessions gleichzeitig, braucht jede eigene Ports, und Testprozesse nur die eigenen beenden.
- Prozesse nur gezielt beenden (Pfad des Repos oder `soma-dev` in der Kommandozeile), nie pauschal alle `electron.exe` oder `node.exe`.

## Stolpersteine beim Bearbeiten

- Dateien mit Backslash-Escapes (`\n` in Strings) nicht per Bash-Heredoc schreiben: Die Escapes werden unterwegs zu echten Zeilenumbrüchen. Edit- oder Write-Werkzeug nutzen.
- Python-Patches: `pathlib.Path.write_text(..., newline="\n")` statt `open(..., "w")` (sonst CRLF), und jede Ersetzung mit `assert s.count(old) == 1` absichern.
- CadQuery-Versionen fest pinnen: cadquery 2.8.0 braucht `cadquery-ocp<8` und `multimethod<2`, ungepinnt kommt Inkompatibles.
- `dugite` bleibt im esbuild-Bundle extern (sein Git-Pfad ist relativ zum Paket).
- Windows-Kurznamen (`NAME~1`) in Temp-Pfaden: Pfade nicht als Strings vergleichen.

## Doku und Arbeitsweise

- Nach einem Schritt `PLAN.md` nachziehen (Phasenstand, offene Punkte, Risiken) und `app/README.md`, wenn sich Befehle oder Aufbau ändern.
- Entscheidungen, die ich ohne Rückfrage treffe, stehen in `PLAN.md` unter „Noch nicht ausdrücklich bestätigt".
- Der Nutzer spricht Deutsch. Ist eine Entscheidung wirklich seine, eine einzelne Frage stellen.
- Im Prototyp erst die volle, funktionierende Variante, nicht früh optimieren (E37).
- Commits nur auf Wunsch, thematisch aufgeteilt (z. B. `python/`, `app/`, Doku), mit deutscher Nachricht.
- **Versionsnummer (E68):** Major.minor.bugfix, eine für App und `soma`, steht in `app/package.json` und `python/soma/__init__.py` (beide gleich ändern, `npm run test:unit` prüft es). Hochzählen nur auf Wunsch des Nutzers: bugfix für Fehlerbehebungen, minor für neue Funktionen, major für Änderungen, die ältere Modelle oder Agenten-Anweisungen brechen.
