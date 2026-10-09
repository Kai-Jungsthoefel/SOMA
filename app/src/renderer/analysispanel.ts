import type { FemBc, ResultEntry, ResultPart } from '../shared/types';
import { icon } from './icons';
import { loc, safety, worstOf, withUnit, type ResultTool } from './resulttool';
import { el, fmtWhen, menuItem, menus } from './ui';

// Reiter Analysis (E82): Liste aller Ergebnisse und der ruhige Bericht zum gezeigten. Der Bericht sagt in einer großen Zahl, ob
// es hält, darunter je eine Zeile für die Annahmen (aufklappbar), die Teile als Tabelle und Berechnung und Hinweise zum
// Aufklappen. Farbe nur als Statuszeichen. Gezeigt wird im Bild über ResultTool, hier steht nur Text.

interface Ui {
  list: HTMLElement; listCount: HTMLElement; rows: HTMLElement;
  report: HTMLElement; back: HTMLButtonElement; backCount: HTMLElement; code: HTMLButtonElement; more: HTMLButtonElement;
  body: HTMLElement; pick: HTMLElement; rerun: HTMLButtonElement; agent: HTMLButtonElement; menu: HTMLElement;
}
interface Deps {
  tool: ResultTool;
  insert(text: string): void;
  openCode(file: string): void;
  copy(text: string): void;
  /** Ist der Eintrag neu (seit dem Öffnen des Modells dazugekommen und noch nicht angesehen)? */
  isNew(r: ResultEntry): boolean;
  /** Ergebnis angesehen: kein „new“ mehr. */
  seen(r: ResultEntry): void;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const AXES: [number, string, string][] = [[2, 'upward', 'downward'], [0, 'in +X', 'in -X'], [1, 'in +Y', 'in -Y']];
/** Richtung eines Vektors in Worten, wenn er fast entlang einer Achse zeigt, sonst die Komponenten. */
function direction(v: number[]): string {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n < 1e-12) return '';
  for (const [i, pos, neg] of AXES) if (Math.abs(v[i]) / n > 0.985) return v[i] > 0 ? pos : neg;
  return `along (${v.map((x) => loc(x / n, 2)).join(', ')})`;
}
const newton = (v: number[]) => `${loc(Math.hypot(v[0], v[1], v[2]), 1)} N`;
const modulus = (e: number) => (e >= 1000 ? `${loc(e / 1000, 1)} GPa` : `${loc(e, 0)} MPa`);

export class AnalysisPanel {
  /** Bericht oder Liste. Der Bericht gehört zum gezeigten Ergebnis. */
  private mode: 'list' | 'report' = 'report';
  /** Aufgeklappte Zeilen und Abschnitte des Berichts (bleiben beim Neuberechnen, gelten je Ergebnis). */
  private openRows = new Set<string>();
  private openFor = '';

  constructor(private readonly ui: Ui, private readonly d: Deps) {
    ui.back.addEventListener('click', () => { this.mode = 'list'; this.render(); });
    ui.rerun.addEventListener('click', () => void d.tool.rerun());
    ui.agent.addEventListener('click', () => { const t = d.tool.agentNote(); if (t) d.insert(t); });
    ui.code.addEventListener('click', () => { const f = d.tool.shown?.fem?.study; if (f) d.openCode(f); });
    ui.more.addEventListener('click', () => this.openMore());
  }

  /** Reiter geöffnet: der Bericht des gezeigten Ergebnisses, ohne Ergebnisse die Liste. */
  opened(): void { this.mode = 'report'; this.render(); }

  get showing(): 'list' | 'report' { return this.d.tool.shown ? this.mode : 'list'; }

  render(): void {
    const r = this.d.tool.shown;
    const report = !!r && this.mode === 'report';
    this.ui.list.hidden = report;
    this.ui.report.hidden = !report;
    const n = this.d.tool.list.length;
    this.ui.listCount.textContent = n ? String(n) : '';
    this.ui.backCount.textContent = String(n);
    if (report) this.renderReport(r!);
    else this.renderList();
  }

  // ---- Liste ----------------------------------------------------------------------------------------------------

  private renderList(): void {
    const list = [...this.d.tool.list].sort((a, b) => b.created - a.created);
    const cur = this.d.tool.currentId;
    const rows: HTMLElement[] = list.map((r) => {
      const w = worstOf(r);
      const bad = r.parts.some((p) => p.critical > 0);
      const d = el('span', { className: 'dot' });
      d.style.background = r.stale ? 'var(--tx3)' : bad ? 'var(--err)' : 'var(--ok)';
      const meta = el('div', { className: 'm' }, `${r.fem ? 'FEM' : 'Analysis'} · ${fmtWhen(r.created * 1000, true)}`);
      if (r.stale) meta.append(' · ', el('span', { className: 'w', textContent: 'older than the code' }));
      if (this.d.isNew(r)) meta.append(' ', el('span', { className: 'tag acc', textContent: 'new' }));
      const value = w ? (r.fem ? safety(w.value) : withUnit(w.value, r.unit)) : '–';
      const limit = r.fem ? `required ${loc(r.threshold, 1)}` : `limit ${withUnit(r.threshold, r.unit)}`;
      const b = el('button', { className: 'al-row' + (r.id === cur ? ' cur' : ''), title: `${r.title}\n${r.file}` },
        d, el('div', {}, el('div', { className: 't', textContent: r.title }), meta),
        el('div', { className: 'v' }, value, el('span', { textContent: limit })));
      b.dataset.id = r.id;
      b.addEventListener('click', () => { this.mode = 'report'; this.d.seen(r); this.d.tool.show(r.id); this.render(); });
      return b;
    });
    if (!rows.length) rows.push(el('div', { className: 'al-empty', textContent: 'No analyses yet.' }));
    this.ui.rows.replaceChildren(...rows, el('div', { className: 'al-note' },
      'The agent creates analyses with ', el('code', { textContent: 'soma analyze' }), ' (skill “Analysis”): strength with FEM, wall thickness, overhang, clearance. They are kept in ',
      el('code', { textContent: '.soma/results/' }), '.'));
  }

  // ---- Bericht --------------------------------------------------------------------------------------------------

  private renderReport(r: ResultEntry): void {
    if (this.openFor !== r.id) { this.openFor = r.id; this.openRows.clear(); }
    this.d.seen(r);
    const tool = this.d.tool, busy = tool.busy;
    this.ui.code.hidden = !r.fem?.study;
    this.ui.code.title = r.fem?.study ? `Open the study file ${r.fem.study}` : '';
    this.ui.rerun.disabled = busy;
    const when = fmtWhen(r.created * 1000, true);
    const meta = el('div', { className: 'cx-meta' }, [r.fem ? 'FEM' : 'Analysis', r.seconds != null ? `${loc(r.seconds, 1)} s` : null,
      r.fem ? `${loc(r.fem.mesh.size, 2)} mm mesh` : null].filter(Boolean).join(' · ') + ' · ');
    if (busy) meta.append('recalculating …');
    else if (r.stale) meta.append(el('span', { className: 'w', textContent: 'older than the code' }));
    else meta.append(when);
    const kids: HTMLElement[] = [el('div', { className: 'cx-head' }, el('h3', { className: 'cx-title', textContent: r.title }), meta)];
    if (busy) kids.push(el('div', { className: 'cx-prog' }, el('i')));
    else if (r.stale) {
      const again = el('button', { textContent: 'Recalculate' });
      again.addEventListener('click', () => void tool.rerun());
      kids.push(el('div', { className: 'cx-line' }, icon('alert', 14, 2), `Values belong to the model as it was at ${when}.`, again));
    }
    kids.push(this.summary(r, busy), this.inputs(r), this.partsTable(r), this.calculation(r), ...this.notes(r));
    this.ui.body.replaceChildren(...kids);
    const pick = tool.pickText();
    this.ui.pick.hidden = !pick;
    this.ui.pick.textContent = pick ?? '';
    this.ui.pick.title = pick ? 'Clicked in the model. “Send to agent” passes this spot along.' : '';
  }

  /** Eine Zahl groß, darunter ob es hält, die kritischen Teile mit Sprung zur Stelle und ein Hinweis zur Netzabhängigkeit. */
  private summary(r: ResultEntry, dim: boolean): HTMLElement {
    const w = worstOf(r);
    const crit = r.parts.filter((p) => p.critical > 0).sort((a, b) => (r.bad === 'low' ? (a.min ?? 0) - (b.min ?? 0) : (b.max ?? 0) - (a.max ?? 0)));
    const value = (v: number | undefined) => (v == null ? '–' : r.fem ? safety(v) : loc(v, 2));
    const big = el('span', { className: 'n' }, w ? value(w.value) : '–', !r.fem && r.unit ? el('small', { textContent: r.unit }) : null);
    const what = r.fem ? 'lowest safety factor' : `${r.bad === 'low' ? 'smallest' : 'largest'} ${r.quantity.toLowerCase()}`;
    const req = r.fem ? `required ${loc(r.threshold, 1)}` : `limit ${withUnit(r.threshold, r.unit)}`;
    const ok = !crit.length;
    const status = ok ? (r.fem ? 'Holds the required safety' : `Nothing ${r.bad === 'low' ? 'below' : 'above'} the limit`)
      : r.fem ? `Below the required safety in ${plural(crit.length, 'part')}` : `${plural(crit.length, 'part')} ${r.bad === 'low' ? 'below' : 'above'} the limit`;
    const st = icon(ok ? 'okcirc' : 'xcirc', 16, 2);
    st.classList.add(ok ? 'ok' : 'bad');
    const box = el('div', { className: 'cx-sum' + (dim ? ' cx-dim' : '') },
      el('div', { className: 'cx-num' }, big, el('span', { className: 't' }, what, el('br'), el('span', { textContent: ok && w ? `${req} · ${w.part}` : req }))),
      el('div', { className: 'cx-st' }, st, status));
    for (const p of crit) {
      const d = el('span', { className: 'dot' });
      d.style.background = 'var(--err)';
      const go = el('button', { className: 'go', title: 'Show the spot', ariaLabel: `Show the spot in ${p.name}` }, icon('target', 14, 1.9));
      const row = el('div', { className: 'cx-pr' }, d, el('span', { className: 'nm', textContent: p.name }),
        el('span', { className: 'a', textContent: r.fem ? '' : `${loc(p.critical / 100, 2)} cm²` }),
        el('span', { className: 'v', textContent: value(r.bad === 'low' ? p.min : p.max) }), go);
      if (p.worst?.at) row.addEventListener('click', () => this.d.tool.showSpot(p.name)); else go.disabled = true;
      box.append(row);
    }
    // Hängt die Spitze am Netz, steht das hier, nicht erst in den Hinweisen: Die große Zahl ist dann nicht verlässlich
    const meshy = r.parts.filter((p) => p.coarse && Math.abs(p.coarse.change) > 0.15).map((p) => p.name);
    if (meshy.length) {
      const more = el('button', { className: 'lnk', textContent: 'Details' });
      more.addEventListener('click', () => { this.openRows.add('notes'); this.render(); this.ui.body.querySelector('.cx-fold.notes')?.scrollIntoView({ block: 'nearest' }); });
      box.append(el('div', { className: 'cx-warn' }, icon('alert', 14, 2), el('span', {}, `The peak in ${meshy.join(' and ')} depends on the mesh. `, more)));
    }
    return box;
  }

  /** Zeile mit Einzelheiten zum Aufklappen. */
  private row(key: string, label: string, value: string, sub: string, details: [string, string | HTMLElement][] | HTMLElement): HTMLElement[] {
    const open = this.openRows.has(key);
    const b = el('button', { className: 'cx-row' + (open ? ' open' : '') }, el('span', { className: 'l', textContent: label }),
      el('span', { className: 'v' }, value, sub ? el('span', { textContent: ` · ${sub}` }) : null), el('span', { className: 'ch' }, icon('right', 13, 2)));
    b.setAttribute('aria-expanded', String(open));
    b.addEventListener('click', () => { if (open) this.openRows.delete(key); else this.openRows.add(key); this.render(); });
    if (!open) return [b];
    const det = details instanceof HTMLElement ? details : el('dl', { className: 'cx-det' }, ...details.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', {}, v)]));
    return [b, det];
  }

  private inputs(r: ResultEntry): HTMLElement {
    const sec = el('section', { className: 'cx-sec' }, el('div', { className: 'cx-sh', textContent: 'INPUTS' }));
    const fem = r.fem;
    if (!fem) {
      sec.append(...this.row('limit', 'Limit', withUnit(r.threshold, r.unit), `critical ${r.bad === 'low' ? 'below' : 'above'}`, [
        ['Quantity', r.unit ? `${r.quantity} (${r.unit})` : r.quantity], ['Color scale', `${withUnit(r.range[0], r.unit)} to ${withUnit(r.range[1], r.unit)}`],
        ...(r.neutral ? [['Contact', `${withUnit(r.neutral[0], r.unit)} to ${withUnit(r.neutral[1], r.unit)}, not critical`] as [string, string]] : []),
      ]));
      sec.append(...this.row('parts', 'Parts', plural(r.parts.length, 'part'), '', r.parts.map((p) => [p.name, p.group ?? ''] as [string, string])));
      return sec;
    }
    fem.bcs.forEach((b, i) => sec.append(...this.bcRow(b, i, fem.balance)));
    if (fem.gravity && Math.hypot(...fem.gravity) > 0) {
      sec.append(...this.row('gravity', 'Gravity', `${loc(Math.hypot(...fem.gravity), 2)} m/s²`, direction(fem.gravity), [['Vector', `(${fem.gravity.map((x) => loc(x, 2)).join(', ')}) m/s²`], ['Mass', 'from the density of each material']]));
    }
    // Werkstoffe: je Werkstoff einmal, mit den Teilen dazu
    const mats = new Map<string, { m: NonNullable<ResultPart['material']>; parts: string[] }>();
    for (const p of r.parts) if (p.material) {
      const e = mats.get(p.material.name);
      if (e) e.parts.push(p.name); else mats.set(p.material.name, { m: p.material, parts: [p.name] });
    }
    if (mats.size) {
      const names = [...mats.keys()];
      const det = el('dl', { className: 'cx-det' });
      for (const { m, parts } of mats.values()) {
        det.append(el('dd', { className: 'sub' }, m.name, el('span', { textContent: ` · ${parts.length > 3 ? plural(parts.length, 'part') : parts.join(', ')}` })));
        const pairs: [string, string][] = [['E modulus', modulus(m.E)], ['Strength', `${loc(m.strength, 0)} MPa, allowable ${loc(m.strength / r.threshold, 1)} MPa`]];
        if (m.nu != null) pairs.push(['Poisson ν', loc(m.nu, 2)]);
        if (m.density != null) pairs.push(['Density', `${loc(m.density, 2)} g/cm³`]);
        if (m.note) pairs.push(['Note', m.note]);
        for (const [k, v] of pairs) det.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
      }
      sec.append(...this.row('mat', 'Material', names[0], names.slice(1).join(' · '), det));
    }
    const mesh = fem.mesh;
    const checked = r.parts.filter((p) => p.coarse);
    let check: string | HTMLElement = 'not checked with a coarser mesh';
    if (fem.coarse && checked.length) {
      const worst = [...checked].sort((a, b) => Math.abs(b.coarse!.change) - Math.abs(a.coarse!.change));
      const pct = (c: number) => `${c > 0 ? '+' : ''}${Math.round(c * 100) + 0} %`;
      const first = worst[0], rest = worst.slice(1);
      const big = Math.abs(first.coarse!.change) > 0.15;
      check = el('span', {}, `coarser mesh ${loc(fem.coarse.size, 2)} mm: `, el('span', { className: big ? 'wc' : 'okc', textContent: `${first.name} ${pct(first.coarse!.change)}` }),
        rest.length ? `, others ≤ ${Math.round(Math.max(...rest.map((p) => Math.abs(p.coarse!.change))) * 100)} %` : '');
    }
    sec.append(...this.row('mesh', 'Mesh', `${loc(mesh.size, 2)} mm`, `${mesh.elements.toLocaleString('en-US')} elements`, [
      ['Element size', `${loc(mesh.size, 2)} mm${mesh.auto == null ? '' : mesh.auto ? ', automatic from the model size' : ', set in the study'}`],
      ['Elements', `${mesh.elements.toLocaleString('en-US')} tetrahedra, 10 nodes`],
      ...(mesh.nodes ? [['Nodes', mesh.nodes.toLocaleString('en-US')] as [string, string]] : []),
      ['Check', check],
    ]));
    return sec;
  }

  private bcRow(b: FemBc, i: number, balance: number | undefined): HTMLElement[] {
    const faces: [string, string][] = [['Faces', b.label], ['Area', `${loc(b.area, 1)} mm²`]];
    if (b.kind === 'fix') {
      const axes = b.axes && b.axes !== 'xyz' ? b.axes.toUpperCase().split('').join(', ') : null;
      const det: [string, string | HTMLElement][] = [['Directions', axes ? `${axes} only` : 'all'], ...faces];
      if (b.reaction) det.push(['Reaction', `${newton(b.reaction)} ${direction(b.reaction)}`]);
      if (balance != null) det.push(['Balance', el('span', { className: balance < 0.01 ? 'okc' : 'wc', textContent: balance < 0.01 ? 'in equilibrium' : `off by ${loc(balance * 100, 1)} %` })]);
      return this.row(`bc${i}`, 'Support', axes ? `Fixed in ${axes}` : 'Fixed', `${b.part}`, det);
    }
    const total = b.total ?? [0, 0, 0];
    if (b.kind === 'pressure') {
      return this.row(`bc${i}`, 'Pressure', `${loc(b.value ?? 0, 3)} MPa`, b.part, [['Total force', `${newton(total)} ${direction(total)}`], ...faces]);
    }
    return this.row(`bc${i}`, 'Force', `${newton(total)} ${direction(total)}`.trim(), b.part, [['Vector', `(${total.map((x) => loc(x, 1)).join(', ')}) N`], ...faces]);
  }

  private partsTable(r: ResultEntry): HTMLElement {
    const fem = !!r.fem;
    const parts = [...r.parts].sort((a, b) => (r.bad === 'low' ? (a.min ?? Infinity) - (b.min ?? Infinity) : (b.max ?? -Infinity) - (a.max ?? -Infinity)));
    const head = fem ? ['Part', 'Safety', 'MPa', 'mm'] : ['Part', 'Min', 'Max', 'cm² crit.'];
    const rows = parts.map((p) => {
      const d = el('span', { className: 'dot' });
      d.style.background = p.critical > 0 ? 'var(--err)' : 'transparent';
      const cells = fem
        ? [p.min != null ? safety(p.min) : '–', p.stress ? loc(p.stress.value, 1) : '–', p.displacement ? loc(p.displacement.value, 3) : '–']
        : [p.min != null ? loc(p.min, 2) : '–', p.max != null ? loc(p.max, 2) : '–', p.critical > 0 ? loc(p.critical / 100, 2) : '–'];
      return el('tr', {}, el('td', { className: 'nm', title: p.name }, d, p.name), ...cells.map((c) => el('td', { textContent: c })));
    });
    return el('section', { className: 'cx-sec' },
      el('div', { className: 'cx-sh' }, 'PARTS ', el('span', { className: 'cnt', textContent: String(parts.length) }),
        el('span', { className: 'r', textContent: fem ? 'by safety' : `by ${r.bad === 'low' ? 'smallest' : 'largest'} value` })),
      el('table', { className: 'cx-tbl' }, el('thead', {}, el('tr', {}, ...head.map((h, i) => el('th', { className: i ? '' : 'l', textContent: h })))), el('tbody', {}, ...rows)));
  }

  /** Abschnitt zum Aufklappen (Berechnung, Hinweise). */
  private fold(key: string, title: string, right: string, body: HTMLElement[]): HTMLElement[] {
    const open = this.openRows.has(key);
    const b = el('button', { className: `cx-fold ${key}` }, el('span', { className: 'chev' }, icon(open ? 'down' : 'right', 13, 2)), title, el('span', { className: 'r', textContent: right }));
    b.setAttribute('aria-expanded', String(open));
    b.addEventListener('click', () => { if (open) this.openRows.delete(key); else this.openRows.add(key); this.render(); });
    return open ? [b, ...body] : [b];
  }

  private calculation(r: ResultEntry): HTMLElement {
    const fem = r.fem;
    const pairs: [string, string | HTMLElement][] = [];
    if (r.seconds != null) pairs.push(['Duration', `${loc(r.seconds, 1)} s, finished ${fmtWhen(r.created * 1000, true)}`]);
    else pairs.push(['Finished', fmtWhen(r.created * 1000, true)]);
    if (fem) {
      pairs.push(['Unknowns', fem.mesh.dofs.toLocaleString('en-US')], ['Solver', fem.mesh.solver]);
      if (fem.balance != null) pairs.push(['Equilibrium', `deviation ${loc(fem.balance * 100, 2)} %`]);
      pairs.push(['Model', 'linear elastic, small deformations, parts bonded'], ['Study', el('code', { textContent: fem.study })]);
    }
    pairs.push(['Command', el('code', { textContent: `soma ${r.command.join(' ')}` })], ['Result', el('code', { textContent: r.file })]);
    const det = el('dl', { className: 'cx-det wide' }, ...pairs.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', {}, v)]));
    const right = [r.seconds != null ? `${loc(r.seconds, 1)} s` : null, fem ? fem.mesh.solver.split(',')[0] : null].filter(Boolean).join(' · ');
    const box = el('div', {}, ...this.fold('calc', 'CALCULATION', right, [det]));
    return box;
  }

  private notes(r: ResultEntry): HTMLElement[] {
    const notes = r.notes ?? [];
    if (!notes.length) return [];
    // Warnung: Netz, große Verformung, Spitze an der Einspannung. Sonst ein Hinweis (Werkstoff)
    const body = notes.map((t) => {
      const warn = /mesh|deformation is large|peak/i.test(t);
      return el('div', { className: 'cx-p ' + (warn ? 'w' : 'i') }, icon(warn ? 'alert' : 'info', 14, 2), el('span', { textContent: t }));
    });
    return this.fold('notes', 'NOTES', String(notes.length), body);
  }

  private openMore(): void {
    const r = this.d.tool.shown;
    if (!r) return;
    const m = this.ui.menu;
    m.replaceChildren(
      el('div', { className: 'mh', textContent: r.title }),
      menuItem('Copy command', { icon: 'copy', sub: `soma ${r.command.join(' ')}`, onClick: () => this.d.copy(`soma ${r.command.join(' ')}`) }),
      menuItem('Show the model', { icon: 'cube', onClick: () => this.d.tool.setActive(false) }),
    );
    menus.toggle(m, this.ui.more, 'right');
  }

  /** Prüfhilfe: was der Reiter zeigt. */
  state() {
    const q = (s: string) => [...this.ui.body.querySelectorAll<HTMLElement>(s)].map((x) => x.textContent ?? '');
    return {
      mode: this.ui.report.hidden ? 'list' : 'report',
      list: [...this.ui.rows.querySelectorAll<HTMLElement>('.al-row')].map((x) => ({ id: x.dataset.id, text: x.textContent, cur: x.classList.contains('cur'), isNew: !!x.querySelector('.tag') })),
      title: this.ui.body.querySelector('.cx-title')?.textContent ?? null, meta: this.ui.body.querySelector('.cx-meta')?.textContent ?? null,
      number: this.ui.body.querySelector('.cx-num .n')?.textContent ?? null, status: this.ui.body.querySelector('.cx-st')?.textContent ?? null,
      critical: q('.cx-pr'), warn: this.ui.body.querySelector('.cx-warn')?.textContent ?? null, stale: this.ui.body.querySelector('.cx-line')?.textContent ?? null,
      inputs: q('.cx-row'), details: q('.cx-det'), table: [...this.ui.body.querySelectorAll('.cx-tbl tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent)),
      folds: q('.cx-fold'), notes: q('.cx-p'), pick: this.ui.pick.hidden ? null : this.ui.pick.textContent,
    };
  }

  /** Prüfhilfe: eine Zeile oder einen Abschnitt des Berichts auf- oder zuklappen. */
  testToggle(key: string): void { if (this.openRows.has(key)) this.openRows.delete(key); else this.openRows.add(key); this.render(); }
}
