# Changelog

Alle nennenswerten Änderungen an SOMA. Aufbau nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionsnummern
nach Major.minor.bugfix (E68). Neues sammelt sich unter „Unveröffentlicht“ und wandert beim Hochzählen der Version in einen
eigenen Abschnitt mit Datum und Git-Tag.

## [Unveröffentlicht]

### Geändert

- Jede Zeile im Panel „Parameters“ zeigt den Bereich, den der Agent gesetzt hat, ohne Aufklappen („30–200 mm“, „3 options“), rot, wenn der Wert außerhalb liegt (E74).
- Kleinere ZIP beim Speichern: Bilder und Videos aus `renders/` kommen nicht mehr mit, und die Versionsgeschichte wird vorher gepackt, sodass ähnliche Fassungen des Modells kaum zusätzlichen Platz brauchen. Am Modellmotor schrumpft der Verlauf von 81 auf 35 MB (E75).

### Behoben

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

[Unveröffentlicht]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Kai-Jungsthoefel/SOMA/releases/tag/v0.1.0
