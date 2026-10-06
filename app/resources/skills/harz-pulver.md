---
title: 3D-Druck Harz und Pulver (SLA, SLS)
name: Resin and powder 3D printing (SLA, SLS, MJF)
summary: {{process}}: Wände ab {{min_wall}} mm, Spiel {{clearance}} mm je Seite, Hohlkörper mit Ablauflöchern, Ausrichtung und Stützen.
order: 11
category: Fertigungsverfahren
default: on-demand
when: the parts will be printed in resin (SLA, DLP) or powder (SLS, MJF)
topics: Verfahren: {{process}}; Wände und Details; Hohlkörper; Ausrichtung und Stützen; Spiel und Gewinde; Prüfen und Export
var process: SLA | | Verfahren | SLA=Harz (SLA, DLP), SLS=Pulver (SLS, MJF)
var min_wall: 1 | mm | Mindestwand | 0.3..10
var clearance: 0.2 | mm | Spiel je Seite (Gleitpassung) | 0..2
---
# Skill: Resin and powder 3D printing

Process from the app: **{{process}}**. "SLA" means resin printers (SLA, DLP, MSLA), "SLS" powder bed
printers (SLS, MJF). The values apply unless the user says otherwise in the chat or in `NOTES.md`. Constants at the
top: `MIN_WALL = {{min_wall}}`, `CLEARANCE = {{clearance}}`.

## Walls and details

- Walls at least {{min_wall}} mm, free-standing thin features (fins, pins) at least twice that.
- Holes below about 1 mm (SLA) or 2 mm (SLS) close up. Embossed and engraved details at least 0.5 mm.
- Thick solid blocks waste material, crack (SLA) or warp (SLS): hollow them out or keep walls even.

## Hollow parts

- Every cavity needs at least two escape holes (air in, resin or powder out): SLA at least Ø 3.5 mm, SLS at least Ø 5 mm.
- Closed cavities without holes trap resin or powder: avoid them or say so.

## Orientation and support

- SLA: parts print tilted on supports, which leave marks. Say which faces must stay clean. Hollow shapes that open
  towards the build platform (cups) cause suction: give them a vent hole. Desktop printers are small: ask for the build
  volume when a part is larger than about 100 mm.
- SLS: no supports, any orientation, overhangs are free. Parts can be printed inside each other.

## Fits and threads

- Sliding or turning: {{clearance}} mm per side. Parts printed moving inside each other: at least 0.5 mm gap, so resin
  or powder can get out.
- Threads from M6 can be printed. Smaller: model the tap drill and tap the hole, or use inserts.
- Standard resins are brittle: no snap fits and no press fits, unless the user names a tough resin.

## Checks before you finish

- Every cavity has its escape holes, no wall is below {{min_wall}} mm (section view in the app, or measure).
- Export each part as STL or 3MF: `soma export "Lid" --format 3mf`. References are not printed.
