import { AI_KEY_PROVIDERS, EFFORT_LABEL, isRecommendedModel, RECOMMENDED_EFFORT, type AiModel, type Effort } from '../shared/somaai';
import type { SomaApi } from '../shared/types';
import { icon } from './icons';
import { el, menuItem, menus } from './ui';

/*
 * Parts of SOMA AI that the chat (chat.ts) and Settings > SOMA AI (aisettings.ts) both show: the form for an API key
 * and the model menu with its search. One place, so both look and behave the same.
 */

interface KeyFormDeps {
  api: SomaApi;
  toast(text: string, kind?: 'ok' | 'info' | 'error'): void;
  /** The key is saved (pi of the open model restarts with it, main.ts). */
  saved(provider: string): void | Promise<void>;
}

/** Provider, key, "Save key" and where to get a key. A refused key says why below the field. */
export function keyForm(deps: KeyFormDeps): HTMLElement[] {
  const select = el('select', { className: 'ai-field' });
  for (const p of AI_KEY_PROVIDERS) select.append(el('option', { value: p.id, textContent: p.label }));
  select.setAttribute('aria-label', 'Provider');
  const key = el('input', { className: 'ai-field grow', type: 'password', placeholder: AI_KEY_PROVIDERS[0].placeholder, autocomplete: 'off' });
  key.setAttribute('aria-label', 'API key');
  select.addEventListener('change', () => { key.placeholder = AI_KEY_PROVIDERS.find((p) => p.id === select.value)?.placeholder ?? ''; });
  const err = el('div', { className: 'ai-err' });
  const save = el('button', { className: 'btn sm', textContent: 'Save key' });
  const doSave = async () => {
    save.disabled = true;
    err.textContent = '';
    const r = await deps.api.ai.saveKey(select.value, key.value).catch((e) => ({ ok: false, error: String(e) }));
    save.disabled = false;
    if (!r.ok) { err.textContent = r.error ?? 'The key could not be saved.'; return; }
    key.value = '';
    deps.toast(`API key saved for ${AI_KEY_PROVIDERS.find((p) => p.id === select.value)?.label ?? select.value}.`);
    await deps.saved(select.value);
  };
  save.addEventListener('click', () => void doSave());
  key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void doSave(); } });
  const help = el('button', { className: 'lnk' }, 'How do I get a key?', icon('openext', 12, 2));
  help.addEventListener('click', () => {
    const url = AI_KEY_PROVIDERS.find((p) => p.id === select.value)?.keyUrl;
    if (url) void deps.api.openUrl(url);
  });
  return [el('div', { className: 'ai-keyrow' }, select, key), err, el('div', { className: 'acts' }, save, el('span', { className: 'grow' }), help)];
}

interface MenuEntry { label: string; sub?: string; find: string; on?: boolean; onClick(): void }
interface MenuSection { title: string; entries: MenuEntry[]; scroll?: boolean }
interface SearchMenuOptions { placeholder: string; empty: string; align?: 'left' | 'right' }

/**
 * The model menu: the recommended models first, a search at the top (wish of the user: with OpenRouter or several
 * sign-ins the list has hundreds of models).
 */
export function showModelMenu(menu: HTMLElement, anchor: HTMLElement, models: AiModel[], current: { provider: string; id: string } | null,
  pick: (m: AiModel) => void, align: 'left' | 'right' = 'right'): void {
  const entry = (m: AiModel): MenuEntry => ({
    label: m.name, sub: models.some((x) => x !== m && x.name === m.name) ? m.provider : undefined, find: `${m.name} ${m.id} ${m.provider}`,
    on: current?.id === m.id && current?.provider === m.provider, onClick: () => pick(m),
  });
  const rec = models.filter((m) => isRecommendedModel(m.id)).map(entry);
  const rest = models.filter((m) => !isRecommendedModel(m.id)).sort((a, b) => a.name.localeCompare(b.name)).map(entry);
  searchMenu(menu, anchor, [
    ...(rec.length ? [{ title: 'RECOMMENDED FOR THE BEST RESULTS', entries: rec }] : []),
    { title: rec.length ? 'OTHER MODELS' : 'MODELS', entries: rest, scroll: true },
  ], { placeholder: 'Search models …', empty: 'No models: sign in first.', align });
}

/** What the effort button shows: "High effort", "Effort off". */
export const effortText = (e: Effort) => (e === 'off' ? 'Effort off' : `${EFFORT_LABEL[e]} effort`);

/**
 * The effort menu: the levels the model supports (all of pi's in Settings, where no model runs), the recommended one
 * marked (wish of the user: more effort gives better models).
 */
export function showEffortMenu(menu: HTMLElement, anchor: HTMLElement, levels: Effort[], current: Effort | null, pick: (e: Effort) => void,
  align: 'left' | 'right' = 'right'): void {
  const items: HTMLElement[] = [el('div', { className: 'mh', textContent: 'EFFORT' })];
  for (const e of levels) {
    const b = menuItem(EFFORT_LABEL[e], { icon: e === current ? 'check' : undefined, sub: e === RECOMMENDED_EFFORT ? 'Recommended' : undefined, onClick: () => pick(e) });
    b.dataset.effort = e;
    items.push(b);
  }
  const only = levels.length <= 1;
  items.push(el('div', { className: 'mnote', textContent: only
    ? 'This model has no effort setting.'
    : `More effort: SOMA AI thinks longer and builds better models, but answers more slowly and uses more of your plan or credit. We recommend ${EFFORT_LABEL[RECOMMENDED_EFFORT]} or more.` }));
  menu.onkeydown = null;
  menu.replaceChildren(...items);
  menus.toggle(menu, anchor, align);
}

/** A menu with a search at the top. Enter takes the first match, the arrows walk through the list. */
export function searchMenu(menu: HTMLElement, anchor: HTMLElement, sections: MenuSection[], o: SearchMenuOptions): void {
  const groups = sections.map((s) => {
    const items = s.entries.map((e) => {
      const b = menuItem(e.label, { icon: e.on ? 'check' : undefined, sub: e.sub, onClick: () => e.onClick() });
      b.dataset.find = e.find.toLowerCase();
      return b;
    });
    const box = el('div', {}, el('div', { className: 'mh', textContent: s.title }), s.scroll ? el('div', { className: 'ai-menu-scroll' }, ...items) : el('div', {}, ...items));
    box.hidden = !items.length && sections.length > 1;
    return { box, items };
  });
  const all = groups.flatMap((g) => g.items);
  const search = el('input', { className: 'ai-field ai-msearch', placeholder: o.placeholder, autocomplete: 'off' });
  search.setAttribute('aria-label', o.placeholder.replace(/ …$/, ''));
  const none = el('div', { className: 'mnote', textContent: all.length ? 'Nothing matches.' : o.empty });
  none.hidden = all.length > 0;
  menu.replaceChildren(search, ...groups.flatMap((g, i) => (i ? [el('div', { className: 'msep' }), g.box] : [g.box])), none);
  const shown = () => all.filter((b) => !b.hidden);
  let bottom = 0;
  search.addEventListener('input', () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const b of all) b.hidden = !words.every((w) => (b.dataset.find ?? '').includes(w));
    for (const g of groups) g.box.hidden = !g.items.some((b) => !b.hidden);
    // A separator only between two groups that show something
    menu.querySelectorAll<HTMLElement>(':scope > .msep').forEach((sep) => {
      sep.hidden = !!(sep.previousElementSibling as HTMLElement | null)?.hidden || !!(sep.nextElementSibling as HTMLElement | null)?.hidden;
    });
    none.hidden = shown().length > 0;
    // Opened above the button: it stays on the button while the list gets shorter
    if (bottom) menu.style.top = `${Math.max(8, bottom - menu.offsetHeight)}px`;
  });
  menu.onkeydown = (e) => {
    const list = shown();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Enter' && e.target === search) { e.preventDefault(); list[0]?.click(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[Math.min(at + 1, list.length - 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (at <= 0) search.focus(); else list[at - 1].focus(); }
  };
  menus.toggle(menu, anchor, o.align ?? 'right');
  if (!menus.isOpen(menu)) return;
  const box = menu.getBoundingClientRect();
  if (box.bottom <= anchor.getBoundingClientRect().top) bottom = box.bottom;
  search.focus();
}
