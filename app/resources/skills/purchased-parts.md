---
title: Purchased parts
name: Purchased parts
summary: Real parts to buy (motors, bearings, hinges, boards, profiles, lumber): where to find a CAD model or a data sheet, what to do when a shop only works in a browser, modelling from a dimension drawing, noting supplier and source.
order: 26
category: Design knowledge
default: on-demand
when: the model needs a real part to buy (motor, bearing, hinge, switch, board, profile, lumber), or the user names a shop, a manufacturer or a part number
topics: Where a part comes from; Open libraries; Shops and manufacturers; When a shop needs a browser; From a data sheet; In the model; Supplier and source
---
# Skill: Purchased parts

A purchased part has to fit what the user will actually buy: its mounting holes, shaft, pilot, connectors and moving
ranges, not just its outside size. Find the real part, get its CAD model or its dimension drawing, and say where it came
from. Screws, nuts, washers and inserts are standard parts: `soma.fasteners` (skill for standard parts), no search.

## Where a part comes from

Try in this order and stop at the first that gives what the model needs:

1. **Standard parts** from `soma.fasteners`, no internet needed.
2. **Open CAD libraries** with the tool `part_library` (below): free STEP files of common parts.
3. **The manufacturer or a shop** with a STEP file: `web_search`, then `web_fetch` the product page.
4. **The data sheet** with its dimension drawing (PDF): model the part from it (below).
5. **Only the outside dimensions**: last resort. Say clearly that it is an approximation and what is missing, and ask
   the user to measure the part or send the data sheet.

If the user names a shop or a part number, start there. If they already have the part, measuring it beats any guess.

## Open libraries: `part_library`

Searches the file names of open CAD libraries on GitHub and downloads from them:

- `freecad`: FreeCAD parts library, CC-BY 3.0, about 2 900 STEP files (bearings, fasteners, profiles, motors, sensors,
  boards, robots, pipes …).
- `adafruit`: Adafruit CAD parts, MIT, STEP files of Adafruit boards; folders start with the product number ("4884").

Search with a few words, a size or a number (`"608 bearing"`, `"nema 17"`, `"raspberry pi 4"`), then download with
`library`, `file` and `path` (`inputs/…`). Prefer STEP over FCStd and STL. Names are free text and models are made by
volunteers: check the dimensions that matter against the real part or its data sheet after the download.

The tools `part_library`, `web_fetch` and `web_search` come with SOMA AI. Another agent uses its own web tools for the
same steps: the file list of a library is one request,
`https://api.github.com/repos/FreeCAD/FreeCAD-library/git/trees/master?recursive=1` (Adafruit:
`adafruit/Adafruit_CAD_Parts`, branch `main`), a file downloads from
`https://raw.githubusercontent.com/FreeCAD/FreeCAD-library/master/<path>` (spaces as `%20`).

## Shops and manufacturers

`web_search` finds the product, its part number and often the price. `web_fetch` reads the product page: it lists
**Product data** (name, part number, price, availability) and **Links to files** (STEP, ZIP, PDF). Download a STEP or
ZIP link with `web_fetch` and `path` into `inputs/`; unpack a ZIP with `python -m zipfile -e` and keep the STEP. Makers
often keep their CAD on GitHub (Adafruit, partly SparkFun and Pololu): look there too.

Say when a price or a dimension could not be checked, and give the date: prices change.

## When a shop needs a browser

Many shops and catalogs do not let programs download CAD: the download is a button or configurator that runs in the
browser, needs a sign-in, or the site refuses programs (HTTP 403, connection reset). **Never try to get around it**
(other addresses, another user agent, proxies, hidden interfaces). Give the user the link, the part number and the
click path ("open the page, choose CAD download, format STEP"), and ask them to download the file and drag it into SOMA
(it lands in `inputs/`). Then continue with that file.

What was seen with SOMA AI (November 2026), as a guide, sites change:

| Source | What works |
|---|---|
| Adafruit (GitHub `Adafruit_CAD_Parts`), goBILDA, Pololu, AndyMark, many small makers | STEP or ZIP linked on the product page or in the repository: downloads directly |
| igus, item, MISUMI | page readable, CAD from a configurator or after sign-in: the user downloads |
| McMaster-Carr, SKF, Grainger | page needs JavaScript: search gives the part number, the user downloads the CAD |
| Festo, Digi-Key, Mouser, RS, Würth, KIPP, norelem, TraceParts, GrabCAD | refuse programs: search gives part number and often price, the user downloads |
| CADENAS / PARTcommunity catalogs (used by many manufacturers) | download only in the browser |
| Home Depot, Menards, Hornbach, Amazon | usually no CAD: data sheet, product dimensions or measuring |

## From a data sheet

A dimension drawing gives what a box from the outside size cannot. Download the PDF with `web_fetch` and `path`, then
look at the drawing as a picture:

```python
import pdfplumber
page = pdfplumber.open("inputs/motor.pdf").pages[0]
print(page.extract_text())                              # tables, notes
page.to_image(resolution=170).save("drawing.png")       # then read drawing.png, delete it afterwards
```

Model what touches the rest of the design, with the values from the drawing:

- mounting: hole pattern, thread and depth, slots;
- locating features: pilot boss, shoulder, dowel holes;
- shafts: diameter, length, flats or keyways;
- connectors and cable exits, buttons, LEDs, openings that must stay free;
- moving ranges and keep-out zones (lever travel, hinge swing, a fan's air path).

Keep the rest simple. Put the source (file, page, drawing date) and every value that is not dimensioned in the drawing
into a comment, and say in the reply which values are approximate.

## In the model

- A STEP file: `import_step("inputs/motor.step")`, or `import_assembly(...)` when it has several bodies. Check the
  bounding box and the origin, STEP files often have theirs in a corner: move the part deliberately.
- Add purchased parts with `role="hardware"` (opaque, in the model's STEP file, not in `soma export --all`), in a group
  such as `group="Purchased"`. Use `role="reference"` only for things the user already has and that stay as they are
  (a board they bring, the wall it mounts to).
- Cut clearances, holes and pockets from the real interfaces, with the gaps from the skills for tolerances and for
  the manufacturing process.

## Supplier and source

Write one line per purchased part into `NOTES.md` under a heading "Purchased parts": name, supplier, part number,
price with currency and date, link, and where the model came from. A part from `part_library` gets the source line the
tool returns: the licenses (CC-BY) ask for it. Example:

```
## Purchased parts
- Stepper motor: STEPPERONLINE 17HS19-2004S1, €15.99 (Amazon.de, 2026-11-25), https://… Model from the data sheet
  inputs/17HS19-2004S1.pdf (drawing 2020-10-30), cable exit approximate.
- Bearing 608ZZ: 608ZZ_Ball_Bearing.step from the FreeCAD parts library (https://github.com/…), license CC-BY 3.0.
```
