# Phase 0: Ergebnisse des technischen Prototyps

> Stand: 2026-09-29 · Plan: [PLAN.md](../PLAN.md), Abschnitt 10 · Alles gemessen auf **Windows 11**, Python 3.12.0, CadQuery 2.8.0, OCP 7.9.3.1.1, three.js 0.180, Edge (headless).
> Der Code des Prototyps (die unten genannten Skripte und Tests) ist nicht mehr im Repo. Er liegt im Git-Verlauf, zuletzt im Tag `v0.5.0` unter `prototype/phase0/`.

## Kurzfassung

Alle sechs Punkte sind bestanden. Die Kernidee trägt: **Bauteil registrieren → STEP mit Namen und Farben → GLB mit Flächen-IDs → Klick im Viewer → Datei und Zeile in `model.py`**, dazu exaktes Messen über dieselben IDs. Gegen den Plan haben sich vier Dinge verschoben (siehe „Folgen für den Plan").

| # | Punkt | Ergebnis | Nachweis |
|---|---|---|---|
| 1 | STEP mit Namen und Farben | **bestanden**, kein eigener XCAF-Export nötig | `p1_step_names.py` |
| 2 | GLB mit Flächen-IDs (eigener Mesher) | **bestanden** | `mesher.py`, `p4_measure_test.py`, `p2_mesher_perf.py` |
| 3 | Klick im Viewer → Datei und Zeile | **bestanden** (echter Browser) | `p3_click_test.mjs`, `screenshots/` |
| 4 | Fremd-STEP, Messen, Aussparung, Referenz | **bestanden** (mit synthetischer Platine) | `p4_measure_test.py`, `p3b_basic_test.mjs` |
| 5 | Umgebung ohne VTK, Größe | **VTK ist nicht wegzubekommen.** Größe gemessen | `dll_closure.py`, `count_loaded.py` |
| 6 | Exportformate | **12 Formate**, davon 2 mit eigenem Code | `p6_export_formats.py` |

## 1. STEP mit Namen und Farben

Der normale `cq.Assembly.export(...)` (Modus „default") genügt. Ein eigener Export über OCP ist **nicht nötig**, das größte Risiko aus dem Plan ist damit erledigt. Geprüft wurde mit einem **eigenen, unabhängigen XCAF-Leser** (`xcaf_tools.py`), der die Datei liest und nicht CadQuerys Deutung.

- Erhalten bleiben: 5 Bauteilnamen, sRGB-Farben, Transparenz (Alpha 0,5), verschachtelter Ast „Referenz".
- **Compound mit mehreren Körpern:** Die Farbe steht in der Datei auf den Einzelkörpern (5 `STYLED_ITEM`, 1 `COLOUR_RGB`), nicht am Compound. Ein Leser muss dort suchen. Das betrifft auch importierte Platinen.
- **Verschachtelte Baugruppe:** Der Name steht im `PRODUCT`, die Instanz (`NEXT_ASSEMBLY_USAGE_OCCURRENCE`) hat nur eine Nummer. Ein Leser muss für Baugruppen den Produktnamen nehmen.
- **Nicht-ASCII-Namen sind kaputt:** Die Datei enthält doppelt kodiertes UTF-8 (`Größe` steht als `GrÃ¶Ã\x9fe`). `ä ö ü` überleben den Reimport zufällig, `ß`, `×` und CJK nicht. **Lösung im Prototyp:** `add_part` schreibt einen ASCII-Namen in die STEP (`Schraube links` → `Schraube_links`, `ä` → `ae`), der Anzeigename bleibt in `model.map.json`.
- **Doppelte Namen** lehnt CadQuery mit klarer Meldung ab (`Unique name is required`). `add_part` prüft zusätzlich den ASCII-Namen, sonst kollidieren `Größe` und `Groesse`.
- Nicht getestet: der Modus „fused" (verliert laut Doku Namen, wird nicht gebraucht).

## 2. GLB mit Flächen-IDs

`mesher.py` (rund 150 Zeilen) erzeugt pro Bauteil ein Mesh, pro Fläche einen zusammenhängenden Dreiecksbereich (`triStart`, `triCount`) und pro Kante einen Linienbereich. Die Tabellen liegen in `node.extras.cadide` des GLB.

- **Konsistenz geprüft:** 197 Flächen und Kanten des Beispiels wurden gegen die OCC-Objekte verglichen (Fläche, Schwerpunkt, Länge), 0 Abweichungen. Damit kann der Python-Dienst „Fläche f27" exakt vermessen.
- **Die IDs gelten nur für einen Build.** Ändert der Agent das Modell, können sich die Nummern verschieben (Topological-Naming-Problem). Das ist für Klick und Messen im selben Stand unkritisch, aber Auswahlen dürfen nicht über Builds hinweg gespeichert werden.
- Koordinaten sind Z-oben in mm (kein Y-oben-Umbau), der Viewer setzt `camera.up = Z`. Farben werden von sRGB nach linear umgerechnet, wie glTF es verlangt.
- **Leistung** (Wert schwankt je nach Last, zwei Läufe):

| Modell | Flächen | Dreiecke | OCC-Mesh | Python-Mesher | GLB |
|---|---|---|---|---|---|
| Platte, 961 Löcher, Toleranz 0,05 | 967 | 165 000 | 4,1 bis 4,8 s | 1,7 bis 3,2 s | 7,7 MB |
| Dieselbe, Toleranz 0,01 | 967 | 488 000 | 18 bis 30 s | 3,9 bis 7,7 s | 19 MB |
| Platte + 480 Zapfen | 968 | 81 000 | 1,7 bis 2,2 s | 0,8 bis 1,5 s | 3,9 MB |
| Kugel R50, Toleranz 0,005 | 1 | 100 000 | 1,2 bis 1,9 s | 0,3 bis 0,7 s | 2,4 MB |

Der Python-Anteil ist **nicht der Engpass**, das Meshen in OCC ist es. Hinzu kommt die Bauzeit des Modells selbst (2,3 s für die Platte). Ein großes Modell braucht damit schnell 8 bis 10 s pro Build, das stützt die Entscheidung, den Auto-Build abschaltbar zu machen (E20). Eine feste Toleranz von 0,01 mm ist zu fein, sie sollte sich an der Bauteilgröße orientieren.

## 3. Klick im Viewer → Datei und Zeile

Getestet in **echtem Browser** (Edge headless mit WebGL über SwiftShader, gesteuert per puppeteer-core), nicht nur per Raycast im Skript. Der Test klickt auf die Bildschirmposition von drei Flächen und prüft Bauteil, Flächen-ID, Datei und Zeile.

- Deckel-Oberseite → `Deckel`, Fläche f2, `model.py:34`. Taster-Kuppe → `Taster`, `model.py:35–39`. Außenwand des Bodens → `Boden`, `model.py:33`.
- `add_part` erfasst den **Zeilenbereich** des Aufrufs (`inspect` mit `positions`, Python ab 3.11). Ein mehrzeiliger Aufruf wird ganz markiert.
- Der Viewer hebt die geklickte **Fläche** orange hervor, zeigt Fläche, Typ, Flächeninhalt und den Code mit markierter Zeile. Ein-/Ausblenden über den Baum funktioniert, Referenzteile sind halbtransparent (Screenshot `p3_viewer_offen.png`).
- **Grenze:** Verknüpft wird der **`add_part`-Aufruf**, nicht die Zeile, in der die Fläche entsteht (also nicht „diese Bohrung kommt von Zeile 22"). Das entspricht E10 (zunächst nur Bauteilebene).
- Kanten waren zuerst kaum sichtbar (Tiefenkonflikt mit den Flächen). Behoben mit `polygonOffset` auf den Flächen, sonst fällt das im Viewer auf.

## 4. Fremd-STEP, Messen, Aussparung, Referenz

Das Beispielprojekt (`example/model.py`) importiert `inputs/board.step` (Platine mit USB-Buchse, Modul und zwei Stiftleisten, Ursprung in der Ecke), setzt sie ins Gehäuse und schneidet eine Aussparung mit 0,3 mm Luft.

- Exakt gemessen (OCC): Abstand Boden–Platine **0,300000 mm**, Deckel–Platine **2,400000 mm**, Schnittvolumen Boden ∩ Platine 0, Radius der Montagelöcher **1,4 mm** aus den Kanten-IDs, Höhenabstand über zwei Flächen-IDs.
- Referenz: `role="reference"` legt das Teil in den Ast „Referenz" der STEP, Alpha 0,45 in STEP und GLB, halbtransparent im Viewer.
- **Basismodus** (Plan Abschnitt 7): `basic_view.py` wandelt eine beliebige STEP in GLB um (Namen und Farben aus der STEP, kein Mapping). Der Viewer zeigt 5 benannte Teile, ein Klick liefert das Bauteil ohne Code-Bezug, ohne Fehler.
- **Grenze:** Die Platine ist **synthetisch** (`make_board_step.py`), keine echte Herstellerdatei. Echte Dateien haben oft viele Einzelteile, andere Einheiten, Stücklistenstruktur und Encoding-Eigenheiten. Das ist in Phase 1 mit echten Dateien (KiCad-Export, Modul-Hersteller) nachzuholen.

## 5. Umgebung und Größe

- **VTK ist nicht wegzubekommen.** Das Wheel `cadquery-ocp` verlangt `vtk==9.6.2`, und `OCP/__init__.py` bricht ohne den Ordner `vtk.libs` ab. `import OCP` lädt 47 der 209 VTK-DLLs plus alle 71 OCP-DLLs (zusammen 200 MB), `import cadquery` danach alle 209 VTK-DLLs (zusammen 342 MB). Eine Umgebung ohne VTK gibt es damit nicht, und Löschen ungenutzter DLLs bringt nichts.
- Größen (Windows, Python 3.12):

| Variante | Installiert | Anmerkung |
|---|---|---|
| **Voll** (`pip install cadquery`) | **1043 MB** | VTK 312 MB, casadi 220 MB, llvmlite 115 MB, scipy 83 MB … |
| Schlank (`--no-deps` + 9 Pakete) | 761 MB | ohne scipy, numba, llvmlite, matplotlib, trame; als ZIP rund 199 MB |

- In der schlanken Variante **nötig** sind: `cadquery`, `cadquery-ocp`, `cadquery-ocp-proxy`, `vtk`, `casadi` (wird beim Import gebraucht, `solver.py`), `ezdxf`, `numpy`, `nlopt`, `multimethod`, `runtype`, `pyparsing`, `typing-extensions`, `fonttools`. **Nicht nötig**: `scipy`, `numba`, `matplotlib`, `trame*` (nur NURBS-Werkzeuge und Notebook-Ansicht).
- **Entscheidung (E37):** Größe ist vorerst egal, es wird die volle Umgebung genommen. Der Prototyp läuft damit in `venv-full`.
- **Stolperstein beim Pinnen:** Ein ungepinnter Install zieht `cadquery-ocp` 8.0.1, das nicht zu `cadquery` 2.8.0 passt (verlangt `<8.0`), und `multimethod` 2.1 (verlangt `<2.0`). Die App muss die Versionen fest pinnen (`requirements-phase0.txt`).
- Ein Netzlaufwerk taugt nicht für die Umgebung (Tausende kleine Dateien), sie liegt lokal unter `%LOCALAPPDATA%`. Für die App heißt das: Arbeitsordner und Umgebung in den lokalen App-Daten, nie neben der ZIP auf dem Netz.

## 6. Exportformate

Einzelexport je registriertem Bauteil (Grundlage für `cadide export`), alle 6 Bauteile, jeweils unter 0,15 s:

| Format | Weg | Prüfung |
|---|---|---|
| STEP, BREP | CadQuery | Reimport-Volumen identisch (3678,551 mm³) |
| STL, 3MF, AMF, VRML | CadQuery | STL 184 Dreiecke, 3MF gültiges ZIP mit `3dmodel.model` |
| GLB, GLTF | CadQuery (Assembly) | Datei erzeugt |
| DXF (Schnitt in Bauteilmitte), SVG (Projektion) | CadQuery | **2D**, andere Bedeutung als die 3D-Formate |
| **IGES** | **eigener Code über OCP** | Reimport-Volumen identisch |
| **OBJ** | **eigener Code aus unserem Mesh** | 194 Vertices, 184 Dreiecke |
| PLY, Parasolid (X_T) | nicht verfügbar | X_T ist proprietär |

Für 3D-Druck reichen STL und 3MF. **3MF** kann Farben, das ist für Mehrfarbdruck interessant, wurde hier aber nur auf Gültigkeit geprüft.

## Folgen für den Plan

1. **Risiko „STEP-Namen" erledigt.** Der Rückfall auf eigenen XCAF-Export entfällt. Die Regel „STEP-Namen ASCII, Anzeigename in `model.map.json`" kommt neu hinzu.
2. **Installationsgröße** ist gemessen (0,76 bis 1,04 GB) und vorerst hingenommen (E37). Die Einschränkung „ohne VTK" aus dem Plan ist gegenstandslos.
3. **Flächen-IDs gelten pro Build.** Für Messen und Auswählen reicht das, gespeicherte Auswahlen und Verweise des Agenten müssen Bauteilname plus Geometrieangaben statt reiner Flächennummern nutzen.
4. **Exportformate** stehen fest (Tabelle oben). PLY und X_T entfallen.

## Nicht geprüft (bewusst offen)

- **macOS und Linux.** Alles lief nur unter Windows. Bundling, DLL-/Bibliothekspfade und Wheels sind auf den anderen Systemen ungetestet, obwohl E2 alle drei verlangt.
- **Echte Fremddateien** (Herstellerplatinen, große Baugruppen mit Stückliste).
- **Rendering mit echter GPU** und sehr großen Modellen (getestet nur mit Software-Renderer und kleinen Bauteilen). Die 165 000 Dreiecke des Benchmarks wurden gemessen, aber nicht im Viewer dargestellt.
- **Das Zusammenspiel mit einem echten Agenten** (Phase 1, Agent-Test).
- Kanten- und Punktauswahl im Viewer, Schnittansicht, Messwerkzeug im Viewer (die exakten Werte über IDs stehen, die Oberfläche dafür nicht).
- Python-Dienst als langlebiger Prozess und Build-Abbruch (der Prototyp baut im selben Prozess).
