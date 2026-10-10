// Anleitung (E83): eine Quelle für die Hilfe der App und den Skill „Using the app“. Die Quelle ist der mitgelieferte Skill
// `resources/skills/soma-app.md`, die Bilder liegen in `resources/help/`. Der Agent bekommt den Skill wie jeden anderen
// (Kopie in `.soma/skills/`), die Bilder kopiert die App nach `.soma/help/`. Deshalb verweisen die Bilder im Text relativ
// auf `../help/<name>.png`: Von der Kopie aus stimmt das im Projekt, und die Hilfe der App löst denselben Pfad auf.
// Was nur der Agent braucht, steht zwischen `<!-- agent -->` und `<!-- /agent -->`, die Hilfe der App lässt es weg.

/** Kennung des Skills, aus dem die Hilfe stammt. */
export const HELP_SKILL = 'soma-app';
/** Ordner der Bilder im Projekt (Zwischenergebnis der App, nicht im Verlauf). */
export const HELP_DIR = '.soma/help';
/** Dateiname eines Bildes der Anleitung: nur so wird gelesen und kopiert. */
export const HELP_IMAGE = /^[a-z0-9][a-z0-9-]{0,40}\.png$/;

export interface HelpSection { title: string; text: string }

const FRONT = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const AGENT = /<!--\s*agent\s*-->[\s\S]*?<!--\s*\/agent\s*-->[ \t]*\r?\n?/g;

/**
 * Text der Anleitung für die App, je Überschrift `##` ein Abschnitt: ohne Kopf, ohne die Teile für den Agenten und ohne
 * die Hauptüberschrift (das Fenster heißt schon „Help“). Was vor dem ersten Abschnitt steht, kommt an den Anfang des ersten.
 */
export function helpSections(raw: string): HelpSection[] {
  const text = raw.replace(/\r\n?/g, '\n').replace(FRONT, '').replace(AGENT, '').replace(/^#\s+.*\n/m, '');
  const parts = text.split(/^##\s+/m);
  const intro = parts.shift()!.trim();
  const out = parts.map((p) => {
    const nl = p.indexOf('\n');
    return { title: (nl < 0 ? p : p.slice(0, nl)).trim(), text: nl < 0 ? '' : p.slice(nl + 1).trim() };
  }).filter((s) => s.title);
  if (out.length && intro) out[0].text = `${intro}\n\n${out[0].text}`;
  if (!out.length && intro) out.push({ title: 'Help', text: intro });
  return out;
}

/** Bilder, auf die die Anleitung verweist (`../help/<name>.png`), in der Reihenfolge des Textes. */
export function helpImages(raw: string): string[] {
  return [...raw.matchAll(/!\[[^\]]*\]\(\.\.\/help\/([^)\s]+)\)/g)].map((m) => m[1]);
}
