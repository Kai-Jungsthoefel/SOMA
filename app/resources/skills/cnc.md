---
title: CNC-Fräsen und Drehen
name: CNC milling and turning
summary: {{material}}, kleinster Fräser Ø {{tool_d}} mm, {{axes}}: Innenradien, Taschentiefen, Zugänglichkeit, Bohrungen und Gewinde, Drehteile.
order: 12
category: Fertigungsverfahren
default: off
topics: Material und Maschine; Innenecken und Taschen; Zugänglichkeit und Aufspannungen; Wände, Bohrungen, Gewinde; Drehteile; Angaben für die Fertigung
var material: aluminium | | Material | aluminium=Aluminium, steel=Stahl, stainless steel=Edelstahl, brass=Messing, POM=POM, plastic=anderer Kunststoff
var tool_d: 6 | mm | Kleinster Fräser Ø | 0.5..25
var axes: 3 | | Maschine | 3=3-Achs, 3+2=3+2-Achs (5 Seiten), 5=5-Achs simultan
---
# Skill: CNC milling and turning

The user set these values in the app. They apply unless the user says otherwise in the chat or in `NOTES.md`:
material **{{material}}**, smallest end mill Ø {{tool_d}} mm, machine with **{{axes}}** axes. Constants at the top:
`TOOL_D = {{tool_d}}`, `INNER_R = TOOL_D / 2 + 0.2`.

## Inner corners and pockets

- Vertical inner corners cannot be sharp: radius at least `INNER_R`, and at least a third of the pocket depth.
  Pocket: `.sketch().rect(w, h).vertices().fillet(INNER_R).finalize().cutBlind(-depth)`.
- A square part that must fit into a pocket: relief holes in the corners (dogbones).
- Pockets at most 4 × their width deep.

## Access and setups

- "3": everything is machined from the top, or from the bottom after flipping the part. No undercuts, no angled holes.
  "3+2": five sides and angled holes. "5": also free-form surfaces.
- Put most features on one side. Each extra side is another setup: say how many the part needs.

## Walls, holes, threads

- Walls at least 1 mm in metal, 1.5 mm in plastics, at most 10 × as high as thick.
- Holes in standard drill sizes (whole and half millimetres), at most 4 × d deep. Blind holes end in a 118° drill point,
  about 0.3 × d deeper than the cylinder: leave material for it.
- Tapped holes: tap drill = d − pitch (M3 2.5, M4 3.3, M5 4.2, M6 5.0, M8 6.8). Thread depth 1.5 × d, 2 × d in
  aluminium and plastics. Drill 0.5 × d deeper than the thread.
- Break outer edges with a 0.3 to 0.5 mm chamfer. Outer fillets only where they matter.

## Turned parts

- Model rotational parts with `revolve` of a profile around the axis. Diameters from round bar stock.
- Inner corners at shoulders get the tool radius (0.4 mm), or an undercut (DIN 509) where a mating part has to sit flat
  against the shoulder. Chamfer the ends 0.5 × 45°.

## Information for the shop

- STEP files carry no threads, fits or surface finish: list them in `NOTES.md` (thread and depth, fit, which faces
  matter). Everything else: general tolerance ISO 2768-m.
- Choose thicknesses from standard plate or bar stock (5, 6, 8, 10, 12, 15, 20 mm).
- Check before you finish: every inner vertical corner has at least `INNER_R`, every feature is reachable with the
  machine.
