# Herkunft der Maßtabellen

Die CSV-Dateien in diesem Ordner stammen unverändert aus **bd_warehouse** von Gumyr
(https://github.com/gumyr/bd_warehouse, Ordner `src/bd_warehouse/data/`, Stand Commit
`eed2da118da99007ad2d3904466ac0b24964f84d` vom 21.09.2026, Version 0.3.0).

Lizenz: Apache License 2.0, Text in `LICENSE-bd_warehouse.txt`. Copyright 2024 Gumyr.

Verwendet von `soma/fasteners.py`. Der Code dort ist eigener Code und übernimmt nichts aus bd_warehouse.

| Datei | Inhalt |
|---|---|
| `socket_head_cap_parameters.csv` | ISO 4762, ASME B18.3 (inch, values in inches) |
| `button_head_parameters.csv` | ISO 7380-1 |
| `countersunk_head_parameters.csv` | ISO 10642 (weitere Senkschrauben ungenutzt) |
| `hex_head_parameters.csv` | ISO 4017, ISO 4014, DIN 931 |
| `setscrew_parameters.csv` | ISO 4026 |
| `hex_nut_parameters.csv` | ISO 4032, ISO 4033, ISO 4035 |
| `square_nut_parameters.csv` | DIN 557 |
| `plain_washer_parameters.csv` | ISO 7089, ISO 7091, ISO 7093 |
| `clearance_hole_sizes.csv` | Durchgangslöcher (Close, Normal, Loose = ISO 273 fein, mittel, grob). Inch rows (`#10`, `1/4`) for ASME B18.3 |
| `tap_hole_sizes.csv` | Kernlöcher (genutzt: Spalte Soft), also the inch rows (`1/4-20`) |
| `nominal_screw_lengths.csv` | Normlängen je Schraubennorm, `asme_b18.3` in inches |
| `heatset_nut_parameters.csv` | Gewindeeinsätze von ruthex, CNC Kitchen, McMaster-Carr, Hilitchi, AE-SamZhihui |
| `drill_sizes.csv` | Zollbohrer (Nummern und Buchstaben) für die Bohrungen der Gewindeeinsätze und die Zoll-Bohrungen |

Bekannte Eigenheiten der Daten:

- Die Werte sind teils Nennmaße, teils Größtmaße (ISO 4762 M3: Kopf 5,68 mm, also das Größtmaß mit Rändelung).
- Die Bohrungen der Gewindeeinsätze sind Zollbohrer und weichen etwas von den metrischen Richtwerten im Skill
  „3D-Druck“ ab (ruthex M3: 4,04 statt 4,0 mm, M5: 6,53 statt 6,4 mm). Gegen Herstellerblätter geprüft ist das nicht.
- Für die M10-Einsätze von ruthex und CNC Kitchen steht als Bohrer „M14“, mehr als der Einsatz dick ist. `soma`
  lehnt diese Einsätze mit einer Meldung ab.
- Bei ISO 4035 M3 steht die Zeile unter der Steigung 0,45 statt 0,5. `soma` nimmt dann die vorhandene Zeile, denn ohne
  Gewinde zählt nur der Durchmesser.
- ASME B18.3 (inch): the columns `short` and `long` give 1.5 and 5 in for 1/4-20, the series in
  `nominal_screw_lengths.csv` starts at 0.75 in. Shorter socket head cap screws are common, so `soma` only uses
  `long` as the upper limit and lists the series up to it. The series writes 7/8 as 0.88: `soma` snaps values within
  0.006 in to sixteenths.
- There are no inch nuts, washers, other heads or inserts in the tables, `soma` offers none.
