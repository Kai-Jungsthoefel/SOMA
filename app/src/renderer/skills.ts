import type { SkillInfo, SkillResult } from '../shared/types';
import { icon } from './icons';
import { el } from './ui';

interface Deps {
  list(): Promise<SkillInfo[]>;
  set(id: string, on: boolean): Promise<SkillResult>;
  /** Kopie im Projekt im Code-Panel zeigen (nur lesen). */
  open(file: string): void;
  /** Text in die Eingabe des Agenten einfügen (E11). */
  insert(text: string): void;
  toast(text: string, kind?: 'ok' | 'info' | 'error'): void;
  /** Dateien im Projekt haben sich geändert (Speicherstand, Dateibaum). */
  changed(): void;
}

/**
 * Seitenpanel „Skills“ (E17): mitgelieferte Regelwerke mit Schalter je Modell. Ein- und Ausschalten erledigt der
 * Hauptprozess (Kopie in .soma/skills/, project.json, AGENTS.md). Das Panel zeigt nur, was er meldet.
 */
export class SkillsPanel {
  private skills: SkillInfo[] = [];
  private error = '';
  private busy = new Set<string>();
  private expanded = new Set<string>();
  private loaded = false;

  constructor(private list: HTMLElement, private deps: Deps) {}

  async refresh(): Promise<void> {
    try { this.skills = await this.deps.list(); this.error = ''; } catch (e) { this.error = e instanceof Error ? e.message : String(e); }
    this.loaded = true;
    this.render();
  }

  /** Neues Modell: alte Liste weg, beim nächsten Öffnen neu laden. */
  reset(): void { this.skills = []; this.expanded.clear(); this.loaded = false; this.render(); }

  get isLoaded(): boolean { return this.loaded; }

  private async toggle(s: SkillInfo): Promise<void> {
    if (this.busy.has(s.id)) return;
    const on = !s.active;
    this.busy.add(s.id);
    this.render();
    let r: SkillResult;
    try { r = await this.deps.set(s.id, on); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e), skills: this.skills }; }
    this.busy.delete(s.id);
    this.skills = r.skills;
    this.render();
    this.deps.changed();
    if (!r.ok) { this.deps.toast(`„${s.title}“ ließ sich nicht ${on ? 'einschalten' : 'ausschalten'}: ${r.error ?? 'unbekannter Fehler'}`, 'error'); return; }
    const kept = r.backup ? ' Die vorige Fassung im Projekt liegt in der Sicherung.' : '';
    if (r.warning) { this.deps.toast(`„${s.title}“ ist ${on ? 'an' : 'aus'}. ${r.warning}${kept}`, 'error'); return; }
    // Ein laufender Agent liest AGENTS.md nicht von selbst neu
    this.deps.toast(on
      ? `„${s.title}“ ist an und steht in AGENTS.md. Einem laufenden Agenten sagt „An Agent geben“ Bescheid.${kept}`
      : `„${s.title}“ ist aus. Ein laufender Agent kennt die Regeln noch: Sag ihm Bescheid oder starte ihn neu.${kept}`);
  }

  private render(): void {
    if (this.error) { this.list.replaceChildren(el('div', { className: 'hint', textContent: `Skills nicht lesbar: ${this.error}` })); return; }
    if (!this.skills.length) { this.list.replaceChildren(el('div', { className: 'hint', textContent: this.loaded ? 'Diese App bringt keine Skills mit.' : 'Lädt …' })); return; }
    this.list.replaceChildren(...this.skills.map((s) => this.row(s)));
  }

  private row(s: SkillInfo): HTMLElement {
    const open = this.expanded.has(s.id);
    const sw = el('button', { className: 'sk-switch', title: s.active ? 'Ausschalten' : 'Einschalten' });
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(s.active));
    sw.setAttribute('aria-label', `${s.title} ${s.active ? 'ausschalten' : 'einschalten'}`);
    sw.disabled = this.busy.has(s.id) || (!s.bundled && !s.file);
    sw.addEventListener('click', () => void this.toggle(s));
    const more = el('button', { className: 'sk-more' + (open ? ' open' : ''), title: open ? 'Weniger zeigen' : 'Inhalt und Aktionen' }, icon('down', 15, 2));
    more.setAttribute('aria-expanded', String(open));
    more.setAttribute('aria-label', `${s.title}: ${open ? 'weniger zeigen' : 'Inhalt zeigen'}`);
    more.addEventListener('click', () => { if (open) this.expanded.delete(s.id); else this.expanded.add(s.id); this.render(); });
    const text = el('div', { className: 'sk-text' }, el('b', { textContent: s.title }), el('span', { textContent: s.summary }));
    const row = el('div', { className: 'sk-row' + (s.active ? ' on' : '') }, el('div', { className: 'sk-head' }, sw, text, more));
    row.setAttribute('role', 'listitem');
    row.dataset.id = s.id;
    if (s.changed) row.append(el('div', { className: 'sk-note', textContent: 'Die Kopie im Projekt weicht von der Fassung dieser App ab. Aus- und wieder Einschalten übernimmt die Fassung der App, die bisherige kommt in die Sicherung.' }));
    for (const p of s.problems) row.append(el('div', { className: 'sk-warn', textContent: p }));
    if (open) {
      const body = el('div', { className: 'sk-body' });
      if (s.topics.length) body.append(el('div', { textContent: 'Darauf achtet der Agent:' }), el('ul', {}, ...s.topics.map((t) => el('li', { textContent: t }))));
      const actions = el('div', { className: 'sk-actions' });
      if (s.file) {
        const view = el('button', { className: 'btn sm', title: 'Die Kopie im Projekt im Code-Panel zeigen' }, icon('file', 14, 1.9), 'Ansehen');
        view.addEventListener('click', () => this.deps.open(s.file!));
        actions.append(view);
      }
      if (s.active && s.file) {
        const send = el('button', { className: 'btn sm acc', title: 'Den Pfad in die Eingabe des Agenten einfügen' }, icon('send', 14, 1.9), 'An Agent geben');
        send.addEventListener('click', () => this.deps.insert(`[Skill: ${s.file}] `));
        actions.append(send);
      }
      if (!s.file) body.append(el('div', { className: 'c3', textContent: 'Eingeschaltet liegt der Skill als Markdown im Projekt und lässt sich ansehen.' }));
      if (actions.childElementCount) body.append(actions);
      row.append(body);
    }
    return row;
  }

  /** Für Tests. */
  state() {
    return {
      skills: this.skills.map((s) => ({ id: s.id, title: s.title, active: s.active, file: s.file, changed: s.changed, problems: s.problems })),
      busy: [...this.busy], text: this.list.innerText,
    };
  }
}
