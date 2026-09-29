# CLAUDE.md

Anweisungen für Claude Code bei der Entwicklung der CAD-IDE. Nicht verwechseln mit `app/resources/template/CLAUDE.md`, das ist die Vorlage für Nutzerprojekte.

## Worum es geht

Eine Desktop-App (Electron, TypeScript), in der ein Nutzer mit einem CLI-Agenten seiner Wahl (Claude Code, OpenCode …) 3D-Modelle in CadQuery entwirft. Wir bauen **keinen eigenen Harness**. Die App liefert Terminal, 3D-Viewer, Projektformat (ZIP mit Git) und die Hilfsbibliothek `cadide`.

- `PLAN.md` ist der gültige Plan mit Phasenstand (Abschnitt 10) und offenen Punkten (Abschnitt 11). Er geht vor `IDEA.md`.
- `DECISIONS.md` ist das Entscheidungslog. `(E12)` in Plan und Code verweist darauf. Neue Entscheidungen des Nutzers kommen als neue Zeile ans Ende, alte Zeilen werden nicht umgeschrieben.
- `IDEA.md` ist die Ursprungsidee und bleibt unverändert.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `app/` | Electron-App. `src/main/` Hauptprozess (`projects.ts` Speichern/Öffnen/Verlauf/Export, `git.ts`, `zip.ts`, `build.ts`, `workspace.ts`, `terminals.ts`, `files.ts`), `src/preload/`, `src/renderer/` (`main.ts` Verdrahtung, `viewer.ts`, `parts.ts`, `code.ts`, `filetree.ts`, `versions.ts`, `terminals.ts`, `ui.ts`, `icons.ts`), `src/shared/types.ts` (IPC-Vertrag), `resources/template/` (Vorlage für Nutzerprojekte inkl. `AGENTS.md`), `test/` |
| `design/ui-entwurf.html` | Freigegebener Oberflächenentwurf (E38), im Browser öffnen. Maßstab für Aufbau, Farben und Texte der Oberfläche |
| `python/cadide/` | Hilfsbibliothek und CLI: `add_part`, `cadide build`, `cadide export`, `cadide glb` |
| `prototype/phase0/` | Abgeschlossener technischer Prototyp mit `ERGEBNISSE.md`. Nur noch Referenz |

Details: `app/README.md`.

## Befehle

```
# einmalig: Python-Umgebung (lokal) und cadide darin
powershell -File prototype/phase0/setup_env.ps1
uv pip install --python "$LOCALAPPDATA/cadide-phase0/venv-full/Scripts/python.exe" -e python

# App (in app/)
npm install
npm start               # baut und startet
npm run typecheck
npm test                # baut, dann test:unit, test:smoke und test:versions (echte App, unsichtbares Fenster)

# cadide direkt
"$LOCALAPPDATA/cadide-phase0/venv-full/Scripts/cadide.exe" build --project <ordner>
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
- Testfenster bleiben unsichtbar (`CADIDE_HIDDEN=1`), sonst blitzen beim Nutzer Fenster auf. Unsichtbare Fenster zeichnen nicht neu: Für frische Screenshots `SMOKE_VISIBLE=offscreen`. Bei Änderungen an der Oberfläche `SMOKE_VISIBLE=offscreen` plus `SMOKE_SHOTS=1` und die Bilder in `app/test/shots/` ansehen.
- Oberfläche: Farben mit fester Bedeutung (Orange Aktion und Auswahl, Violett Vorschau, Grün/Gelb/Rot Status), Tokens stehen oben in `style.css`. Symbole nur über `icons.ts`, keine Emoji. Menüeinträge, die Tests oder Kurzbefehle brauchen, stehen fest in `index.html`.
- Native Dialoge im Test über `app.answers([...])` beantworten (`src/main/dialogs.ts`).
- Steuerung per eigenem CDP-Client (`test/cdp.mjs`). puppeteer-core funktioniert mit Electron 44 nicht, `Input.dispatchMouseEvent` und `Page.captureScreenshot` hängen in unsichtbaren Fenstern.
- Lange Läufe in eine Datei umleiten statt durch `grep` zu pipen (Pufferung verdeckt Hänger).
- Getestet ist bisher nur Windows. Das beim Berichten dazusagen.

## Entwicklung unter Windows

- **Netzlaufwerke:** Liegt das Repo auf einem Netzlaufwerk, starten die sandboxed Prozesse von Electron nicht (schwarzes Fenster, `launch-failed` Code 18). Electron läuft deshalb aus einer lokalen Kopie (`app/scripts/electron-local.mjs`). Nie `node_modules/electron/dist/electron.exe` direkt starten. Die Python-Umgebung liegt lokal unter `%LOCALAPPDATA%\cadide-phase0\venv-full`.
- **Proxy:** Node-Downloads (Electron-Binary, dugite) brauchen `NODE_USE_ENV_PROXY=1`.
- **Ports:** Feste Ports können von anderen Programmen belegt sein. Eigene Ports: 8791 (Phase 0), 9333 (Tests).
- Prozesse nur gezielt beenden (Pfad des Repos oder `cadide-dev` in der Kommandozeile), nie pauschal alle `electron.exe` oder `node.exe`.

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
