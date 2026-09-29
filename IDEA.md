# Ursprungsidee: CAD-IDE mit KI-Agenten

> Stand: 2026-09-29 · Status: Ursprungsidee (Konzeptphase, noch keine Umsetzung)

## 1. Kurzbeschreibung

Ein Desktop-Programm für CAD-Arbeit zusammen mit KI-Agenten. Der Nutzer entwirft 3D-Modelle im Dialog mit einem Coding-Agenten, der Code (z. B. CAD-Skripte) schreibt und ausführt. Das Ergebnis ist ein 3D-Modell (STEP), das direkt im Programm angezeigt, geprüft und per Feedback iterativ verbessert wird.

Technisch ist das Programm im Kern eine **IDE mit integrierter Konsole**, in der der Nutzer den Coding-Agenten seiner Wahl laufen lässt (Claude Code, OpenCode, …). Darum herum liegen CAD-spezifische Werkzeuge und ein Workflow, der sich wie 3D-Modellierung anfühlt, nicht wie Softwareentwicklung.

## 2. CAD-Grundlage: Code-basierte CAD-Frameworks

Die 3D-Modelle entstehen **per Code** mit einem Coding-CAD-Framework. Der Agent schreibt und ändert das Skript, das Skript erzeugt die STEP-Datei, der Viewer zeigt sie an.

Das Framework ist **fest vorgegeben** (kein Wechsel durch den Nutzer). Das vereinfacht Konventionen, `CLAUDE.md`/`AGENTS.md`, Skills und das Mapping zwischen Viewer und Code. **Welches Framework das ist, ist noch offen und muss geprüft werden.** Kandidaten: CadQuery (Favorit, da bereits im Fokus), build123d, OpenSCAD u. a.

## 3. Grundprinzip: Kein eigener Harness

Wir bauen **keinen eigenen Agenten-Harness**, sondern nutzen bestehende (Claude Code, OpenCode, …) in einer eingebetteten Konsole.

**Vorteile**
- Deutlich weniger Entwicklungsaufwand: Agentenlogik, Tool-Use, Kontextverwaltung usw. kommen fertig mit.
- Maximale Flexibilität: Der Nutzer wählt den Agenten, den er kennt, bezahlt oder bevorzugt.
- Wir profitieren automatisch von der Weiterentwicklung der Harnesses.

## 4. Abgrenzung zu einer normalen IDE (z. B. VS Code)

Was macht das Projekt mehr als „VS Code mit Terminal"? Sieben Kernunterschiede:

### 4.1 Workflow: „3D-Modell" statt „Code-Projekt"

- Ein „Projekt" ist eine **einzelne ZIP-Datei**, die frei verschoben, geteilt und archiviert werden kann.
- Beim Neuanlegen wird zunächst in einem **temporären Verzeichnis** gearbeitet, bis der Nutzer das Modell speichert.
- Beim Speichern wird der Projektordner als ZIP abgelegt.
- Beim Öffnen wird **derselbe Temp-Ordner (gleicher Pfad) wiederhergestellt**. Dadurch bleiben Chatverläufe und Konfigurationen der KI-Agenten erhalten – diese werden von den Harnesses meist separat und mit Referenz auf den Arbeitsordner gespeichert.
- Für den Nutzer fühlt es sich an wie „ein 3D-Modell erstellen und speichern", nicht wie „ein Coding-Projekt starten".

### 4.2 Integrierte Agenten-Anweisungen (`CLAUDE.md` / `AGENTS.md`)

- Eine mitgelieferte, von der Software verwaltete Anweisungsdatei erklärt dem Harness, wie er vorgehen soll, welche Möglichkeiten es gibt und welche Konventionen gelten.
- Sie definiert u. a. die **Struktur von Code und Ausgabedateien** – Voraussetzung für viele weitere Funktionen der Software.

### 4.3 Integrierter 3D-Viewer

- Zeigt die **STEP-Datei direkt** an.
- Objekte ein-/ausblenden, Visualisierungsoptionen.
- **Messfunktionen** (Nachmessen am Modell).
- Wenn möglich: **Objekt im Viewer anklicken → zugehörige Codestelle wird im Editor hervorgehoben** (Rückverfolgung Geometrie → Code).
- **Screenshots** des Viewers mit einem Klick speichern und **in diesen Bildern skizzieren/markieren**, um dem Agenten visuell mitzuteilen, was geändert werden soll.

### 4.4 2D-Sketching-Tool

- Freihandzeichnen, geometrische Formen, Text usw.
- Dient als visuelle Kommunikation mit dem Agenten (Skizzen, Anmerkungen, Vorlagen).

### 4.5 Feste Dateistruktur und Namenskonventionen

- Ein fest definiertes Layout im Projekt, damit die Software Inhalte eindeutig zuordnen kann.
- Beispiel: Die Software weiß immer, **welches das Skript** ist und **welche die Haupt-Ausgabedatei** ist.

### 4.6 Skills (weitere Markdown-Dateien)

- Regelwerke für spezifische Anforderungen, z. B. **3D-Druck** und **Toleranzen**.
- Werden nur angewendet, wenn der Nutzer sie für das Modell aktiviert hat.

### 4.7 Integrationen mit gängigen KI-Harnesses (wenn möglich)

- Z. B. markierter Code, Viewer-Auswahl oder Screenshots werden **direkt in den Chat des Agenten übernommen**.
- Ziel: nahtlose Zusammenarbeit zwischen Editor/Viewer/Sketching und dem Agenten.

## 5. Überblick der Bausteine

| Baustein | Zweck |
|---|---|
| Code-Editor | Skripte ansehen und bearbeiten |
| Eingebettete Konsole | Beliebiger Coding-Agent (Claude Code, OpenCode, …) |
| 3D-Viewer (STEP) | Anzeigen, Messen, Ein-/Ausblenden, Auswahl, Screenshots |
| 2D-Sketching | Skizzen und Markierungen als Feedback an den Agenten |
| Projektverwaltung | Temp-Ordner ⇄ ZIP, wiederherstellbarer Arbeitskontext |
| Agenten-Anweisungen | Integrierte `CLAUDE.md`/`AGENTS.md` mit Konventionen |
| Skills | Zuschaltbare Regelwerke (3D-Druck, Toleranzen, …) |
| Harness-Integrationen | Auswahl/Screenshots direkt in den Agenten-Chat |

## 6. Offene Punkte für die nächste Phase

Nicht Teil der Ursprungsidee, aber absehbar zu klären:

- Technologiewahl (Desktop-Framework, Terminal-Einbettung, Editor-Komponente, 3D-Kernel/Viewer für STEP).
- **Framework-Evaluation:** Welches Coding-CAD-Framework wird das feste Framework (CadQuery, build123d, OpenSCAD, …)? Mögliche Kriterien: Qualität des Agenten-generierten Codes, STEP-Export, Möglichkeit zur Zuordnung Geometrie ⇄ Code (Namen/Labels/Assemblies), Reife und Community, Lizenz, Verteilbarkeit mit der Software (Python-Einbettung), Performance.
- Mapping Geometrie ⇄ Code (wie werden Objekte im STEP identifizierbar mit Codestellen verknüpft?).
- Konkrete Ordnerstruktur und Namenskonventionen im Projekt.
- Wie stabil und portabel ist die Wiederherstellung des Temp-Pfads (Pfadabhängigkeit der Agenten-Chatverläufe)?
- Schnittstellen der einzelnen Harnesses für Integrationen (Kontext einfügen, Bilder übergeben).
