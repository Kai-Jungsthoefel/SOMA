---
title: Animation und Video
name: Animation and video
summary: Bewegungen, Kamerafahrten und Texte in animations/*.py, auf Kollisionen prüfen, als Standbilder ansehen, als MP4 ausgeben.
order: 31
category: Prüfen und Zeigen
default: on-demand
when: the user wants to see parts move, an assembly sequence, a camera flight, a video or a presentation of the model
topics: Datei und Aufbau; Gelenke und Zeitleiste; Kamera; Texte; Bauen, prüfen, ansehen; Rückmeldung
---
# Skill: Animation and video

An animation describes motion, camera and text over time. It is data, not a video: the app plays it in the 3D view,
`soma render` turns it into pictures and an MP4. Write it in Python in `animations/<topic>.py`, several
`Animation(...)` per file are fine. Do not change `model.py` for an animation.

```python
from soma.anim import Animation
from model import HINGE_Y, HINGE_Z          # reuse the model's constants (add_part has no effect here)

a = Animation("Open the lid")               # unique name, the user picks it in the app
lid = a.hinge("Lid", (0, HINGE_Y, HINGE_Z), (1, HINGE_Y, HINGE_Z))   # axis through two points, like cq rotate()
drawer = a.slider("Drawer", (1, 0, 0))      # moves along a direction (mm)
a.camera.set(view="iso")                    # jumps; fits all parts over the whole motion
a.title("Storage box", subtitle="Lid and drawer", duration=2)
a.caption("The lid opens to 110°")          # shown until the next caption
a.play(lid.to(-110), run_time=2)            # everything in one play() runs at the same time
a.label("Hinge", part="Lid", at=(0, HINGE_Y, HINGE_Z))
a.play(drawer.to(60), a.camera.orbit(45), run_time=1.5, ease="linear")
a.wait(1)
```

## Joints and timeline

- `hinge(parts, p1, p2)`: angle in degrees, right-hand rule around `p2 - p1`. `slider(parts, direction)`: way in mm.
  `part(parts)`: free motion with `to(cq.Location(...))`, `translate((x, y, z))`, `rotate(p1, p2, angle)`.
- `parts` is a name from `add_part`, a group (`"Housing"`, `"Housing/Screws"`) or a list. One joint per part. A joint
  on a moving part gets `parent=lid`, its axis is given in the model position.
- `joint.to(value)` (0 = as modelled), `joint.by(delta)`.
- `play(*actions, run_time=1, ease="smooth")`, eases `smooth`, `linear`, `in`, `out`. `wait(seconds)`. `title()` also
  takes time. `caption`, `label`, `highlight(parts, duration=)`, `hide`, `show`, `ghost(parts)` start now and take none.

## Camera

- `a.camera.set(view=, fit=, zoom=, target=, distance=)` jumps, `a.camera.move(...)` is a flight inside `play()`.
  Views: iso, front, back, left, right, top, bottom or a direction from the target to the camera. `fit=["Lid"]`
  frames these parts over their whole motion. `a.camera.orbit(degrees, tilt=0)` circles around Z, `zoom(factor)`.
- Keep the moving parts in view, one camera move at a time, 1 to 3 s each. Without camera calls the user turns the
  view freely.

## Text

Captions: one short sentence in the language the user speaks, about what moves and why. Labels: 1 to 3 words.

## Build, check, look

1. `soma anim build` (the app also builds when the file changes). Errors name file and line.
2. `soma anim info "Open the lid"`: the timeline as text. Read it.
3. `soma anim check "Open the lid" --gap 0.5`: parts that collide or come closer than the gap during the motion. Fix
   collisions in the model or in the motion. Contacts and gaps as built in the model count as intended, only what
   gets worse during the motion is reported. A motion built from many short `play()` steps (a coupled mechanism)
   is fine: approximate a curve with steps of a few degrees, too coarse steps show up as small collisions.
4. `soma render --anim "Open the lid" --sheet`: one picture with 9 stills and their times, `--at 1.5` for one moment.
   Open the picture and look at it.
5. Only when the user wants a video: `soma render --anim "Open the lid" --video` writes `renders/<id>.mp4`
   (1280x720, 30 fps), the captions as `.vtt` and an overview picture. You cannot watch the video, check the overview.

## Feedback from the user

`[Animation: "Name" (animations/x.py) bei 1.50 s]` and `[Video: renders/x.mp4 bei 00:03.20]` point to a moment. A
marking may say `gezeichnet auf renders/x.mp4 bei 00:03.20` or `Animation „Name“ bei 1.50 s`: the picture shows that
moment. Render it yourself (`soma render --anim "Name" --at 1.5`) before you change something.
