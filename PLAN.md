# Plan: SOMA (CAD mit KI-Agenten)

> Stand: 2026-09-30 · Status: **Phase 0 abgeschlossen** ([Ergebnisse](prototype/phase0/ERGEBNISSE.md)), **Phase 1 läuft** (Schritte 1 bis 5 erledigt, Messen vorgezogen, siehe Abschnitt 10 und [app/README.md](app/README.md))
> Ursprung: [IDEA.md](IDEA.md) · Begründungen und Historie: [DECISIONS.md](DECISIONS.md)
> Zahlen in Klammern, z. B. (E12), verweisen auf Entscheidungen im Log.

## 1. Vision

Eine Desktop-App, in der ein Nutzer zusammen mit einem KI-Coding-Agenten seiner Wahl (Claude Code, OpenCode, …) 3D-Modelle entwirft. Technisch ist sie eine IDE mit Terminal, Editor und einem eingebauten 3D-Viewer. Sie fühlt sich aber an wie „ein 3D-Modell erstellen und speichern", nicht wie „ein Coding-Projekt starten". Ein Modell ist eine ZIP-Datei, die man frei verschieben kann.

**Abgrenzung zu VS Code:** Modell-Workflow (ZIP, Versions-Schieber), integrierter STEP-Viewer mit Klick auf Code, Screenshot mit Markup als Rückmeldung an den Agenten, feste Projektstruktur, Skills für 3D-Druck und Toleranzen.

**Zielgruppe:** Nicht-Programmierer, die einen eigenen CLI-Agenten mitbringen (E3, E4). **Ziel:** Open Source (E30). **Plattformen:** Windows, macOS, Linux von Anfang an (E2).

## 2. Grundsätze

1. **Kein eigener Harness** (E29). Agenten, Berechtigungen und Schutz vor dem Agenten liegen bei Nutzer und Agent, nicht bei uns. Keine Sandbox.
2. **Agentenunabhängig.** Wir setzen nur auf Dateien, Text und Kommandozeile, nicht auf Eigenheiten einzelner Agenten. Tiefere Integration (MCP) kommt später (E11).
3. **Der Code ist die Wahrheit.** Änderungen am Modell laufen über das Skript. Die App schreibt den Modellcode nicht selbst, sondern übergibt Aufträge an den Agenten (E11, E34).
4. **Eine getestete Umgebung.** Python, CadQuery und Git werden mitgeliefert, kein Bring-your-own (E31, E32).
5. **Robust gegen Abweichungen des Agenten**, siehe Abschnitt 9. Dieser Grundsatz gilt für alle anderen.

## 3. Architektur

```
+---------------------- Electron-App (TypeScript) ----------------------+
| Oberfläche: Panels (Dateien, Code) | 3D-Viewer / Sketch | Agent-Tabs  |
| Hauptprozess: Projekte, ZIP, Git, Dateiüberwachung, Prozessverwaltung |
+-----------+-------------------------------+---------------------------+
            |                               |
   Terminals (xterm.js + node-pty)   Python-Dienst pro Projekt (langlebig)
   Shell im Projektordner,           Modell im Speicher, Build, Mesher,
   Projektumgebung im PATH,          Messungen (OCP/OpenCascade)
   mitgeliefertes git                       |
            |                               |
      CLI-Agent (Claude Code, …)     Paket `soma` (Basisumgebung)
      nutzt `soma build|check|export`  Hilfsbibliothek + CLI
```

- **Desktop:** Electron, TypeScript (E23). Editor: CodeMirror 6 (Phase 1, Schritt 5).
- **Python-Dienst:** Pro Projekt ein langlebiger Prozess für die App (schnelle Messungen, Modell im Speicher). Der Build-Befehl des Agenten läuft zusätzlich als eigenständiger Einmal-Prozess und funktioniert auch ohne App (E24). **Umgesetzt für das Messen** (`soma serve`), gebaut wird weiter im Einmal-Prozess.
- **CAD-Framework:** **CadQuery**, fest (E12). OpenSCAD ist ausgeschlossen (kein STEP, kein B-Rep).
- **Viewer:** three.js zeigt ein GLB, das nach jedem Build aus der STEP-Datei erzeugt wird (Bauteilnamen, Farben, Flächen- und Kanten-IDs). Exakte Messwerte (Radius, Flächenabstand) fragt die App beim Python-Dienst ab. Es gibt keinen zweiten CAD-Kern im Frontend (E9).

## 4. Projektformat

**Ein Projekt ist eine ZIP-Datei.** Die App arbeitet in einem Arbeitsordner (E21):

- Jedes Projekt hat eine feste **UUID**. Der Arbeitsordner liegt immer unter `<App-Daten>/workspaces/<uuid>/`, nicht im OS-Temp.
- Neue Projekte starten im Arbeitsordner ohne ZIP, bis der Nutzer zum ersten Mal speichert.
- **Speichern nur ausdrücklich**, kein Autosave in die ZIP. Dazu Absturz-Wiederherstellung.
- **Öffnen:** Existiert der Arbeitsordner nicht, wird die ZIP entpackt. Existiert er mit ungespeicherten Änderungen oder Abweichungen, **fragt die App nach** (wiederherstellen oder ZIP laden).
- Der stabile Pfad hält die **Agenten-Chats auf demselben Rechner** erhalten. Auf einem anderen Rechner gehen sie verloren, das ist bewusst akzeptiert (E5).

**Ordnerstruktur (E26)**

```
<projekt>/
├── AGENTS.md          app-verwaltet: Regeln, Konventionen, Skill-Liste, Git-Regeln, Befehle
├── CLAUDE.md          Verweis auf AGENTS.md (für Claude Code)
├── NOTES.md           Nutzer/Agent, wird nie überschrieben (Arbeitsname)
├── requirements.txt   gepinnte Pakete, von der App aus `pip freeze` gepflegt
├── model.py           fester Einstiegspunkt
├── parts/             Bauteile (optional)
├── inputs/            mitgebrachte Dateien (z. B. STEP), Drag-and-drop im Dateien-Tab
├── output/
│   └── model.step     Hauptergebnis mit allen Bauteilen, benannt, farbig
├── exports/           Einzelexporte (Ort noch nicht festgelegt)
├── .soma/
│   ├── project.json   ID, App-/Framework-Version, api_version, aktive Skills, Hauptdatei
│   ├── skills/        aktivierte Skills als Markdown
│   ├── feedback/      Screenshots und Skizzen (nicht in Git)
│   ├── model.map.json und GLB-Cache (nicht in Git)
└── .git/  .gitignore
```

Einfacher Fall: alles steht in `model.py`. Bei wachsender Komplexität lagert der Agent Bauteile nach `parts/` aus (E6).

**Git (E7, E8, E35)**

- Jedes Projekt bekommt ein Git-Repo, das in der ZIP mitwandert. Das Git-Binary wird mitgeliefert (E31).
- Der **Agent committet selbst** nach sinnvollen Iterationen (Anweisung in `AGENTS.md`). Beim Speichern legt die App verbliebene Änderungen als **Auto-Snapshot** an.
- **Getrackt:** Skripte, `inputs/`, `output/model.step`, `requirements.txt`, `project.json`, `skills/`. **Nicht getrackt:** GLB-Cache, Mapping, `feedback/`.
- **Umsetzung und Befund:** Die App nutzt das mitgelieferte Git (dugite, Git 2.53, rund 115 MB) und stellt es auch den Terminals vorn im PATH bereit. **STEP-Dateien sind nicht byte-stabil** (jeder Build ändert den Zeitstempel, manchmal die Reihenfolge einzelner Zeilen). Deshalb zählt `output/` nicht als ungespeicherte Änderung, wird aber mitcommittet, damit alte Stände als Vorschau anzeigbar bleiben. Der Startcommit entsteht nach einem ersten Build und enthält bereits eine STEP.
- **Versions-Schieber:** Leiste unter dem Viewer, Commits als Punkte, letzter Punkt ist der aktuelle Arbeitsstand. Alte Stände sind **Vorschau** (STEP per `git show`, Arbeitsordner bleibt unberührt). Der Knopf **„Stand wiederherstellen"** kopiert die Dateien und legt einen **neuen Commit** an. Es gibt keinen Checkout oder Reset und keine Branches.

**Projektzustand (E27):** ID und Einstellungen liegen doppelt: in `.soma/project.json` (ZIP) und als Kopie in den App-Daten. Bei Verlust dient die jeweils andere Quelle als Rückfall.

## 5. Hilfsbibliothek und Befehle (`soma`)

Das Paket `soma` liegt in der mitgelieferten **Basisumgebung**, nicht im Projekt. Neue App-Versionen bringen es mit, alte Projekte profitieren von Fixes. `api_version` in `project.json` sichert die Abwärtskompatibilität (E36). Paket und Befehl heißen `soma` (E43).

| Baustein | Aufgabe |
|---|---|
| `add_part("Deckel", obj, role=...)` | Bauteil registrieren (verbindlich, E10). Merkt sich Datei und Zeile, schreibt Namen und Farbe in den STEP-Baum, Positionen und Anzeigename in `model.map.json`. **Namen in der STEP nur ASCII** (Umlaute werden umgeschrieben, sonst zerstört der Export sie), Namen müssen eindeutig sein. Rolle `reference` ist eine Markierung (halbtransparent, eigener Ast, nicht in `--all`) |
| `soma build` | Baut STEP, GLB und Mapping in einem Lauf. Gemeinsam für App und Agent. Führt vorab einen kurzen Check aus und gibt Warnungen mit aus (E20) |
| `soma check` | Prüft die Projektstruktur und **meldet nur**, mit konkreten Handlungshinweisen, auch maschinenlesbar. Kein `--fix`. Der Agent repariert nach eigenem Ermessen (E28) |
| `soma export <Bauteil\|--all> --format …` | Einzelexport auf Basis der registrierten Bauteile, auch per Kontextmenü im Tree. Formate (in Phase 0 geprüft): STEP, STL, 3MF, AMF, BREP, IGES, OBJ, VRML, GLB/GLTF. 2D: DXF (Schnitt), SVG (Projektion) (E34) |

**Bauen (E20):** Auto-Build bei Änderung von `model.py` und `parts/` (Hintergrund, Debounce, abbrechbar). Er ist **abschaltbar**, weil große Modelle sonst die App bremsen. Dann baut der Nutzer per Knopf oder der Agent per Befehl.

**Pakete (E25):** Die Basisumgebung bleibt unverändert. Jedes Projekt hat eine eigene Umgebung im Arbeitsordner (nicht in der ZIP), die die Basis sieht. Jedes Terminal startet mit **aktivierter Projektumgebung im PATH**, der Agent nutzt normales `pip`. Die App liest die Pakete per `pip freeze` aus und pflegt `requirements.txt`. Auf einem anderen Rechner wird die Umgebung daraus neu aufgebaut.

## 6. Agenten-Anbindung

- **Terminal (E19):** Freies Terminal mit mehreren Tabs im Projektordner. Startbuttons für erkannte Agenten. Der zuletzt benutzte Agent startet beim Öffnen automatisch, **ohne Resume**. Der Nutzer installiert den Agenten selbst, die App hilft mit Erkennung und Hinweisen (E4).
- **`AGENTS.md` (E18):** Ganz app-verwaltet, Notizen stehen getrennt in `NOTES.md`. Beim Öffnen eines Projekts mit älterer Regelversion wird sie erneuert, dem Nutzer angezeigt und als Commit gesichert (E36). Der Verweis auf die Notizen steht ganz oben.
- **Skills (E17):** Markdown-Regeln (z. B. 3D-Druck, Toleranzen, Gehäusebau), pro Projekt aktivierbar. Aktivierte Skills liegen in `.soma/skills/` und stehen mit vollem Pfad in `AGENTS.md`. Zunächst nur mitgelieferte, eigene Nutzer-Skills später.
- **Rückmeldung an den Agenten (E11):** Markierungen (Viewer-Bild oder leere Fläche mit Zeichnung) landen als PNG in `.soma/feedback/`, Auswahlen (Bauteilname, Datei, Zeilen, Fläche) und Build-Fehler gehen als Text. Die App fügt Pfad oder Text in die Eingabezeile des Terminals ein, der Nutzer schickt selbst ab. Später kommt ein MCP-Server der App dazu.

## 7. Oberfläche und Viewer

**Layout (E15, E38, Entwurf in [design/ui-entwurf.html](design/ui-entwurf.html)):** Das Modell ist die Hauptsache, der Viewer bekommt die größte Fläche. Die **Bauteilliste schwebt als Karte** oben links im Viewer, daneben die Werkzeuge, rechts der Ansichtswürfel, unten links die Auswahl mit Codeausschnitt. Eine schmale **Leiste links** klappt die Panels *Dateien* und *Code* aus (immer nur eins). Rechts der **Agent-Bereich** mit Tabs, einklappbar, darunter die **Übergabeleiste** (Auswahl, Markierung, Build-Fehler in die Eingabe des Agenten). Die **Kopfzeile** zeigt Zustände: Modellname als Dokumentmenü, Speicherstand, Build-Anzeige mit Auto-Build, dazu Exportieren und Speichern. Die **Verlaufsleiste** sitzt unter dem Viewer. Eine Startseite zeigt Modelle, erkannte Agenten und den Hinweis auf die Rechte des Agenten.

**Viewer (E22, E33):**

| Phase | Funktionen |
|---|---|
| **Phase 1 (MVP)** | Navigation, Standardansichten, Darstellungsmodi (schattiert, Kanten, Drahtgitter, Transparenz), Ein-/Ausblenden über den Tree, Klick auf Bauteil → Codezeile, **Screenshot mit Markup** |
| **Danach** | Messen (Punkt-zu-Punkt, Bounding-Box, exakte Werte, **umgesetzt**), Schnittansicht (wichtig für Gehäuse, **umgesetzt**), Versions-Schieber (umgesetzt in Schritt 2) |
| **Später** | Volumen/Gewicht, Versionsvergleich, Explosionsansicht |

Der Viewer zeigt auch **beliebige weitere STEP-Dateien** im Basismodus, ohne Mapping und Zusatzfunktionen. Standardanzeige ist immer das Hauptmodell.

**2D-Sketching (E16):** Nur Bild-Markup ohne Maßhaltigkeit auf Viewer-Screenshots und leerer Fläche (Freihand, Formen, Pfeile, Text). Ergebnis ist ein PNG. Kein Constraint-Sketcher. Umgesetzt in Phase 1, Schritt 4 (Abschnitt 10).

## 8. Umgebung, Auslieferung, Lizenz

- **Eine Variante „alles drin"** mit mitgeliefertem Python, CadQuery und Git (E31, E32). Kein Bring-your-own.
- **Lizenz:** Open Source, konkrete Lizenz offen (MIT oder Apache-2.0 naheliegend). Lizenzen aller mitgelieferten Komponenten sind zu prüfen (E30).
- **Auslieferung:** Installer für drei Betriebssysteme, Code-Signing und Auto-Update der App sind noch zu klären.

## 9. Robustheit gegen Abweichungen des Agenten

Agenten befolgen `AGENTS.md` nicht zuverlässig. Sie können Dateien verschieben oder löschen, eigene Umgebungen (z. B. `.venv`) anlegen, `AGENTS.md` ändern, Git umbauen oder an der App vorbei arbeiten. **Die App darf dadurch nicht kaputtgehen.**

**Regeln (Entwurf, noch nicht ausdrücklich bestätigt)**

1. **Der Arbeitsordner ist nicht vertrauenswürdig.** `AGENTS.md` ist eine Bitte, keine Garantie.
2. **Jede Konvention braucht einen Rückfallweg.** Ohne Hilfsbibliothek zeigt der Viewer trotzdem die STEP-Datei, ohne Klick→Code.
3. **Erkennen und erklären statt abstürzen.** Der **Projekt-Check** läuft beim Öffnen, Bauen und Speichern. Keine automatischen Reparaturen, kein Reparieren-Button (E28).
4. **App-kritischer Zustand ist aus einer zweiten Quelle wiederherstellbar** (E27).
5. **Nichts wird stillschweigend überschrieben oder zerstört.** Wo die App doch eingreift, gibt es vorher Backup oder Git-Stand und einen Hinweis.

**Störfälle** (Reaktionen sind Richtungen, keine fertigen Spezifikationen)

| Störfall | Mögliche Folge | Richtung |
|---|---|---|
| `model.py` fehlt, umbenannt oder verschoben | Kein Build | Einstiegspunkt in `project.json` wählbar, Hinweis |
| Agent exportiert selbst oder ohne Hilfsbibliothek | Kein Mapping/GLB | STEP-Fallback im Viewer, Hinweis |
| Mehrere oder anders benannte STEP-Dateien | Unklar, was angezeigt wird | Hauptausgabe in `project.json`, sonst Auswahlliste |
| Agent legt `.venv` an und installiert dort | Build findet Pakete nicht, `.venv` landet in ZIP/Git | `.venv`/`venv` immer ausschließen, Build-Fehler mit Hinweis auf die Projektumgebung |
| Agent nutzt anderes Python oder `pip --user` | Paketliste unvollständig | Abgleich beim Build, Warnung |
| `AGENTS.md` verändert oder gelöscht | Regeln fehlen | Prüfsumme, im Check melden. Erneuerung nur beim Versions-Update (E36) |
| `.soma/` oder `project.json` gelöscht | ID und Einstellungen weg | Aus App-Daten bzw. ZIP wiederherstellen (siehe offene Punkte) |
| `.git` gelöscht, neu initialisiert, History umgeschrieben, anderer Branch | Zeitleiste kaputt | Zeitleiste tolerant aus `git log`, Bruch im Check melden |
| Agent committet nie oder zu oft, riesige Dateien | Leerer Schieber, große ZIP | Auto-Snapshot, Größenwarnung |
| `inputs/` verändert | Mitgebrachte Datei verfälscht | Git-Stand, Hinweis |
| Build hängt oder dauert endlos | App blockiert | Timeout, Abbrechen, Dienst neu starten |
| Agent arbeitet außerhalb des Projektordners | Ergebnisse fehlen in der ZIP | Nicht verhinderbar, wo möglich erkennen |
| Agent ändert eine Datei, die der Nutzer gerade im Editor bearbeitet | Eine der beiden Fassungen ginge verloren | **Umgesetzt:** nichts überschreiben, Hinweis im Editor, der Nutzer wählt, die andere Fassung kommt in eine Sicherung |
| Python-Dienst stürzt ab | Viewer/Messen tot | Automatischer Neustart, Meldung |

## 10. Phasen

**Phase 0: technischer Prototyp ohne App (E13, E14). Abgeschlossen**, alle Punkte bestanden. Details und Zahlen in [ERGEBNISSE.md](prototype/phase0/ERGEBNISSE.md), Code und Tests in `prototype/phase0/`:

1. **STEP mit Namen und Farben:** `cq.Assembly.export` genügt, kein eigener XCAF-Export nötig. Nicht-ASCII-Namen werden beim Export zerstört, daher ASCII-Namen in der STEP.
2. **GLB mit Flächen-IDs:** eigener Mesher (rund 150 Zeilen), alle IDs gegen OCC verifiziert. Die IDs gelten nur für einen Build. Der Python-Anteil ist nicht der Engpass, das Meshen in OCC ist es.
3. **Klick → Datei und Zeile:** in echtem Browser bestanden, auf Ebene von Bauteil und Fläche. Verknüpft wird der `add_part`-Aufruf mit Zeilenbereich.
4. **Fremd-STEP, Messen, Aussparung, Referenz:** bestanden, Abstände und Radien exakt über die IDs. Der Basismodus für fremde STEP-Dateien funktioniert. Getestet nur mit synthetischer Platine.
5. **Umgebung:** VTK lässt sich nicht entfernen (OCP hängt hart daran). Installiert 0,76 bis 1,04 GB, vorerst hingenommen (E37).
6. **Exportformate:** 12 Formate, PLY und X_T entfallen.

**Phase 1: MVP-Kern als Desktop-App. In Arbeit.** Projekt neu, speichern und öffnen als ZIP mit Git. Editor, Terminal mit Agent, Viewer (Umfang siehe Abschnitt 7), Screenshot mit Markup, `AGENTS.md`, `soma build`. Hier folgt auch der **Agent-Test**: Ein Agent baut mit erster `AGENTS.md` und Hilfsbibliothek ein Beispielmodell, geprüft wird u. a., ob er den Verweisen folgt.

*Schritt 1, lauffähiges Gerüst (erledigt, Ende-zu-Ende-Test mit 21 Prüfungen in `app/test/smoke.mjs`):*

- **App:** Electron und TypeScript, Layout aus Abschnitt 7 (Tree mit Reitern *Modell* und *Dateien*, Viewer, Terminal-Tabs, Top Bar, Statusleiste, verschiebbare Trennleisten). Arbeitsordner unter `<App-Daten>/workspaces/<uuid>/`, Projektzustand doppelt (E27), Projekt-Check meldet nur (E28).
- **`soma` (Python-Paket in `python/`):** `add_part` mit Datei und Zeilenbereich, `soma build` (STEP, GLB, Mapping, `build.json`), `soma export` (12 Formate). Fehler in `model.py` (Syntax, Laufzeit, doppelter Name, kein Bauteil, Einstiegspunkt fehlt) kommen mit Datei, Zeile und gekürztem Traceback zurück, der letzte gute Stand bleibt sichtbar.
- **Build (E20):** Auto-Build beim Speichern, entprellt, abschaltbar. Änderungen während eines Builds führen zu genau einem Folgebuild. Zeitlimit und Abbruch sind eingebaut.
- **Viewer:** Klick liefert Bauteil, Fläche und markierte Codezeile. Ein- und Ausblenden, Standardansichten, Kanten, Drahtgitter, Transparenz. Kamera, Sichtbarkeit und Auswahl bleiben über Rebuilds erhalten.
- **Terminal:** Echte Shell (node-pty) im Projektordner mit `python`, `pip` und `soma` der Basisumgebung im PATH. Startbuttons für erkannte Agenten (Claude Code, OpenCode, Codex, Gemini CLI).
- **Vorlage:** `model.py`, erste `AGENTS.md`, `CLAUDE.md` (Verweis), `NOTES.md`, `.gitignore`.

*Erster Agent-Test (informell, vom Nutzer):* Claude Code hat mit dieser Vorlage eine Wanduhr gebaut, 6 Bauteile mit deutschen Namen, Parameter als Konstanten, kein `.venv`, `AGENTS.md`, `CLAUDE.md`, `NOTES.md` und `.gitignore` unverändert. Das ist ein Datenpunkt, kein vollständiger Agent-Test. Damals gab es noch kein Git.

*Zweiter Agent-Test (informell, vom Nutzer, nach Schritt 2):* Claude Code hat nach dem Build **selbst committet**, mit deutscher Nachricht („Vereinfachte Wanduhr: Gehäuse, Zifferblatt, …“), `model.py` und `output/model.step` im selben Commit, der Verlauf blieb unangetastet. Auch das ist eine einzelne Iteration mit einem Agenten. Ungeprüft sind lange Sitzungen und andere Agenten (OpenCode, Codex, Gemini CLI).

*Schritt 2, Git und ZIP (erledigt, 46 Prüfungen in `app/test/versions.mjs`):*

- **Git pro Projekt:** Repository mit Startcommit, Identität und `core.autocrlf=false` gesetzt, damit auch der Agent committen kann. Die `AGENTS.md` verlangt Commits nach gebauten Iterationen und verbietet Umschreiben des Verlaufs.
- **Speichern (E8, E21):** Strg+S baut bei Bedarf zuerst neu, legt einen Auto-Snapshot an (nur bei Änderungen an Quelltext, Eingaben oder Einstellungen) und schreibt die ZIP atomar (erst `.part`, dann umbenennen). Sie enthält `.git`, aber keine Umgebungen und Caches. Ein Marker `.soma/zip-info.json` hält den gespeicherten Stand fest. Der Modellname folgt dem Dateinamen. Ohne `.git` klappt Speichern weiter, mit Warnung.
- **Öffnen (E21):** Fehlt der Arbeitsordner (anderer Rechner), wird die ZIP entpackt. Ist er identisch, wird er einfach geöffnet. Weicht er ab, fragt die App: *Arbeitsstand behalten* oder *ZIP laden*, dabei wandert der alte Arbeitsordner nach `workspace-backups/`, nichts wird gelöscht. Entpacken ist gegen bösartige Pfade abgesichert (zwei Schichten).
- **Absturz-Wiederherstellung:** Der Arbeitsordner liegt fest in den App-Daten, die App öffnet beim Start das letzte Projekt. Ungespeicherte Änderungen überleben einen harten Abbruch (getestet). Beim Schließen mit ungespeicherten Änderungen fragt die App (nicht automatisch getestet).
- **Verlauf (E35):** Leiste unter dem Viewer, jeder Commit ein Punkt plus der Arbeitsstand, Schieber und Klick. Alte Stände sind eine schreibgeschützte Vorschau (STEP per `git show`, Basismodus). *Stand wiederherstellen* legt einen neuen Commit an und sichert vorher ungesicherte Änderungen als eigenen Stand. Kein Checkout, kein Reset, keine Branches.
- **Robustheit (E28):** App-eigene Git-Schreibvorgänge laufen nacheinander und wiederholen sich bei `index.lock`, lesende Aufrufe nehmen keine Sperren. Ohne `.git` meldet der Verlauf das verständlich und bietet **keine** automatische Reparatur an.

*Schritt 3, Oberfläche nach Entwurf (erledigt, E38; 31 Prüfungen im Smoke-Test, 50 im Verlaufstest, 4 Einheitentests in `app/test/unit.mjs`):*

- **Kopfzeile:** Dokumentmenü (Neu, Öffnen, zuletzt geöffnete Modelle, Speichern unter, im Explorer zeigen, Startseite), Speicherstand („Nicht gespeichert · zuletzt 13:41“), Build-Anzeige in den Zuständen gebaut, baut (mit Abbrechen), fehlgeschlagen (mit Zeile) und „Code geändert“ bei ausgeschaltetem Auto-Build. Schaltet man Auto-Build wieder ein, baut die App den veralteten Stand gleich nach. Kurzbefehle Strg+S, Strg+Umschalt+S, Strg+O, Strg+N, Strg+B (nicht im Terminal).
- **Viewer:** schwebende Bauteilkarte mit Auge, Suche, Referenzen-Abschnitt und Kontextmenü (Isolieren, Ausblenden, Kamera, Code zeigen, An Agent geben, Exportieren). Auswahlkarte mit Flächenart und Codeausschnitt. Fehlerkarte mit Meldung, Codezeile und Ablauf, das Modell bleibt gedimmt sichtbar. Ansichtswürfel (Oben, Vorne, Rechts), Einpassen, Standardansicht, Darstellungsmenü.
- **Export (E34):** Menü mit allen 12 Formaten, für alle Bauteile oder die Auswahl, über `soma export` nach `exports/`.
- **Dateien und Code:** Dateibaum mit eingeklappten App-Dateien. Dateien, die man ins Fenster zieht, landen in `inputs/`, Vorhandenes wird nie überschrieben (E33). Code-Panel zum Lesen mit Hervorhebung, der Auswahl im Viewer folgend.
- **Verlauf:** Punkte unterscheiden Stände der App (Commit-Trailer `Erstellt-von: SOMA`) und des Agenten, der gespeicherte Stand ist grün, die Vorschau violett mit Rahmen um den Viewer.
- **Agent-Bereich:** Tabs mit Laufanzeige, „+“ startet erkannte Agenten oder ein leeres Terminal, einklappbar. Die Übergabeleiste fügt Text in die Eingabe ein (als Einfügen, ohne Enter, E11).
- **Startseite** beim allerersten Start und über das Logo: Neu, Öffnen, zuletzt geöffnete Modelle mit Vorschaubild, erkannte Agenten, Hinweis auf die Rechte des Agenten (E29).
- **Schrift:** IBM Plex Sans und Mono liegen lokal bei (SIL Open Font License).

*Schritt 4, Markierung (erledigt, E16; 53 Prüfungen im Smoke-Test, 53 im Verlaufstest, 8 Einheitentests):*

- **Ablauf:** „Markieren“ im Viewer oder „Markierung“ in der Übergabeleiste friert die aktuelle Ansicht in voller Auflösung ein. Bauteilkarte, Würfel und Karten treten zurück, ein gestrichelter Rahmen zeigt den Modus. „An Agent geben“ legt das Bild als `.soma/feedback/markierung-JJJJMMTT-HHMM.png` ab (nie überschreibend, bei Gleichstand `-2`) und fügt `[Markierung: <Pfad>] ` in die Eingabe des aktiven Terminals ein, ohne abzuschicken (E11).
- **Werkzeuge:** Stift, Pfeil, Rechteck, Kreis oder Ellipse (mit Umschalt: Quadrat und Kreis), Text. Farbmenü mit 10 Farben und eigener Farbe (Farbdialog), Rückgängig und Wiederholen (Strg+Z, Strg+Y), „Leere Fläche“ zum Skizzieren ohne Modell. Striche und Text haben einen dunklen Schatten, damit sie auch auf hellen Bauteilen lesbar bleiben.
- **Formen bleiben bearbeitbar (Wunsch des Nutzers):** Mit „Auswählen“ lässt sich jede Form anklicken und verschieben (auch mit den Pfeiltasten), an den Ecken skalieren (die gegenüberliegende Ecke bleibt stehen, Umschalt hält das Seitenverhältnis), am Punkt über dem Rahmen drehen (Umschalt: 15°-Schritte), umfärben und mit Entf löschen. Doppelklick auf einen Text, oder Klick mit dem Textwerkzeug, bearbeitet ihn. Jede Form speichert Mittelpunkt, Drehung und Skalierung getrennt von ihrer Geometrie, deshalb wächst die Strichstärke beim Skalieren nicht mit. Auswahlrahmen und Griffe kommen nicht ins Bild.
- **Vorschau alter Stände:** Wird ein alter Stand markiert, nennt der eingefügte Text den Stand (Kurz-Hash und Nachricht), damit der Agent nicht mit dem aktuellen Code vergleicht.
- **Robustheit:** Scheitert das Speichern, bleibt die Zeichnung offen. Der Hauptprozess nimmt nur PNG bis 64 MB an. Der Pfadschutz (`resolveInside`) prüft bei noch nicht vorhandenen Dateien jetzt den nächsten vorhandenen Ordner darüber, sonst hätte ein Verweis `.soma` → außen Dateien außerhalb des Projekts landen lassen.
- **Git und ZIP:** Markierungen sind nicht in Git (E11) und zählen nicht als ungespeicherte Änderung, wandern aber beim nächsten Speichern mit der ZIP.

*Agent-Test Markierung (informell, vom Nutzer):* Mit `[Markierung: …]` in der Eingabe hat Claude Code das Bild geöffnet und umgesetzt.

*Schritt 5, Editor (erledigt, E39, E40; 29 Prüfungen in `app/test/editor.mjs`, 15 Einheitentests):*

- **Editor im Code-Panel:** CodeMirror 6 mit Zeilennummern, Python-Hervorhebung in den Farben der Codeausschnitte (Konstanten wie `LENGTH` eigens), Klammern, Einrückung mit 4 Leerzeichen, Suchen und Ersetzen (Strg+F, deutsch beschriftet), Rückgängig je Datei. Die Auswahl im Viewer markiert die Zeilen des `add_part`-Aufrufs, die Fehlerkarte die Fehlerzeile in Rot. Während getippt wird, springt der Editor nicht, nur die Markierung wandert mit.
- **Speichern nur auf Wunsch (E39):** Beim Tippen passiert nichts auf der Platte und es wird nicht gebaut. Der Reiter zeigt einen Punkt, die Infozeile „Nicht gespeichert · Strg+S“ und den Knopf „Speichern und bauen“, der Speicherstand oben zählt die Eingaben mit. Strg+S im Editor und der Knopf schreiben die Dateien (erst in eine Nebendatei, dann umbenennen) und bauen **genau einmal**, aber nur, wenn eine gespeicherte Datei das Modell betrifft (E40: Python und `inputs/`, dieselbe Regel wie die Dateiüberwachung in `src/shared/editable.ts`). Bei `NOTES.md` heißt der Knopf nur „Speichern“. Die Dateiüberwachung erkennt, dass die Änderung schon im laufenden Build steckt, und baut nicht noch einmal. „Speichern“ oben (und Strg+S außerhalb des Editors) speichert zuerst den Editor, dann Snapshot und ZIP. „Jetzt bauen“ speichert ebenfalls vorher.
- **Rückfragen statt Verlust:** Vor Modellwechsel, Wiederherstellen, Schließen eines Reiters und Beenden fragt die App bei ungespeicherten Eingaben: Speichern, Verwerfen (die Eingabe kommt vorher in eine Sicherung) oder Abbrechen. Beim Beenden ist das eine gemeinsame Frage mit der nach der ZIP. Jede Schreibanfrage trägt die ID des Modells, eine verspätete für ein altes Modell wird als Sicherung abgelegt statt ins neue geschrieben.
- **Agent und Nutzer an derselben Datei:** Der Editor kennt den Stand, den er zuletzt von der Platte hatte. Ändert der Agent die Datei und im Editor liegt nichts Ungesichertes, übernimmt der Editor die neue Fassung (nur den geänderten Teil, Schreibmarke bleibt, nicht im Rückgängig). Liegt etwas Ungesichertes da, wird nichts überschrieben: Ein Hinweis bietet „Meine Fassung behalten“ oder „Fassung von außen laden“, die jeweils andere Fassung kommt nach `workspace-backups/<id>-editor/`. Gelöschte Dateien lassen sich mit der eigenen Fassung neu anlegen. Beim Beenden mit offenem Konflikt sichert die App die eigene Fassung und nennt den Pfad.
- **Nur lesen:** `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `output/`, `exports/`, `.soma/`, `.git/` (Regel in `src/shared/editable.ts`, der Hauptprozess prüft sie beim Schreiben noch einmal), dazu Dateien über 2 MB und solche, die nicht als UTF-8 lesbar sind. Der Grund steht über dem Text.
- **Zeilenenden** der Datei bleiben erhalten (CRLF bleibt CRLF).
- **Höhe:** Der Editor füllt das Panel bis unten und lässt sich bei langen Dateien bis zum Ende scrollen (CodeMirror erzwingt `position: relative`, die Höhe kommt deshalb über `height`).
- **Nebenbei:** Die App nutzt jetzt das dunkle Farbschema des Systems (`color-scheme: dark`), Scrollleisten sind dunkel. Im schmalen Viewer (etwa bei offenem Code-Panel) rückt die Fehlerkarte nach unten, statt über den Rand zu ragen. Behoben: Der Speicherstand oben konnte nach dem Speichern fälschlich „Noch nicht gespeichert“ zeigen, wenn die regelmäßige Git-Abfrage gerade lief (sie las den Stand der App vor ihren Git-Aufrufen).

*Messen (vorgezogen aus „Danach“, E9, E22, E24; 21 Prüfungen in `app/test/measure.mjs`):*

- **Ablauf:** „Messen“ im Viewer schaltet den Messmodus. Ein Klick wählt einen Eckpunkt, eine Kante oder eine Fläche, in dieser Reihenfolge (Punkte mit 9 px Fangradius, Kanten mit 7 px, Verdecktes zählt nicht), und zeigt die exakten Werte: Lage eines Punkts, Durchmesser und Radius (Zylinder, Kreis, Kugel), Achse oder Normale, Länge, Flächeninhalt, dazu die Außenmaße des Bauteils. Ein zweiter Klick misst zum ersten: Abstand paralleler Ebenen (Wandstärke, Spaltmaß), Abstand der Achsen oder Mittelpunkte (Bohrungen), vom Punkt aus den Abstand zur Ebene, Achse oder Geraden, zwischen zwei Punkten ihren Abstand, sonst den kürzesten Abstand, dazu Punkt zu Punkt mit ΔX/ΔY/ΔZ und den Winkel. Punkte kamen auf Wunsch des Nutzers dazu, der Mesher legt dafür eine Tabelle der Eckpunkte mit exakten Koordinaten ins GLB. Der dritte Klick beginnt von vorn, Escape verwirft erst die Messung, dann den Modus.
- **Anzeige:** Elemente in Orange hervorgehoben, unter dem Zeiger leicht aufgehellt, die Hauptstrecke als Linie mit Beschriftung, Punkt zu Punkt gestrichelt. Die Karte unten links ersetzt solange die Auswahlkarte. „An Agent geben“ fügt die Messung als Text ein (Zahlen mit Punkt, drei Stellen).
- **Exakt gerechnet:** Der Build legt die Bauteile zusätzlich als BREP unter `.soma/geometry/<build>.brep` ab, die Kennung steht auch in `model.map.json`. Ein langlebiger Python-Dienst (`soma serve`, JSON-Zeilen) lädt sie beim ersten Messen (einige Sekunden) und rechnet mit OCC. Jede Anfrage trägt die Build-Kennung und den Flächeninhalt bzw. die Länge aus dem Viewer, so fällt jede Verwechslung auf. Nach einem neuen Build beginnt die Messung von vorn. Auch Vorschauen alter Stände lassen sich vermessen.
- **Git und ZIP:** `.soma/geometry/` ist ein Zwischenergebnis. Neue Projekte haben es in der `.gitignore`, bei älteren klammert die App es selbst aus (Status, Snapshot, ZIP). Dabei fiel auf, dass `git add` mit einem Ausschluss auf einen ignorierten Ordner scheitert: Die App nimmt den Ordner deshalb nach dem Hinzufügen wieder aus dem Index.

*Ansicht (Wunsch des Nutzers; 8 Prüfungen im Smoke-Test):*

- **Ansichtswürfel in 3D** (`viewcube.ts`, eigene kleine Szene): dreht sich mit der Kamera, jede Seite ist in 3 × 3 Felder geteilt, ein Klick auf Seite, Kante oder Ecke dreht die Ansicht animiert in eine der 26 Richtungen. Ziehen am Würfel dreht frei, beim Überfahren leuchtet das Feld orange und ein Hinweis nennt die Richtung. Achsen X, Y, Z an der Ecke links vorne unten. Einpassen und Standardansicht darunter wie bisher, die sechs Ansichten auch im Menü „Darstellung“ (per Tastatur erreichbar).
- **Drehpunkt verschieben:** Doppelklick ins Modell macht die Stelle zum Drehpunkt, die Ansicht verschiebt sich dafür, ohne zu drehen. Das Mausrad zoomt zur Mausposition, die rechte Maustaste verschiebt. Während der Bewegung zeigt ein Punkt den Drehpunkt. Die vordere Schnittebene folgt dem Abstand, so lassen sich Ecken von ganz nah ansehen, ohne dass sie weggeschnitten werden.

*Gruppen und Transparenz (E42; 17 Prüfungen in `app/test/groups.mjs`):*

- **Gruppen:** `add_part("Deckel", lid, group="Gehäuse")`, verschachtelt mit „/“. Eine STEP-Datei mit Struktur kommt mit `import_assembly("inputs/platine.step")` und `add_part("Platine", asm, role="reference")` herein: Jeder Körper wird ein Bauteil mit seinem Namen und seiner Farbe, Unterbaugruppen werden Gruppen unter „Platine“, verschoben wird mit `asm.loc`. Doppelte Namen aus der Datei bekommen „(2)“. Die Ausgabe-STEP enthält die Gruppen als Unterbaugruppen (Referenzen unter „Referenz“), auch die Vorschau alter Stände zeigt sie.
- **Bauteilkarte als Baum:** Gruppen auf- und zuklappbar, mit Anzahl. Jede Zeile hat ein Auge und einen Schalter „transparent“, bei Gruppen für alle Teile darin (teilweise transparente Gruppen sind gekennzeichnet). Rechtsklick auf eine Gruppe: Isolieren, Aus-/Einblenden, Transparent, Kamera auf Gruppe. Die Suche zeigt Treffer samt ihren Gruppen. Der Auswahltext für den Agenten nennt die Gruppe.
- **Transparent:** deutlich durchsichtig, ohne zu verdecken. Klicks und Messungen gehen durch transparente Teile hindurch, sie selbst werden nur getroffen, wenn dahinter nichts liegt.
- **Nebenbei behoben:** Die Verlaufsleiste konnte einen veralteten Stand behalten, wenn sich zwei Abfragen überholten (fiel im Gesamtlauf der Tests auf, als `.git` verschwand).

*Name und Icon (E43, E44):*

- **SOMA** (*Solid Object Modeling with Agents*) ersetzt den Arbeitsnamen CAD-IDE überall: Oberfläche, Paket und Befehl `soma`, Projektordner `.soma/`, Umgebungsvariablen `SOMA_*`, App-Daten unter `%LOCALAPPDATA%\soma`. Ohne Rückfallweg: Projekte mit `.cadide/` öffnet die App nicht mehr, ein `model.py` mit `from cadide import` baut nicht mehr. Die alten Ordner `%LOCALAPPDATA%\cadide` (App-Daten mit Arbeitsordnern) und `%LOCALAPPDATA%\cadide-dev` (lokale Electron-Kopie) bleiben liegen und werden nicht mehr benutzt.
- **Icon „Dialog“ (E44):** der Würfel als Sprechblase mit orangem Deckel. In Kopfzeile und Startseite als Symbol `logo` (`icons.ts`), für Fenster und Taskleiste als `resources/icon.ico` (16 bis 256 px, kleine Größen mit dickerem Strich), erzeugt mit `app/scripts/make-icon.py`. Ins Programm selbst (EXE) kommt das Icon erst mit dem Installer.

*Schnitt (vorgezogen aus „Danach“, Wunsch des Nutzers; 26 Prüfungen in `app/test/section.mjs`):*

- **Ablauf:** „Schnitt“ im Viewer öffnet die Karte unten rechts. Die Ebene steht senkrecht zu X, Y oder Z, zuerst mitten im Modell. Weggeschnitten wird die Seite, von der die Standardansicht kommt (rechts, vorne, oben), so sieht man gleich hinein. „Seite wechseln“ dreht das um, „Blick auf den Schnitt“ dreht die Kamera senkrecht auf die Ebene. Die Lage stellt ein Schieber ein oder ein Eingabefeld in mm (Komma oder Punkt, Enter übernimmt, Pfeiltasten 1 mm, mit Umschalt 10 mm, mit Alt 0,1 mm).
- **An einer Fläche ausrichten:** „Fläche“ und dann eine ebene Fläche anklicken: Die Ebene liegt parallel dazu, anfangs mitten durch das Bauteil der Fläche, eingestellt wird die Tiefe ab der Fläche. Unter dem Zeiger leuchtet die Fläche auf, eine gekrümmte wird abgelehnt, Escape bricht ab.
- **Darstellung:** Die Schnittfläche ist gefüllt, je Bauteil in seiner Farbe (abgedunkelt) und schraffiert, die Richtung der Schraffur wechselt von Bauteil zu Bauteil. Eine dunkle Kontur umrandet sie. Gefüllt werden nur sichtbare, deckende, geschlossene Körper (der Mesher schreibt dafür `solid` ins GLB), bei transparent geschalteten Teilen und Referenzen sieht man ohnehin hinein. Kanten, Hervorhebungen und Messmarken der Elemente werden mitgeschnitten, Messstrecken nicht. Das Vorschaubild der Startseite zeigt das Modell ohne Schnitt.
- **Klicks und Messen:** Was weggeschnitten ist, lässt sich nicht anklicken, der Klick geht dorthin, wo man hinsieht. Ein Klick auf die Schnittfläche wählt das Bauteil („Schnittfläche · ganzes Bauteil“), Doppelklick setzt dort den Drehpunkt. Beim Messen wählt ein Klick nahe der Kontur die geschnittene Fläche, so misst man Wandstärken direkt im Schnitt (zwei Konturlinien ergeben den Abstand der Ebenen). Die Schnittfläche selbst hat keine exakte Geometrie, ein Klick darauf gibt nur einen Hinweis und verwirft die Messung nicht.
- **Für den Agenten:** Eine Markierung im Schnitt nennt die Ebene und die weggeschnittene Seite (`Schnittansicht bei X = 0.000 mm, weggeschnitten ist X > 0.000`), sonst hielte der Agent die Schnittfläche für eine echte Fläche.
- Der Schnitt ändert nichts am Modell, bleibt über neue Builds und Vorschauen erhalten und wird nicht gespeichert.
- **Technik:** eine Schnittebene von three.js für alle betroffenen Materialien, die Füllung über den Schablonenpuffer (Rückseiten zählen hoch, Vorderseiten herunter, wo etwas übrig bleibt, zeichnet eine Platte in der Ebene), die Kontur aus den Dreiecken des Netzes.
- **Nebenbei behoben:** Ein nur lesbarer Reiter im Editor, dessen Datei gelöscht wurde, galt als Konflikt und blockierte das Speichern des Modells. Er schließt sich jetzt. Ein Konflikt erledigt sich auch, wenn die Datei wieder so ist wie zuletzt gelesen.

*Skills (E17; 23 Prüfungen in `app/test/skills.mjs`):*

- **Panel „Skills“** in der Leiste links: die mitgelieferten Skills mit Schalter, Kurzbeschreibung und aufklappbar den Themen. Mitgeliefert sind drei Entwürfe in `app/resources/skills/`: **3D-Druck (FDM)**, **Toleranzen und Passungen**, **Gehäusebau**. Der Inhalt ist für den Agenten auf Englisch, Titel, Beschreibung und Themen für die Oberfläche auf Deutsch (im Kopf der Datei). Die CadQuery-Befehle darin (Kollisionsprüfung, Abstand, Senkungen) sind gegen die Basisumgebung geprüft.
- **Einschalten** kopiert den Skill nach `.soma/skills/<id>.md`, trägt ihn in `project.json` (und die App-Kopie, E27) ein und listet ihn in einem eigenen Abschnitt am Ende der `AGENTS.md` (zwischen `<!-- soma:skills -->` und `<!-- /soma:skills -->`, bei älteren Projekten ohne diesen Abschnitt wird er angehängt). Die Vorlage hat den Abschnitt schon, leer. **Ausschalten** entfernt Kopie und Eintrag. Beides zählt als ungespeicherte Änderung und wandert mit Snapshot, Git und ZIP.
- **Agent:** Ein laufender Agent liest `AGENTS.md` nicht von selbst neu. Die Meldung nach dem Schalten sagt das, „An Agent geben“ fügt `[Skill: .soma/skills/<id>.md] ` ein, `AGENTS.md` erklärt dem Agenten diese Notiz.
- **Ansehen:** Die Kopie öffnet sich im Code-Panel, nur lesbar („Kopie eines Skills“).
- **Robustheit (E28):** Nichts wird still ersetzt: Weicht die Kopie im Projekt von der mitgelieferten Fassung ab (vom Agenten geändert, ältere App), meldet die Karte das, und vor dem Überschreiben oder Entfernen kommt sie nach `workspace-backups/<id>-skills/`. Fehlt die Datei eines aktiven Skills, nennt das die Karte und der Projekt-Check, angelegt wird nichts. Fehlt `AGENTS.md`, geht der Skill trotzdem an, mit Warnung, die Datei wird nicht neu erzeugt. Nennt `AGENTS.md` einen aktiven Skill nicht (etwa nach dem Zurückholen einer alten Fassung), steht das in der Karte. Skills, die nur im Projekt liegen (aus einer neueren App), bleiben gültig.

*Offen in Phase 1:* Projektumgebung mit `pip freeze` und `requirements.txt` (bisher landet `pip install` noch in der gemeinsamen Basisumgebung), Auto-Start des Agenten ohne Resume, Agent-Test mit weiteren Agenten und längeren Sitzungen, Bündelung von Python und Installer, macOS und Linux.

**Danach:** Versions-Schieber, `soma check` und Projekt-Check, MCP-Server. **Später:** Volumen/Gewicht, Versionsvergleich, Explosionsansicht, eigene Nutzer-Skills, maßhaltiger Sketcher (nur bei Bedarf).

## 11. Offene Punkte

**Noch nicht ausdrücklich bestätigt (Vorschläge von mir)**

- `AGENTS.md` und die Kommentare der Vorlage sind **auf Englisch** (Agenten befolgen englische Anweisungen zuverlässiger), die Oberfläche ist deutsch
- App-Daten liegen unter Windows in `%LOCALAPPDATA%\soma`, nicht im Roaming-Profil (Arbeitsordner und Caches gehören nicht ins Netz)
- Beim Öffnen eines Projekts wird sofort gebaut, damit der Viewer nicht leer ist. Beim Anlegen läuft vor dem Startcommit ein Build (rund 2 s Wartezeit bei „Neu“)
- Der Modellname folgt dem Dateinamen der ZIP
- Speichern baut vorher neu, wenn der Quelltext neuer ist als das letzte Ergebnis, und wartet auf laufende Builds
- Die ZIP enthält `.git` und Feedback-Bilder, aber weder Umgebungen noch GLB-Cache, Mapping und `build.json`
- Ohne `.git` gibt es **keinen** Knopf „Verlauf neu anlegen“, nur die Meldung (sonst widerspricht es E28). Offene Frage: Für Nicht-Programmierer wäre ein ausdrücklicher Knopf freundlicher
- Änderung während eines Builds: laufenden Build fertig laufen lassen, danach genau ein weiterer (statt abbrechen und neu starten)
- Oberfläche (E38): Funktionen, die noch fehlen (inzwischen nur noch Pakete, Hilfe, Optionen), stehen schon ausgegraut mit Hinweis da. Nur dunkles Farbschema. Das „⋯“-Menü aus dem Entwurf entfällt (alles steht im Dokumentmenü)
- Dateien, die man irgendwo ins Fenster zieht, landen in `inputs/` (Electron würde sie sonst als Seite öffnen). Bei gleichem Namen „name (2).ext“
- Die Startseite erscheint nur beim allerersten Start und über das Logo. Sonst öffnet die App wie bisher das letzte Modell
- „An Agent geben“ fügt eine Zeile wie `[Auswahl: Bauteil "Lid", model.py Zeile 31, angeklickte Fläche: eben, …]` ein. Zahlen mit Punkt, damit der Agent sie eindeutig liest
- `exports/` ist nicht in der `.gitignore` der Vorlage und zählt damit als Änderung (Ort und Tracking sind noch offen, siehe unten)
- Markierung (E16): Das Bild zeigt die Ansicht **ohne Auswahl-Hervorhebung** (die ist Orange wie der Stift und verschluckte die Zeichnung) und ohne schwebende Karten. Auflösung wie der Viewer in Gerätepixeln, keine Verkleinerung. Eine Strichstärke
- Markierung, Farben: Statt der drei Farbpunkte aus dem Entwurf steht ein Farbknopf mit Menü in der Leiste (10 Farben und eigene Farbe), sonst würde die Leiste zu breit. Eine Farbe gilt für alles Folgende und färbt eine ausgewählte Form gleich mit
- Markierung, Bearbeiten: eigenes Werkzeug „Auswählen“ statt Auswahl mit jedem Werkzeug (sonst verschöbe ein neuer Strich die Form darunter). Rechteck und Ellipse sind hohl und nur an der Linie greifbar, damit Formen darunter erreichbar bleiben. Text skaliert immer im Seitenverhältnis, das Textfeld steht beim Bearbeiten ungedreht
- Markierung: Eingefügt wird `[Markierung: .soma/feedback/markierung-JJJJMMTT-HHMM.png] ` (gleiche Form wie Auswahl und Build-Fehler). Beide Knöpfe („Markieren“ im Viewer, „Markierung“ in der Übergabeleiste) öffnen die Zeichenfläche
- Markierung: Escape verwirft eine Zeichnung erst beim zweiten Druck, „Abbrechen“ sofort. Text wird mit Enter oder beim nächsten Klick übernommen
- Markierungen zählen nicht als ungespeicherte Änderung und werden nie aufgeräumt (`.soma/feedback/` wächst, siehe ZIP-Größe unten)
- Editor: **CodeMirror 6** statt Monaco (leichter, braucht keine Worker, passt zur Sicherheitsrichtlinie, lässt sich mit den eigenen Farben gestalten). Keine Autovervollständigung und keine Prüfung beim Tippen, das übernimmt der Build
- Editor (E39, Auslegung): **Strg+S im Editor** speichert Code und baut, ohne ZIP und Snapshot. **Strg+S außerhalb** und „Speichern“ oben speichern das ganze Modell. Grund: Beim Ausprobieren im Code soll nicht jedes Speichern einen Snapshot anlegen und beim neuen Modell nach dem ZIP-Ort fragen. Änderungen des Agenten baut weiter der Auto-Build
- Editor: Nach Strg+S ohne Änderung oder nur an Notizen wird nicht gebaut (E40). „Jetzt bauen“ speichert vorher und baut immer. Bei einem Konflikt wird weder gespeichert noch gebaut
- Editor-Konflikt: zwei Wahlmöglichkeiten mit Sicherung, **kein automatisches Zusammenführen** (E28). Sicherungen liegen in den App-Daten, nicht im Projekt, und werden nicht aufgeräumt
- Editor: Welche Dateien nur lesbar sind (siehe Schritt 5). Dateien in `inputs/` darf der Nutzer bearbeiten, der Agent laut `AGENTS.md` nicht
- Messen: eigener Modus über den Knopf „Messen“ (Klicks wählen dann Punkte, Kanten und Flächen statt Bauteile). Die wichtigste Angabe eines Paars ist der Abstand paralleler Ebenen, dann der paralleler Achsen, dann vom Punkt aus der zur Ebene, Achse oder Geraden (jeweils unbegrenzt gedacht), zwischen zwei Punkten ihr Abstand, sonst der kürzeste Abstand. Punkt zu Punkt nutzt die Klickpunkte, exakt auf die Elemente gelegt. Punkte haben Vorrang vor Kanten, Kanten vor Flächen. Mittelpunkte von Kreisen sind keine eigenen Punkte, sie stecken im Abstand der Mittelpunkte
- Messen: Messlinien kommen nicht mit ins Bild der Markierung (ohne ihre Beschriftung wären sie dort unverständlich). Einen Messbefehl für den Agenten (`soma measure`) gibt es noch nicht, der Agent bekommt Messungen über „An Agent geben“
- Messen: Die Geometrie liegt als BREP neben dem GLB (Größe etwa wie die STEP-Datei) und wird bei jedem Build ersetzt
- Ansichtswürfel: Ein Klick dreht nur, Drehpunkt und Abstand bleiben (kein Einpassen, damit man nah an einer Stelle bleiben kann). Einpassen und Standardansicht setzen den Drehpunkt zurück in die Mitte. Die Achsen haben die in CAD üblichen Farben (X rot, Y grün, Z blau), außerhalb der festen Farbbedeutungen der Oberfläche
- Drehpunkt per Doppelklick (auch im Messmodus), Zoomen zur Mausposition immer an
- Gruppen (E42): Import mit Struktur über eine eigene Funktion `import_assembly()`, `import_step()` fasst die Datei weiter zu einem Körper zusammen. Die oberste Baugruppe der Datei heißt wie im `add_part`-Aufruf. Alle Teile einer Baugruppe verweisen auf die Zeile dieses Aufrufs
- Transparenz einzelner Teile bleibt über neue Builds erhalten, geht aber wie das Ausblenden beim Öffnen verloren (nicht gespeichert)
- Schnitt: eine Ebene (kein Mehrfachschnitt, kein Schnitt nur durch ausgewählte Teile), Karte unten rechts. Anfangs mitten durchs Modell, weggeschnitten die Seite der Standardansicht. Bei „Fläche“ nur ebene Flächen, anfangs mitten durch deren Bauteil. Die Schnittfläche selbst ist nicht messbar, Messen geht über die Kontur. Der Schnitt wird nicht gespeichert
- Schnitt, Darstellung: Füllung in der abgedunkelten Bauteilfarbe mit Schraffur im Bildraum (Abstand und Breite fest in Pixeln), keine Füllung bei transparenten Teilen und Referenzen
- Skills (E17): Ablage in `.soma/skills/` wie in Abschnitt 4 (E17 nennt `skills/`). Inhalt englisch, Oberfläche deutsch. Die drei mitgelieferten Skills sind Entwürfe, ihre Werte (Wandstärken, Bohrungen, Senkungen, Einschmelzmuttern) sind übliche Richtwerte, keine Normauszüge
- Skills: Die Kopie im Projekt bleibt beim Update der App, wie sie ist (gilt für das Modell, wandert mit). Aus- und Einschalten übernimmt die neue Fassung, die alte kommt in die Sicherung. Einen eigenen Knopf „Aktualisieren“ gibt es nicht
- Skills: Nach dem Schalten fügt die App nichts von selbst in die Eingabe des Agenten ein, nur auf „An Agent geben“

- Rolle `reference` und ihre Standardwerte (E34)
- Hinweis beim ersten Start, dass der Agent mit den Rechten des Nutzers läuft (E29)
- Die fünf Robustheitsregeln in Abschnitt 9
- `project.json` bei Verlust automatisch aus der App-Kopie wiederherstellen und anzeigen, oder nur melden (E27, E28)
- Auto-Start des Agenten ohne Resume so verstanden, dass der Start bleibt (E19)
- App-Icon auf einer Graphit-Fläche mit runden Ecken, kleine Größen mit dickerem Strich und größerem Zeichen (E44)

**Zu klären**

- **Namen:** Notizdatei `NOTES.md`, Ordner `exports/` (Ort, getrackt oder nicht)
- **Lizenz** der Software und Prüfung aller Komponenten
- **Mittelbereich:** Tab-Umschaltung oder geteilte Ansicht zwischen Viewer und Sketch (E15)
- **Build:** Auto-Build standardmäßig an oder aus, Statusanzeige, Fehlerpanel, Verhalten bei erneuter Änderung während des Builds (E20)
- **Speichern/Öffnen:** mehrere Projekte parallel (bisher eines pro Fenster), Aufräumen alter Workspaces und Sicherungen, ZIP auf Netzlaufwerk (Speichern dorthin geht, Verhalten bei Verbindungsverlust ungetestet), ZIP-Größe bei langen Verläufen und vielen Markierungen (je Bild einige hundert KB) (E21)
- **Git:** Einbettung und Updates des Git-Binaries (E31), Verhalten bei sehr langen Verläufen (die Leiste zeigt bisher bis zu 500 Stände), Umschreiben des Verlaufs durch den Agenten trotz Verbot (die Leiste bleibt tolerant, es gibt nur eine Meldung bei fehlendem Repository, losem HEAD oder anderem Branch)
- **Pakete:** Offline-Fall, Paketcache, Verhalten ohne Internet beim Öffnen (E25). Versionen fest pinnen (ein ungepinnter Install zieht inkompatible OCP- und multimethod-Versionen)
- **Plattformen:** Phase 0 lief nur unter Windows. Python-Bundling, Bibliothekspfade und Wheels auf macOS und Linux sind ungetestet (E2)
- **Echte Fremddateien:** Herstellerplatinen und große Baugruppen mit Stückliste in Phase 1 testen
- **Netzlaufwerke (Windows):** Liegt das Programm auf einem Netzlaufwerk, starten die sandboxed Prozesse von Electron nicht. Die installierte App muss lokal liegen, Fehlermeldung ist vorhanden. Klären, wie der Installer damit umgeht und ob Firmenrechner mit umgeleiteten Profilen Probleme machen
- **Updates:** Regeln für alte und neuere `api_version`, Auto-Update der App, Signierung (E36)
- **Format** von `model.map.json` (Entwurf `version 0` aus Phase 0 steht) und der Ausgabe von `soma check`
- **Toleranz des Meshers:** Feste 0,05 mm passt für kleine Teile, große brauchen eine an der Größe orientierte Toleranz (siehe Leistungsmessung)
- **Auswahlen des Agenten:** Flächen-IDs gelten nur pro Build, Verweise brauchen Bauteilname plus Geometrieangabe
- **Inhalte** von `AGENTS.md` und den Skills, mit einem echten Agenten zu testen
- **Projekt-Check:** Umfang und Spezifikation, Abdeckung aller Störfälle

## 12. Größte Risiken

| Risiko | Warum | Gegenmaßnahme |
|---|---|---|
| STEP-Namen mit CadQuery | **Erledigt in Phase 0:** Namen, Farben, Alpha bleiben erhalten. Nicht-ASCII-Namen werden zerstört | ASCII-Namen in der STEP, Anzeigename in `model.map.json` |
| Codequalität der Agenten mit CadQuery | Verkettete API mit verstecktem Zustand, halluzinierte Aufrufe | Strikte Idiome in `AGENTS.md`, Beispiele, Feedback-Loop (bauen, messen, rendern) |
| Agenten ignorieren die Konventionen | Nicht jeder Agent folgt `AGENTS.md` oder Verweisen | Robustheit (Abschnitt 9), Agent-Test in Phase 1 |
| Klick auf Fläche und Code | Kein Framework liefert Flächen-IDs oder Zeilenbezug | **In Phase 0 bestätigt** mit eigenem Mesher und Hilfsbibliothek. Verknüpft wird der `add_part`-Aufruf (E10), nicht die Entstehungszeile der Fläche |
| Installationsgröße und Einbettung | **Gemessen:** OCP hängt hart an VTK, installiert 0,76 bis 1,04 GB | Vorerst hingenommen (E37). Später: Casadi und VTK-Teilmenge prüfen, Komprimierung |
| Nur Windows getestet | Bundling und Bibliotheken auf macOS und Linux ungeprüft, E2 verlangt alle drei | Früh in Phase 1 auf macOS und Linux nachziehen |
| Modellgröße und Buildzeit | Große Teile brauchen 8 bis 10 s (Meshen in OCC), feine Toleranz bis 30 s | Auto-Build abschaltbar (E20), Toleranz nach Bauteilgröße |
| Chats bei ZIP-Weitergabe | Agenten speichern Historie außerhalb des Projekts | Bewusst akzeptiert (E5) |
| Git für Nicht-Programmierer | Agent und App teilen sich ein Repo | Nur Vorschau und Wiederherstellen als neuer Commit (E35), App-Schreibvorgänge serialisiert, Sicherung vor Wiederherstellung. **Umgesetzt und getestet**, Claude Code committet laut erstem Test selbst. Lange Sitzungen und andere Agenten sind ungeprüft |
