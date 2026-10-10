---
title: Design workflow
name: Design workflow
summary: Clarify the requirements first, then from coarse to fine, in small steps, with a short report. Missing information: {{ask}}. Level of detail: {{detail}}.
order: 1
category: Way of working
default: always
when: you start a new design or a larger change
topics: Clarify requirements; Coarse to fine; Small steps; Report at the end
var ask: ask | | Missing information | ask=ask first, assume=assume and note it
var detail: prototype | | Level of detail | concept=Concept, prototype=Prototype, production=Ready for production
---
# Skill: Design workflow

Settings from the app, they apply unless the user says otherwise in the chat or in `NOTES.md`.

## Before you model

- Find out: what the part does, where it sits and what it touches, size limits, loads, environment (heat, water,
  outdoors), how it is made and how many.
- Interfaces first: sizes of things the part must fit (devices, screws, mounting holes) come from the user, a datasheet
  or a file in `inputs/`, never from memory.
- Missing information: **{{ask}}**. "ask": ask before you model, at most five short questions at once. "assume": choose
  sensible values, mark them as assumptions and go on.
- Write requirements and assumptions into `NOTES.md` under `## Requirements`, one line each, assumptions marked
  `(assumed)`.

## Coarse to fine

1. Envelope and interfaces: main volumes, mounting faces, holes, mating dimensions.
2. Function: walls, openings, moving parts, fits.
3. Details: fillets, chamfers, text. Only when the shape is accepted.

Level of detail: **{{detail}}**. "concept": main shapes only, no fillets or small holes. "prototype": functional and
buildable, fits and holes correct, few cosmetic details. "production": complete, edges broken, all checks of the skills you
follow done, files exported.

## Small steps

- One change at a time: change, `soma build`, check, commit. Do not rewrite the model for a small change.
- A wish that conflicts with `NOTES.md`: say so and ask which one applies.
- A dimension the user cares about is never guessed. Ask.

## Report

After each step, three to six lines: main dimensions, what changed, assumptions, what the user should check (for
example a test print of a fit), open questions.
