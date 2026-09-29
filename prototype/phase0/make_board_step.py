"""Erzeugt eine synthetische 'mitgebrachte' Mikrocontroller-Platine als STEP (Ersatz fuer eine Fremddatei).
Ursprung in der Ecke, benannte und farbige Teile, wie man sie von Herstellern/KiCad bekommt."""
import cadquery as cq

L, W, T = 51.5, 28.0, 1.6
pcb = (cq.Workplane("XY").box(L, W, T, centered=False)
       .faces(">Z").workplane(origin=(0, 0, T))
       .pushPoints([(3, 3), (L - 3, 3), (3, W - 3), (L - 3, W - 3)]).hole(2.8))
usb = cq.Workplane("XY").box(9, 7.5, 3.2, centered=False).translate((-1.5, W / 2 - 3.75, T))
shield = cq.Workplane("XY").box(18, 15.5, 2.4, centered=False).translate((L - 22, W / 2 - 7.75, T))
hdr1 = cq.Workplane("XY").box(2.54 * 12, 2.54, 8.5, centered=False).translate((10, 1.0, T))
hdr2 = cq.Workplane("XY").box(2.54 * 12, 2.54, 8.5, centered=False).translate((10, W - 3.54, T))

asm = cq.Assembly(name="ESP-Board")
asm.add(pcb, name="PCB", color=cq.Color(0.05, 0.4, 0.15, 1))
asm.add(usb, name="USB-C", color=cq.Color(0.75, 0.75, 0.78, 1))
asm.add(shield, name="Modul", color=cq.Color(0.6, 0.6, 0.62, 1))
asm.add(hdr1, name="Header_links", color=cq.Color(0.08, 0.08, 0.08, 1))
asm.add(hdr2, name="Header_rechts", color=cq.Color(0.08, 0.08, 0.08, 1))
asm.export("example/inputs/board.step")
print("board.step geschrieben")
