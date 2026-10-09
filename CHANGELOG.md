# Changelog

Alle nennenswerten Änderungen an SOMA. Aufbau nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionsnummern
nach Major.minor.bugfix (E68). Neues sammelt sich unter „Unveröffentlicht“ und wandert beim Hochzählen der Version in einen
eigenen Abschnitt mit Datum und Git-Tag.

## [Unveröffentlicht]

### Neu

- Einstellungen, Reiter „Viewer“: Mausbelegung wie in SolidWorks, Fusion 360 und Inventor, Onshape, Creo, NX und Blender oder Rhino, mit Legende. Zoomrichtung umkehrbar. Orthografische Ansicht ohne Fluchtpunkte, beim Umschalten bleibt das Bild stehen. Darstellung beim Öffnen eines Modells (Kanten, Drahtgitter, Transparent). Nachkommastellen beim Messen (0 bis 4), der Text für den Agenten behält drei. Alles gilt sofort (E81).
- Einstellungen, Reiter „Storage“: wie viel Platz SOMA auf dem Rechner belegt, aufgeteilt in Modelle, Sicherungen, Vorschau-Cache, Bilder der Startseite und eigene Skills, mit Knopf zum Öffnen des Ordners. Der Vorschau-Cache lässt sich leeren (E81).
- Einstellungen, Reiter „About“: Versionen von SOMA, soma, Python, CadQuery, OCP, Electron und Git, gefundene Agenten, Ordner und alle Komponenten mit Lizenz. „Copy system info“ legt die Angaben für eine Fehlermeldung in die Zwischenablage (E81).

### Geändert

- Im Viewer wählt nur noch ein Klick mit der linken Maustaste aus, nicht mehr auch mit der rechten oder mittleren. So wählt kurzes Drehen oder Verschieben mit diesen Tasten nichts aus.

## [0.3.0] - 2026-10-09

Technische Zeichnungen, eigene Skills, das Dateiformat `.soma` und die DXF-Ansicht.

### Neu

- DXF-Ansicht: DXF-Dateien öffnen per Klick im Dateibaum im Code-Panel, gezeichnet wie die technischen Zeichnungen (Linientypen, Schraffuren, Maße, Texte). Zoomen mit dem Mausrad, Verschieben durch Ziehen, Layer ein- und ausblenden, Größe und Koordinaten unter dem Zeiger. „Mark up view“ gibt den sichtbaren Ausschnitt mit seinen Koordinaten an den Agenten. Ändert der Agent die Datei, zeichnet die Ansicht neu und behält den Ausschnitt. Was sich nicht zeichnen lässt (etwa 3D-Körper), nennt ein Hinweis (E80).
- Eigene Skills: „Settings“ unten in der linken Leiste (bisher ausgegraut) und auf der Startseite öffnet die Einstellungen. Dort lassen sich mitgelieferte Skills ändern und eigene anlegen, duplizieren, aus Markdown-Dateien importieren und löschen. Der Editor mit Vorschau prüft beim Tippen Kopf, Einstellungen und Platzhalter. Eigene Skills gelten für alle Modelle auf diesem Rechner und werden im Panel „Skills“ ein- und ausgeschaltet wie die mitgelieferten. Geänderte mitgelieferte Skills lassen sich jederzeit zurücksetzen, Gelöschtes und Ersetztes kommt in die Sicherung (E78).
- Technische Zeichnungen: Der Agent beschreibt eine Zeichnung in `drawings/*.py` (`soma.drawing`) mit Ansichten, Schnitten, Einzelheiten, Maßen, Texten und Stückliste, `soma drawing build` schreibt PDF und DXF nach `output/drawings/`, alle Blätter zusammen nach `output/drawings.pdf`, und ein Bild, mit dem der Agent sein Ergebnis prüft. Lange Teile lassen sich unterbrochen zeichnen, Schnitte auch mit geknicktem Schnittverlauf. Die Maße werden immer am Modell gemessen, eine Prüfung meldet Überschneidungen von Texten mit Kanten, Maßen und Stückliste, zu lange Einträge im Schriftfeld, Maße neben Kanten und getippte Zahlen. Dazu der Skill „Technical drawings“ mit den Regeln nach ISO (E76).
- Skill „Parametric models“, bei neuen Modellen immer an: Der Agent legt erst fest, was die Größe bestimmt und was beim Ändern stehen bleibt, gibt wenige unabhängige Werte als Parameter frei, leitet den Rest daraus ab und baut das Modell an den Grenzen jedes Bereichs zur Probe. Einstellbar sind die Höchstzahl der Parameter und der Umfang dieser Prüfung (E77).

### Geändert

- Modelle werden als `.soma`-Datei gespeichert statt als `.zip`. ZIP-Dateien öffnet die App weiter. Ein Modell aus einer ZIP wird beim nächsten Speichern als `.soma` daneben abgelegt, die ZIP bleibt. Wer das ganze Modell als ZIP braucht, findet „Everything as ZIP“ im Export-Menü (E79).
- Der Dateibaum zeigt die Kopien der Skills aus `.soma/skills/` als eigene Gruppe „Skills“, eingeklappt und nur zum Lesen. Ein- und ausgeschaltet werden sie weiter im Panel „Skills“.
- Jede Zeile im Panel „Parameters“ zeigt den Bereich, den der Agent gesetzt hat, ohne Aufklappen („30–200 mm“, „3 options“), rot, wenn der Wert außerhalb liegt (E74).
- Kleinere ZIP beim Speichern: Bilder und Videos aus `renders/` kommen nicht mehr mit, und die Versionsgeschichte wird vorher gepackt, sodass ähnliche Fassungen des Modells kaum zusätzlichen Platz brauchen. Am Modellmotor schrumpft der Verlauf von 81 auf 35 MB (E75).

### Behoben

- Im Editor erschien der Kopf eines Skills (zwischen zwei `---`) fett wie eine Überschrift. Er steht jetzt gedämpft als eigener Block.
- Fetter Text im Terminal (etwa Überschriften des Agenten) wirkte wackelig, runde Buchstaben saßen einen Pixel tiefer als gerade. Die App bringt jetzt den echten fetten Schnitt der Terminalschrift mit, statt das Fett nachrechnen zu lassen.
- Skills und andere Markdown-Dateien mit einem Kopf zwischen zwei `---` (Front Matter) zeigten diesen Kopf in der Dokumentansicht als riesige Überschrift. Er steht jetzt klein als Quelltext oben.
- Nach dem Ändern eines Parameters hielten `soma anim` und `soma render --result` Animationen und Ergebnisse noch für aktuell. Jetzt zählt `parameters.json` wie in der App zum Modell (E74).

## [0.2.0] - 2026-10-08

Parameter für den Nutzer, die App auf Englisch, Start auf der Startseite und die Lizenz.

### Neu

- Die App beginnt auf der Startseite. Ein neues Modell, das noch der Vorlage entspricht und nie gespeichert wurde, verschwindet beim Verlassen wieder. Andere Modelle lassen sich auf der Startseite entfernen, der Arbeitsordner kommt in den Papierkorb (E69).
- README auf Englisch mit Bildern für die Startseite des Repos, dazu dieser Changelog (E70).
- Lizenz: GPL-3.0 oder später, Text in `LICENSE` (E71). Die Modelle der Nutzer sind davon frei (`MODEL-EXCEPTION.md`, E72).
- Parameter: Der Agent gibt mit `param()` einzelne Werte frei, etwa Maße, Anzahlen, Optionen oder einen Winkel. Im neuen Panel „Parameters“ ändert man sie selbst, das Modell baut neu. Die eigenen Werte stehen in `parameters.json`, der Wert des Agenten bleibt im Code, und jedes Feld lässt sich auf ihn zurücksetzen. Werte außerhalb des Bereichs werden gemeldet und trotzdem gebaut. Die Vorlage für neue Modelle hat vier Parameter (E74).

### Geändert

- Die App ist jetzt auf Englisch: Oberfläche, Meldungen, Ausgaben und Fehlermeldungen von `soma`, Skills und die Notizen an den Agenten. Zahlen stehen mit Dezimalpunkt. Ältere Modelle öffnen wie bisher (E73).

## [0.1.0] - 2026-10-08

Erste Version mit Nummer. Sie fasst den Stand des Prototyps zusammen.

### Neu

- Desktop-App mit Terminal neben dem 3D-Viewer. Der Agent ist frei wählbar (Claude Code, OpenCode, Codex, Gemini CLI …), die App erkennt verbreitete Agenten und startet sie.
- Modelle als Python-Code mit CadQuery (`model.py`, `parts/`), Hilfsbibliothek `soma` mit `add_part`, Gruppen und Rollen, STEP-Import einzelner Teile und ganzer Baugruppen.
- Bauen bei jeder Änderung (abschaltbar), Fehler mit Datei und Zeile, ein vorgewärmter Python-Prozess, Öffnen ohne Neubau.
- Viewer mit Auswahl und Sprung in den Code, Ansichtswürfel, Drehpunkt, Bauteilbaum mit Gruppen, Transparenz und Isolieren.
- Messen auf der exakten Geometrie: Flächen, Kanten, Abstände, Bohrungsabstände.
- Schnitt und Explosionsansicht mit Demontage-Analyse, Abspielen Schritt für Schritt.
- Übergabe an den Agenten: Auswahl, Messwerte, Schnitt und Markierungen (Zeichnen auf der Ansicht) als Text oder Bild ins Terminal.
- Editor für Code und Markdown, PDF-Ansicht mit Zitat an den Agenten.
- Modell als ZIP-Datei mit Git-Verlauf, Zeitleiste mit Vorschau und Wiederherstellen, Speichern nur ausdrücklich.
- Skills: 15 mitgelieferte Regelwerke (3D-Druck, CNC, Blech, Toleranzen, Festigkeit mit FEM …), je Modell aus, bei Bedarf oder immer, mit Einstellungen.
- Normteile nach ISO und DIN mit passenden Bohrungen, Senkungen und Mutternfallen (`soma.fasteners`).
- Animationen in Python, Auswertungen (Überhang, Wandstärke, Abstand, Festigkeit mit FEM), Bilder und Videos über `soma render`.
- Export in STEP, STL, 3MF, glTF, DXF, SVG und weitere Formate.
- Zusatzpakete: `pip install` im Terminal landet in einer kleinen Umgebung je Modell, `requirements.txt` wandert mit dem Modell, auf einem anderen Rechner installiert die App die Pakete nach (E67).
- Versionsnummer auf der Startseite, am Logo und in `project.json` (E68).

[Unveröffentlicht]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Kai-Jungsthoefel/SOMA/releases/tag/v0.1.0
