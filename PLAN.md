# Plan: CAD-IDE mit KI-Agenten

> Stand: 2026-09-29 · Status: **Phase 0 abgeschlossen** ([Ergebnisse](prototype/phase0/ERGEBNISSE.md)), **Phase 1 läuft** (Schritte 1 bis 3 erledigt, siehe Abschnitt 10 und [app/README.md](app/README.md))
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
      CLI-Agent (Claude Code, …)     Paket `cadide` (Basisumgebung)
      nutzt `cadide build|check|export`  Hilfsbibliothek + CLI
```

- **Desktop:** Electron, TypeScript (E23). Editor: Monaco oder CodeMirror (offen).
- **Python-Dienst:** Pro Projekt ein langlebiger Prozess für die App (schnelle Messungen, Modell im Speicher). Der Build-Befehl des Agenten läuft zusätzlich als eigenständiger Einmal-Prozess und funktioniert auch ohne App (E24).
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
├── .cadide/
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

**Projektzustand (E27):** ID und Einstellungen liegen doppelt: in `.cadide/project.json` (ZIP) und als Kopie in den App-Daten. Bei Verlust dient die jeweils andere Quelle als Rückfall.

## 5. Hilfsbibliothek und Befehle (`cadide`)

Das Paket `cadide` liegt in der mitgelieferten **Basisumgebung**, nicht im Projekt. Neue App-Versionen bringen es mit, alte Projekte profitieren von Fixes. `api_version` in `project.json` sichert die Abwärtskompatibilität (E36). Die Namen sind Arbeitsnamen.

| Baustein | Aufgabe |
|---|---|
| `add_part("Deckel", obj, role=...)` | Bauteil registrieren (verbindlich, E10). Merkt sich Datei und Zeile, schreibt Namen und Farbe in den STEP-Baum, Positionen und Anzeigename in `model.map.json`. **Namen in der STEP nur ASCII** (Umlaute werden umgeschrieben, sonst zerstört der Export sie), Namen müssen eindeutig sein. Rolle `reference` ist eine Markierung (halbtransparent, eigener Ast, nicht in `--all`) |
| `cadide build` | Baut STEP, GLB und Mapping in einem Lauf. Gemeinsam für App und Agent. Führt vorab einen kurzen Check aus und gibt Warnungen mit aus (E20) |
| `cadide check` | Prüft die Projektstruktur und **meldet nur**, mit konkreten Handlungshinweisen, auch maschinenlesbar. Kein `--fix`. Der Agent repariert nach eigenem Ermessen (E28) |
| `cadide export <Bauteil\|--all> --format …` | Einzelexport auf Basis der registrierten Bauteile, auch per Kontextmenü im Tree. Formate (in Phase 0 geprüft): STEP, STL, 3MF, AMF, BREP, IGES, OBJ, VRML, GLB/GLTF. 2D: DXF (Schnitt), SVG (Projektion) (E34) |

**Bauen (E20):** Auto-Build bei Änderung von `model.py` und `parts/` (Hintergrund, Debounce, abbrechbar). Er ist **abschaltbar**, weil große Modelle sonst die App bremsen. Dann baut der Nutzer per Knopf oder der Agent per Befehl.

**Pakete (E25):** Die Basisumgebung bleibt unverändert. Jedes Projekt hat eine eigene Umgebung im Arbeitsordner (nicht in der ZIP), die die Basis sieht. Jedes Terminal startet mit **aktivierter Projektumgebung im PATH**, der Agent nutzt normales `pip`. Die App liest die Pakete per `pip freeze` aus und pflegt `requirements.txt`. Auf einem anderen Rechner wird die Umgebung daraus neu aufgebaut.

## 6. Agenten-Anbindung

- **Terminal (E19):** Freies Terminal mit mehreren Tabs im Projektordner. Startbuttons für erkannte Agenten. Der zuletzt benutzte Agent startet beim Öffnen automatisch, **ohne Resume**. Der Nutzer installiert den Agenten selbst, die App hilft mit Erkennung und Hinweisen (E4).
- **`AGENTS.md` (E18):** Ganz app-verwaltet, Notizen stehen getrennt in `NOTES.md`. Beim Öffnen eines Projekts mit älterer Regelversion wird sie erneuert, dem Nutzer angezeigt und als Commit gesichert (E36). Der Verweis auf die Notizen steht ganz oben.
- **Skills (E17):** Markdown-Regeln (z. B. 3D-Druck, Toleranzen, Gehäusebau), pro Projekt aktivierbar. Aktivierte Skills liegen in `.cadide/skills/` und stehen mit vollem Pfad in `AGENTS.md`. Zunächst nur mitgelieferte, eigene Nutzer-Skills später.
- **Rückmeldung an den Agenten (E11):** Screenshots, Skizzen und Auswahlen (Bauteilname, Datei, Zeilen) landen als Datei in `.cadide/feedback/`. Die App fügt Pfad oder Text in die Eingabezeile des Terminals ein, der Nutzer schickt selbst ab. Später kommt ein MCP-Server der App dazu.

## 7. Oberfläche und Viewer

**Layout (E15, E38, Entwurf in [design/ui-entwurf.html](design/ui-entwurf.html)):** Das Modell ist die Hauptsache, der Viewer bekommt die größte Fläche. Die **Bauteilliste schwebt als Karte** oben links im Viewer, daneben die Werkzeuge, rechts der Ansichtswürfel, unten links die Auswahl mit Codeausschnitt. Eine schmale **Leiste links** klappt die Panels *Dateien* und *Code* aus (immer nur eins). Rechts der **Agent-Bereich** mit Tabs, einklappbar, darunter die **Übergabeleiste** (Auswahl, Markierung, Build-Fehler in die Eingabe des Agenten). Die **Kopfzeile** zeigt Zustände: Modellname als Dokumentmenü, Speicherstand, Build-Anzeige mit Auto-Build, dazu Exportieren und Speichern. Die **Verlaufsleiste** sitzt unter dem Viewer. Eine Startseite zeigt Modelle, erkannte Agenten und den Hinweis auf die Rechte des Agenten.

**Viewer (E22, E33):**

| Phase | Funktionen |
|---|---|
| **Phase 1 (MVP)** | Navigation, Standardansichten, Darstellungsmodi (schattiert, Kanten, Drahtgitter, Transparenz), Ein-/Ausblenden über den Tree, Klick auf Bauteil → Codezeile, **Screenshot mit Markup** |
| **Danach** | Messen (Punkt-zu-Punkt, Bounding-Box, exakte Werte), Schnittansicht (wichtig für Gehäuse), Versions-Schieber |
| **Später** | Volumen/Gewicht, Versionsvergleich, Explosionsansicht |

Der Viewer zeigt auch **beliebige weitere STEP-Dateien** im Basismodus, ohne Mapping und Zusatzfunktionen. Standardanzeige ist immer das Hauptmodell.

**2D-Sketching (E16):** Nur Bild-Markup ohne Maßhaltigkeit auf Viewer-Screenshots und leerer Fläche (Freihand, Formen, Pfeile, Text). Ergebnis ist ein PNG. Kein Constraint-Sketcher.

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
| `.cadide/` oder `project.json` gelöscht | ID und Einstellungen weg | Aus App-Daten bzw. ZIP wiederherstellen (siehe offene Punkte) |
| `.git` gelöscht, neu initialisiert, History umgeschrieben, anderer Branch | Zeitleiste kaputt | Zeitleiste tolerant aus `git log`, Bruch im Check melden |
| Agent committet nie oder zu oft, riesige Dateien | Leerer Schieber, große ZIP | Auto-Snapshot, Größenwarnung |
| `inputs/` verändert | Mitgebrachte Datei verfälscht | Git-Stand, Hinweis |
| Build hängt oder dauert endlos | App blockiert | Timeout, Abbrechen, Dienst neu starten |
| Agent arbeitet außerhalb des Projektordners | Ergebnisse fehlen in der ZIP | Nicht verhinderbar, wo möglich erkennen |
| Python-Dienst stürzt ab | Viewer/Messen tot | Automatischer Neustart, Meldung |

## 10. Phasen

**Phase 0: technischer Prototyp ohne App (E13, E14). Abgeschlossen**, alle Punkte bestanden. Details und Zahlen in [ERGEBNISSE.md](prototype/phase0/ERGEBNISSE.md), Code und Tests in `prototype/phase0/`:

1. **STEP mit Namen und Farben:** `cq.Assembly.export` genügt, kein eigener XCAF-Export nötig. Nicht-ASCII-Namen werden beim Export zerstört, daher ASCII-Namen in der STEP.
2. **GLB mit Flächen-IDs:** eigener Mesher (rund 150 Zeilen), alle IDs gegen OCC verifiziert. Die IDs gelten nur für einen Build. Der Python-Anteil ist nicht der Engpass, das Meshen in OCC ist es.
3. **Klick → Datei und Zeile:** in echtem Browser bestanden, auf Ebene von Bauteil und Fläche. Verknüpft wird der `add_part`-Aufruf mit Zeilenbereich.
4. **Fremd-STEP, Messen, Aussparung, Referenz:** bestanden, Abstände und Radien exakt über die IDs. Der Basismodus für fremde STEP-Dateien funktioniert. Getestet nur mit synthetischer Platine.
5. **Umgebung:** VTK lässt sich nicht entfernen (OCP hängt hart daran). Installiert 0,76 bis 1,04 GB, vorerst hingenommen (E37).
6. **Exportformate:** 12 Formate, PLY und X_T entfallen.

**Phase 1: MVP-Kern als Desktop-App. In Arbeit.** Projekt neu, speichern und öffnen als ZIP mit Git. Editor, Terminal mit Agent, Viewer (Umfang siehe Abschnitt 7), Screenshot mit Markup, `AGENTS.md`, `cadide build`. Hier folgt auch der **Agent-Test**: Ein Agent baut mit erster `AGENTS.md` und Hilfsbibliothek ein Beispielmodell, geprüft wird u. a., ob er den Verweisen folgt.

*Schritt 1, lauffähiges Gerüst (erledigt, Ende-zu-Ende-Test mit 21 Prüfungen in `app/test/smoke.mjs`):*

- **App:** Electron und TypeScript, Layout aus Abschnitt 7 (Tree mit Reitern *Modell* und *Dateien*, Viewer, Terminal-Tabs, Top Bar, Statusleiste, verschiebbare Trennleisten). Arbeitsordner unter `<App-Daten>/workspaces/<uuid>/`, Projektzustand doppelt (E27), Projekt-Check meldet nur (E28).
- **`cadide` (Python-Paket in `python/`):** `add_part` mit Datei und Zeilenbereich, `cadide build` (STEP, GLB, Mapping, `build.json`), `cadide export` (12 Formate). Fehler in `model.py` (Syntax, Laufzeit, doppelter Name, kein Bauteil, Einstiegspunkt fehlt) kommen mit Datei, Zeile und gekürztem Traceback zurück, der letzte gute Stand bleibt sichtbar.
- **Build (E20):** Auto-Build beim Speichern, entprellt, abschaltbar. Änderungen während eines Builds führen zu genau einem Folgebuild. Zeitlimit und Abbruch sind eingebaut.
- **Viewer:** Klick liefert Bauteil, Fläche und markierte Codezeile. Ein- und Ausblenden, Standardansichten, Kanten, Drahtgitter, Transparenz. Kamera, Sichtbarkeit und Auswahl bleiben über Rebuilds erhalten.
- **Terminal:** Echte Shell (node-pty) im Projektordner mit `python`, `pip` und `cadide` der Basisumgebung im PATH. Startbuttons für erkannte Agenten (Claude Code, OpenCode, Codex, Gemini CLI).
- **Vorlage:** `model.py`, erste `AGENTS.md`, `CLAUDE.md` (Verweis), `NOTES.md`, `.gitignore`.

*Erster Agent-Test (informell, vom Nutzer):* Claude Code hat mit dieser Vorlage eine Wanduhr gebaut, 6 Bauteile mit deutschen Namen, Parameter als Konstanten, kein `.venv`, `AGENTS.md`, `CLAUDE.md`, `NOTES.md` und `.gitignore` unverändert. Das ist ein Datenpunkt, kein vollständiger Agent-Test. Damals gab es noch kein Git, das Committen des Agenten ist deshalb noch ungeprüft.

*Schritt 2, Git und ZIP (erledigt, 46 Prüfungen in `app/test/versions.mjs`):*

- **Git pro Projekt:** Repository mit Startcommit, Identität und `core.autocrlf=false` gesetzt, damit auch der Agent committen kann. Die `AGENTS.md` verlangt Commits nach gebauten Iterationen und verbietet Umschreiben des Verlaufs.
- **Speichern (E8, E21):** Strg+S baut bei Bedarf zuerst neu, legt einen Auto-Snapshot an (nur bei Änderungen an Quelltext, Eingaben oder Einstellungen) und schreibt die ZIP atomar (erst `.part`, dann umbenennen). Sie enthält `.git`, aber keine Umgebungen und Caches. Ein Marker `.cadide/zip-info.json` hält den gespeicherten Stand fest. Der Modellname folgt dem Dateinamen. Ohne `.git` klappt Speichern weiter, mit Warnung.
- **Öffnen (E21):** Fehlt der Arbeitsordner (anderer Rechner), wird die ZIP entpackt. Ist er identisch, wird er einfach geöffnet. Weicht er ab, fragt die App: *Arbeitsstand behalten* oder *ZIP laden*, dabei wandert der alte Arbeitsordner nach `workspace-backups/`, nichts wird gelöscht. Entpacken ist gegen bösartige Pfade abgesichert (zwei Schichten).
- **Absturz-Wiederherstellung:** Der Arbeitsordner liegt fest in den App-Daten, die App öffnet beim Start das letzte Projekt. Ungespeicherte Änderungen überleben einen harten Abbruch (getestet). Beim Schließen mit ungespeicherten Änderungen fragt die App (nicht automatisch getestet).
- **Verlauf (E35):** Leiste unter dem Viewer, jeder Commit ein Punkt plus der Arbeitsstand, Schieber und Klick. Alte Stände sind eine schreibgeschützte Vorschau (STEP per `git show`, Basismodus). *Stand wiederherstellen* legt einen neuen Commit an und sichert vorher ungesicherte Änderungen als eigenen Stand. Kein Checkout, kein Reset, keine Branches.
- **Robustheit (E28):** App-eigene Git-Schreibvorgänge laufen nacheinander und wiederholen sich bei `index.lock`, lesende Aufrufe nehmen keine Sperren. Ohne `.git` meldet der Verlauf das verständlich und bietet **keine** automatische Reparatur an.

*Schritt 3, Oberfläche nach Entwurf (erledigt, E38; 31 Prüfungen im Smoke-Test, 50 im Verlaufstest, 4 Einheitentests in `app/test/unit.mjs`):*

- **Kopfzeile:** Dokumentmenü (Neu, Öffnen, zuletzt geöffnete Modelle, Speichern unter, im Explorer zeigen, Startseite), Speicherstand („Nicht gespeichert · zuletzt 13:41“), Build-Anzeige in den Zuständen gebaut, baut (mit Abbrechen), fehlgeschlagen (mit Zeile) und „Code geändert“ bei ausgeschaltetem Auto-Build. Schaltet man Auto-Build wieder ein, baut die App den veralteten Stand gleich nach. Kurzbefehle Strg+S, Strg+Umschalt+S, Strg+O, Strg+N, Strg+B (nicht im Terminal).
- **Viewer:** schwebende Bauteilkarte mit Auge, Suche, Referenzen-Abschnitt und Kontextmenü (Isolieren, Ausblenden, Kamera, Code zeigen, An Agent geben, Exportieren). Auswahlkarte mit Flächenart und Codeausschnitt. Fehlerkarte mit Meldung, Codezeile und Ablauf, das Modell bleibt gedimmt sichtbar. Ansichtswürfel (Oben, Vorne, Rechts), Einpassen, Standardansicht, Darstellungsmenü.
- **Export (E34):** Menü mit allen 12 Formaten, für alle Bauteile oder die Auswahl, über `cadide export` nach `exports/`.
- **Dateien und Code:** Dateibaum mit eingeklappten App-Dateien. Dateien, die man ins Fenster zieht, landen in `inputs/`, Vorhandenes wird nie überschrieben (E33). Code-Panel zum Lesen mit Hervorhebung, der Auswahl im Viewer folgend.
- **Verlauf:** Punkte unterscheiden Stände der App (Commit-Trailer `Erstellt-von: CAD-IDE`) und des Agenten, der gespeicherte Stand ist grün, die Vorschau violett mit Rahmen um den Viewer.
- **Agent-Bereich:** Tabs mit Laufanzeige, „+“ startet erkannte Agenten oder ein leeres Terminal, einklappbar. Die Übergabeleiste fügt Text in die Eingabe ein (als Einfügen, ohne Enter, E11).
- **Startseite** beim allerersten Start und über das Logo: Neu, Öffnen, zuletzt geöffnete Modelle mit Vorschaubild, erkannte Agenten, Hinweis auf die Rechte des Agenten (E29).
- **Schrift:** IBM Plex Sans und Mono liegen lokal bei (SIL Open Font License).

*Offen in Phase 1:* Projektumgebung mit `pip freeze` und `requirements.txt` (bisher landet `pip install` noch in der gemeinsamen Basisumgebung), Editor zum Bearbeiten (bisher nur Lesen), Screenshot mit Markup (Knopf „Markieren“ und „Markierung einfügen“ sind schon da, aber noch ausgegraut), Auto-Start des Agenten ohne Resume, vollständiger Agent-Test (mit Git-Commits), Bündelung von Python und Installer, macOS und Linux.

**Danach:** Messen, Schnittansicht, Versions-Schieber, Skills, `cadide check` und Projekt-Check, MCP-Server. **Später:** Volumen/Gewicht, Versionsvergleich, Explosionsansicht, eigene Nutzer-Skills, maßhaltiger Sketcher (nur bei Bedarf).

## 11. Offene Punkte

**Noch nicht ausdrücklich bestätigt (Vorschläge von mir)**

- `AGENTS.md` und die Kommentare der Vorlage sind **auf Englisch** (Agenten befolgen englische Anweisungen zuverlässiger), die Oberfläche ist deutsch
- App-Daten liegen unter Windows in `%LOCALAPPDATA%\cadide`, nicht im Roaming-Profil (Arbeitsordner und Caches gehören nicht ins Netz)
- Beim Öffnen eines Projekts wird sofort gebaut, damit der Viewer nicht leer ist. Beim Anlegen läuft vor dem Startcommit ein Build (rund 2 s Wartezeit bei „Neu“)
- Der Modellname folgt dem Dateinamen der ZIP
- Speichern baut vorher neu, wenn der Quelltext neuer ist als das letzte Ergebnis, und wartet auf laufende Builds
- Die ZIP enthält `.git` und Feedback-Bilder, aber weder Umgebungen noch GLB-Cache, Mapping und `build.json`
- Ohne `.git` gibt es **keinen** Knopf „Verlauf neu anlegen“, nur die Meldung (sonst widerspricht es E28). Offene Frage: Für Nicht-Programmierer wäre ein ausdrücklicher Knopf freundlicher
- Änderung während eines Builds: laufenden Build fertig laufen lassen, danach genau ein weiterer (statt abbrechen und neu starten)
- Oberfläche (E38): Funktionen, die noch fehlen (Messen, Schnitt, Markieren, Skills, Pakete, Hilfe, Optionen), stehen schon ausgegraut mit Hinweis da. Nur dunkles Farbschema. Das „⋯“-Menü aus dem Entwurf entfällt (alles steht im Dokumentmenü)
- Dateien, die man irgendwo ins Fenster zieht, landen in `inputs/` (Electron würde sie sonst als Seite öffnen). Bei gleichem Namen „name (2).ext“
- Die Startseite erscheint nur beim allerersten Start und über das Logo. Sonst öffnet die App wie bisher das letzte Modell
- „An Agent geben“ fügt eine Zeile wie `[Auswahl: Bauteil "Lid", model.py Zeile 31, angeklickte Fläche: eben, …]` ein. Zahlen mit Punkt, damit der Agent sie eindeutig liest
- `exports/` ist nicht in der `.gitignore` der Vorlage und zählt damit als Änderung (Ort und Tracking sind noch offen, siehe unten)

- Rolle `reference` und ihre Standardwerte (E34)
- Hinweis beim ersten Start, dass der Agent mit den Rechten des Nutzers läuft (E29)
- Die fünf Robustheitsregeln in Abschnitt 9
- `project.json` bei Verlust automatisch aus der App-Kopie wiederherstellen und anzeigen, oder nur melden (E27, E28)
- Auto-Start des Agenten ohne Resume so verstanden, dass der Start bleibt (E19)

**Zu klären**

- **Namen:** Software, Befehl `cadide`, Notizdatei `NOTES.md`, Ordner `exports/` (Ort, getrackt oder nicht)
- **Lizenz** der Software und Prüfung aller Komponenten
- **Mittelbereich:** Tab-Umschaltung oder geteilte Ansicht zwischen Viewer und Sketch (E15)
- **Build:** Auto-Build standardmäßig an oder aus, Statusanzeige, Fehlerpanel, Verhalten bei erneuter Änderung während des Builds (E20)
- **Speichern/Öffnen:** mehrere Projekte parallel (bisher eines pro Fenster), Aufräumen alter Workspaces und Sicherungen, ZIP auf Netzlaufwerk (Speichern dorthin geht, Verhalten bei Verbindungsverlust ungetestet), ZIP-Größe bei langen Verläufen (E21)
- **Git:** Einbettung und Updates des Git-Binaries (E31), Verhalten bei sehr langen Verläufen (die Leiste zeigt bisher bis zu 500 Stände), Umschreiben des Verlaufs durch den Agenten trotz Verbot (die Leiste bleibt tolerant, es gibt nur eine Meldung bei fehlendem Repository, losem HEAD oder anderem Branch)
- **Pakete:** Offline-Fall, Paketcache, Verhalten ohne Internet beim Öffnen (E25). Versionen fest pinnen (ein ungepinnter Install zieht inkompatible OCP- und multimethod-Versionen)
- **Plattformen:** Phase 0 lief nur unter Windows. Python-Bundling, Bibliothekspfade und Wheels auf macOS und Linux sind ungetestet (E2)
- **Echte Fremddateien:** Herstellerplatinen und große Baugruppen mit Stückliste in Phase 1 testen
- **Netzlaufwerke (Windows):** Liegt das Programm auf einem Netzlaufwerk, starten die sandboxed Prozesse von Electron nicht. Die installierte App muss lokal liegen, Fehlermeldung ist vorhanden. Klären, wie der Installer damit umgeht und ob Firmenrechner mit umgeleiteten Profilen Probleme machen
- **Updates:** Regeln für alte und neuere `api_version`, Auto-Update der App, Signierung (E36)
- **Format** von `model.map.json` (Entwurf `version 0` aus Phase 0 steht) und der Ausgabe von `cadide check`
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
| Git für Nicht-Programmierer | Agent und App teilen sich ein Repo | Nur Vorschau und Wiederherstellen als neuer Commit (E35), App-Schreibvorgänge serialisiert, Sicherung vor Wiederherstellung. **Umgesetzt und getestet**, der Agent-Test mit echten Commits steht aus |
