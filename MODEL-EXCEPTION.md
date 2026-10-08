# SOMA Model Exception

Version 1.0, 8 October 2026

SOMA is licensed under the GNU General Public License, version 3 or any later version (the "GPL", see [LICENSE](LICENSE)).
This file is an additional permission under section 7 of the GPL. It makes sure that what you design with SOMA belongs to you.

## 1. Definitions

**SOMA** means the software in this repository: the desktop application and the Python library and command line tool `soma`.

A **Model** is source code and data written to describe, build, analyze or animate a design with SOMA. Examples are
`model.py`, the files in `parts/`, `animations/`, `analyses/` and `inputs/`, and `requirements.txt`. A Model may import and
call the `soma` library, and SOMA may run it. A Model does not include SOMA itself or a copy of any part of it.

**Project Files** are the files SOMA copies into a model project from its templates and skills, for example `AGENTS.md`,
`CLAUDE.md`, `NOTES.md`, the starter `model.py`, `.gitignore` and the skill files in `.soma/skills/`.

**Output** means the files SOMA creates from a Model, for example STEP, STL, 3MF, glTF, DXF, images and videos.

## 2. Additional permission

As a special exception, the copyright holders of SOMA give you permission to:

1. create, use, modify and convey a Model under terms of your choice, including proprietary terms, even though the Model
   imports or calls the `soma` library or is run by SOMA. The GPL does not apply to a Model merely for that reason.
2. use, modify and convey Project Files as part of a model project under terms of your choice.

The GPL places no restrictions on Output. It is yours.

## 3. Limits

This permission does not cover SOMA itself. If you convey SOMA, a modified version of SOMA or a work based on SOMA, the GPL
applies in full. If a Model contains a copy of SOMA or of parts of it, those parts stay under the GPL.

## 4. Removing this permission

If you convey a modified version of SOMA, you may remove this additional permission from your version, as section 7 of
the GPL allows.
