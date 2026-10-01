---
title: Konstruktionsablauf
name: Design workflow
summary: Erst Anforderungen klären, dann vom Groben ins Feine, in kleinen Schritten, mit kurzem Bericht. Fehlende Angaben: {{ask}}. Detailgrad: {{detail}}.
order: 1
category: Arbeitsweise
default: on
topics: Anforderungen klären; Vom Groben ins Feine; Kleine Schritte; Bericht am Ende
var ask: ask | | Fehlende Angaben | ask=erst fragen, assume=annehmen und notieren
var detail: prototype | | Detailgrad | concept=Konzept, prototype=Prototyp, production=fertigungsreif
---
# Skill: Design workflow

The user set these values in the app. They apply unless the user says otherwise in the chat or in `NOTES.md`.

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
buildable, fits and holes correct, few cosmetic details. "production": complete, edges broken, all checks of the active
skills done, files exported.

## Small steps

- One change at a time: change, `soma build`, check, commit. Do not rewrite the model for a small change.
- A wish that conflicts with `NOTES.md`: say so and ask which one applies.
- A dimension the user cares about is never guessed. Ask.

## Report

After each step, three to six lines: main dimensions, what changed, assumptions, what the user should check (for
example a test print of a fit), open questions.
