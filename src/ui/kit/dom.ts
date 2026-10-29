/**
 * Tiny DOM helpers for the plain-DOM UI, and the kit's components built from
 * them: the button, the segmented control, the chip, key caps, links, tabs,
 * scroll hints and the toast (styled by the partials beside this file).
 *
 * Class names follow BEM (CLAUDE.md, ui/styles/main.scss): `block`,
 * `block__element`, `block--modifier`, and `is-*` for states the code toggles.
 * The helpers take extra classes as one string where a word starting with `--`
 * is a modifier of the helper's block, so `btn(icon, 'Race', go, '--primary
 * event-card__go')` is a `btn btn--primary event-card__go`.
 */
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, icon, type IconNode } from './icons';
import type { SpecBadge } from '../../shared/carSpec';

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** A block's class list: the block, then each word of `extra`, a `--word` expanded to the block's modifier (`bem('chip', '--accent x')` is 'chip chip--accent x'). */
export function bem(block: string, extra = ''): string {
  const words = extra.split(/\s+/).filter(Boolean).map((w) => (w.startsWith('--') ? block + w : w));
  return [block, ...words].join(' ');
}

/**
 * The band of light that sweeps across a control when it is hovered or
 * focused, like a streetlight passing over paint (kit/_sheen.scss): bright on
 * primary actions, faint on the rest. Clipped by the control's chamfer.
 */
export function sheen(): HTMLElement {
  return h('span', { class: 'sheen', 'aria-hidden': 'true' });
}

/** Button with a Lucide icon and label, an optional sub line under the label. `cls`: modifiers (`--primary`) and extra classes. */
export function btn(iconNode: IconNode | null, label: string, onClick: () => void, cls = '', sub?: string): HTMLButtonElement {
  const b = h('button', { class: bem('btn', cls), type: 'button', onclick: onClick });
  if (iconNode) b.append(icon(iconNode, { size: 18 }));
  const text = h('span', { class: 'btn__label' }, label);
  if (sub) text.append(h('span', { class: 'btn__sub' }, sub));
  b.append(text, sheen());
  return b;
}

/**
 * Hints that a scroller holds more than it shows (kit/_scroll-hint.scss): its edges fade where content runs
 * past them and a small chevron bobs at that edge (up at the top, down at the foot), each easing away as that
 * end is reached. Returns the wrapper to place where the scroller went (`cls`: its modifiers and extra classes).
 * Scrolling, resizes and content changes (a re-rendered list) all update it; nothing runs per frame.
 */
export function scrollHint(scroller: HTMLElement, cls = ''): HTMLElement {
  scroller.classList.add('scroll-hint__view');
  const more = (side: 'above' | 'below') => h('span', { class: bem('scroll-hint__more', `--${side}`), 'aria-hidden': 'true' }, icon(side === 'above' ? ChevronUp : ChevronDown, { size: 16 }));
  const wrap = h('div', { class: bem('scroll-hint', cls) }, scroller, more('above'), more('below'));
  let above = false;
  let below = false;
  // A pixel of slack: fractional scroll positions at the ends never quite reach them.
  const update = () => {
    const a = scroller.scrollTop > 1;
    const b = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
    if (a !== above) wrap.classList.toggle('is-above', (above = a));
    if (b !== below) wrap.classList.toggle('is-below', (below = b));
  };
  scroller.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(scroller);
  new MutationObserver(update).observe(scroller, { childList: true, subtree: true });
  // Parts rising in (the menu's opening, a garage tab's groups) overflow until they land, and nothing resizes when they do.
  scroller.addEventListener('animationend', update);
  return wrap;
}

/** A button that is only an icon, its label the tooltip and accessible name. */
export function iconBtn(iconNode: IconNode, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: bem('btn', `--icon ${cls}`), type: 'button', title: label, 'aria-label': label, onclick: onClick });
  b.append(icon(iconNode, { size: 18 }), sheen());
  return b;
}

/** A segmented control's element, and `set` to show a value picked elsewhere (without calling onChange). */
export type Segmented<T extends string> = HTMLDivElement & { set(v: T): void };

/** A segmented control: one pick among a few options, each an icon and label. `cls`: modifiers (`--wide`) and extra classes. */
export function segmented<T extends string>(options: readonly { value: T; label: string; icon?: IconNode }[], value: T, onChange: (v: T) => void, cls = ''): Segmented<T> {
  const wrap = h('div', { class: bem('segmented', cls), role: 'radiogroup' });
  const set = (v: T) => buttons.forEach((b, i) => b.classList.toggle('is-selected', options[i].value === v));
  const buttons = options.map((o) => {
    const b = h('button', { class: 'segmented__option', type: 'button', role: 'radio' });
    if (o.icon) b.append(icon(o.icon, { size: 15 }));
    b.append(o.label);
    b.addEventListener('click', () => {
      set(o.value);
      onChange(o.value);
    });
    if (o.value === value) b.classList.add('is-selected');
    wrap.append(b);
    return b;
  });
  return Object.assign(wrap, { set });
}

/**
 * A cycler: one pick among a few options on a single line whatever their number, the pick named between a
 * previous and a next arrow (wrapping round) over a row of dots, one per option, that jump straight to it.
 * An option's `mark` rings its dot (a part slot that has a part). It is one stop for the keyboard and the pad:
 * left and right step it like a slider, and the drive keys never see them. Returns a Segmented, so it drops
 * in where a segmented control was. `cls`: modifiers and extra classes.
 */
export function cycler<T extends string>(options: readonly { value: T; label: string; mark?: boolean }[], value: T, onChange: (v: T) => void, cls = ''): Segmented<T> {
  let at = Math.max(0, options.findIndex((o) => o.value === value));
  const name = h('span', { class: 'cycler__value' });
  const dots = options.map((o, i) => h('button', { class: bem('cycler__dot', o.mark ? '--marked' : ''), type: 'button', tabindex: '-1', title: o.label, 'aria-hidden': 'true', onclick: () => pick(i) }));
  const step = (d: -1 | 1, label: string, ico: IconNode) =>
    h('button', { class: 'cycler__step', type: 'button', tabindex: '-1', title: label, 'aria-hidden': 'true', onclick: () => pick(wrapIndex(at + d)) }, icon(ico, { size: 18 }));
  const wrap = h(
    'div',
    { class: bem('cycler', cls), role: 'slider', tabindex: '0', 'aria-valuemin': '0', 'aria-valuemax': String(options.length - 1) },
    step(-1, 'Previous', ChevronLeft),
    h('span', { class: 'cycler__face' }, name, h('span', { class: 'cycler__dots' }, ...dots)),
    step(1, 'Next', ChevronRight),
  );
  const wrapIndex = (i: number) => (i + options.length) % options.length;
  const show = () => {
    name.textContent = options[at].label;
    dots.forEach((d, i) => d.classList.toggle('is-selected', i === at));
    wrap.setAttribute('aria-valuenow', String(at));
    wrap.setAttribute('aria-valuetext', options[at].label);
  };
  const pick = (i: number) => {
    if (i === at) return;
    at = i;
    show();
    // The face pulses on a pick (.is-picked), restarted so quick steps each show.
    wrap.classList.remove('is-picked');
    void wrap.offsetWidth;
    wrap.classList.add('is-picked');
    onChange(options[i].value);
  };
  wrap.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    pick(wrapIndex(at + d));
  });
  show();
  return Object.assign(wrap, {
    set(v: T) {
      at = Math.max(0, options.findIndex((o) => o.value === v));
      show();
    },
  });
}

/** One option of a dropdown: its label, an optional count after it, `mark` for a yellow dot (the maker of the wheel fitted), `swatch` a color chip before it. */
export interface DropOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  mark?: boolean;
  swatch?: string;
}

/**
 * A dropdown's frame (kit/_dropdown.scss), shared by the single and the multi select: the button (an optional icon,
 * the summary, a chevron) and the menu it opens. The menu is a popover in the top layer, placed under the button (over
 * it when there is no room below), so no clipped or scrolling panel cuts it off. Escape, a click outside, the button
 * or a scroll behind it closes it; opening focuses the row `focusOnOpen` names. Returns the parts and `open`.
 */
function dropdownFrame(menu: HTMLElement, label: string, ico: IconNode | undefined, cls: string, focusOnOpen: () => HTMLElement | undefined) {
  const summary = h('span', { class: 'dropdown__summary' });
  const button = h('button', { class: 'dropdown__button', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': label }, ico && icon(ico, { size: 16 }), summary, icon(ChevronDown, { size: 16 }), sheen());
  const wrap = h('div', { class: bem('dropdown', cls) }, button, menu);
  menu.popover = 'manual';
  const outside = (e: Event) => {
    if (!wrap.contains(e.target as Node)) open(false);
  };
  // A scroll behind the menu would leave it floating away from its button; one inside the menu is its own.
  const scrolled = (e: Event) => {
    if (!menu.contains(e.target as Node)) open(false);
  };
  const place = () => {
    const r = button.getBoundingClientRect();
    const below = innerHeight - r.bottom - 8;
    const up = below < menu.offsetHeight && r.top > below;
    menu.style.setProperty('--dropdown-x', `${r.left}px`);
    menu.style.setProperty('--dropdown-w', `${r.width}px`);
    menu.style.setProperty('--dropdown-y', `${up ? r.top - 4 - menu.offsetHeight : r.bottom + 4}px`);
  };
  const open = (on: boolean) => {
    if (on === wrap.classList.contains('is-open')) return;
    if (on) {
      menu.showPopover();
      place();
    } else menu.hidePopover();
    button.setAttribute('aria-expanded', String(on));
    wrap.classList.toggle('is-open', on);
    const listen = on ? document.addEventListener.bind(document) : document.removeEventListener.bind(document);
    listen('pointerdown', outside, true);
    listen('scroll', scrolled, true);
  };
  button.addEventListener('click', () => {
    open(!wrap.classList.contains('is-open'));
    if (wrap.classList.contains('is-open')) focusOnOpen()?.focus({ preventScroll: true });
  });
  // Escape closes the menu only, not the screen behind it.
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !wrap.classList.contains('is-open')) return;
    e.preventDefault();
    e.stopPropagation();
    open(false);
    button.focus();
  });
  return { wrap, button, summary, open };
}

/** A dropdown option's row content: the swatch, the label (dotted when marked) and the count. */
const dropRow = (o: Pick<DropOption<string>, 'label' | 'count' | 'mark' | 'swatch'>): Node[] =>
  [
    o.swatch ? h('span', { class: 'dropdown__swatch', style: `background:${o.swatch}` }) : null,
    h('span', { class: bem('dropdown__label', o.mark ? '--marked' : '') }, o.label),
    o.count !== undefined ? h('span', { class: 'dropdown__count' }, String(o.count)) : null,
  ].filter((n): n is HTMLElement => n !== null);

/**
 * A single-select dropdown: the button shows the pick (its swatch and label); the menu lists every option, the
 * pick marked, and a pick closes it and calls onChange. For a few picks too long for a segmented control (what a
 * paint matches). `cls`: modifiers and extra classes.
 */
export function selectMenu<T extends string>(options: readonly DropOption<T>[], value: T, onChange: (v: T) => void, label: string, ico?: IconNode, cls = ''): HTMLElement {
  const rows = options.map((o) => h('button', { class: bem('dropdown__option', o.value === value ? 'is-selected' : ''), type: 'button', role: 'menuitemradio', 'aria-checked': String(o.value === value) }, ...dropRow(o), o.value === value ? icon(Check, { size: 15 }) : null));
  const menu = h('div', { class: 'dropdown__menu', role: 'menu', 'aria-label': label }, ...rows);
  const f = dropdownFrame(menu, label, ico, `--single ${cls}`, () => rows[Math.max(0, options.findIndex((o) => o.value === value))]);
  const at = options.find((o) => o.value === value) ?? options[0];
  f.summary.replaceChildren(...dropRow({ label: at.label, swatch: at.swatch }));
  rows.forEach((r, i) =>
    r.addEventListener('click', () => {
      f.open(false);
      f.button.focus({ preventScroll: true });
      if (options[i].value !== value) onChange(options[i].value);
    }),
  );
  return f.wrap;
}

/**
 * A multi-select dropdown: a button summing up the pick (`allLabel` while nothing narrows it, else the one or two
 * names, else how many) that opens a menu of checkboxes under it, "All" first. Ticking All clears the pick, and
 * ticking every option comes back to All. The menu stays open while options are ticked (onChange runs on each).
 * `cls`: modifiers and extra classes.
 */
export function multiSelect<T extends string>(options: readonly DropOption<T>[], selected: readonly T[], allLabel: string, onChange: (selected: T[]) => void, ico?: IconNode, cls = ''): HTMLElement {
  let pick = new Set(selected.filter((v) => options.some((o) => o.value === v)));
  const box = (o: Pick<DropOption<string>, 'label' | 'count' | 'mark'>, extra = '') => {
    const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const row = h('label', { class: bem('dropdown__option', extra) }, input, ...dropRow(o));
    return { row, input };
  };
  const all = box({ label: allLabel }, '--all');
  const rows = options.map((o) => box(o));
  const menu = h('div', { class: 'dropdown__menu', role: 'group', 'aria-label': allLabel }, all.row, ...rows.map((r) => r.row));
  const f = dropdownFrame(menu, allLabel, ico, `--multi ${cls}`, () => (rows.find((r) => r.input.checked) ?? all).input);
  const show = () => {
    all.input.checked = pick.size === 0;
    rows.forEach((r, i) => (r.input.checked = pick.has(options[i].value)));
    const names = options.filter((o) => pick.has(o.value)).map((o) => o.label);
    f.summary.textContent = !names.length ? allLabel : names.length <= 2 ? names.join(', ') : `${names.length} selected`;
    f.wrap.classList.toggle('is-narrowed', names.length > 0);
  };
  const changed = () => {
    if (pick.size === options.length) pick = new Set();
    show();
    onChange(options.filter((o) => pick.has(o.value)).map((o) => o.value));
  };
  all.input.addEventListener('change', () => {
    pick = new Set();
    changed();
  });
  rows.forEach((r, i) =>
    r.input.addEventListener('change', () => {
      if (r.input.checked) pick.add(options[i].value);
      else pick.delete(options[i].value);
      changed();
    }),
  );
  show();
  return f.wrap;
}

/** An on / off switch: a track and knob that slides across, `aria-checked` its state. `label` names it for assistive tech. */
export function onOffSwitch(on: boolean, onChange: (on: boolean) => void, label: string, cls = ''): HTMLButtonElement {
  const b = h('button', { class: bem('switch', cls), type: 'button', role: 'switch', 'aria-label': label, 'aria-checked': String(on) }, h('span', { class: 'switch__knob' }));
  b.addEventListener('click', () => {
    on = !on;
    b.setAttribute('aria-checked', String(on));
    onChange(on);
  });
  return b;
}

/** A small label chip: an optional icon and a short text. `cls`: modifiers (`--accent`, `--ink`, `--mode`, `--small`) and extra classes. */
export function chip(text: string, ico?: IconNode, cls = ''): HTMLElement {
  return h('span', { class: bem('chip', cls) }, ico && icon(ico, { size: 13 }), h('span', { class: 'chip__label' }, text));
}

/** Each spec tag's ink by its place in specBadges (drivetrain cyan, engine yellow, forced induction red): `.ink-*` in garage/_tune-stat.scss. */
const SPEC_INKS = ['ink-drive', 'ink-engine', 'ink-boost'] as const;

/** A spec tag as a chip in its ink, the long form on hover (the garage's car tiles and build card, the menu's builds). */
export function specChip(t: SpecBadge, i: number, cls = ''): HTMLElement {
  const c = chip(t.text, undefined, `--ink ${SPEC_INKS[i] ?? ''} ${cls}`);
  c.title = t.title;
  return c;
}

/** Key caps: a `<kbd>` per key with `sep` between them (the help rows ' ', the controls list ' / '); a combo written 'W + S' is its caps joined by a plus. */
export function keyCaps(keys: readonly string[], sep = ''): (HTMLElement | string)[] {
  const caps = (k: string) => k.split(' + ').flatMap((c, j) => (j ? ['+', h('kbd', {}, c)] : [h('kbd', {}, c)]));
  return keys.flatMap((k, i) => (i && sep ? [sep, ...caps(k)] : caps(k)));
}

/** A link to another site (the credits), opened in a new tab that gets neither this page nor its address. */
export function link(href: string, ...children: Child[]): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...children);
}

/** A tab of a `.tabs` tablist: its icon and label. `cls`: extra classes. */
export function tab(ico: IconNode, label: Node | string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { class: bem('tabs__tab', cls), type: 'button', role: 'tab', onclick: onClick }, icon(ico, { size: 15 }), label);
}

/** Show which tab of a tablist is open (`is-selected`, aria-selected). */
export function selectTab(tabs: readonly HTMLElement[], open: HTMLElement): void {
  for (const t of tabs) {
    t.classList.toggle('is-selected', t === open);
    t.setAttribute('aria-selected', String(t === open));
  }
}

export function toast(text: string, iconNode?: IconNode): void {
  const t = h('div', { class: 'toast panel' });
  if (iconNode) t.append(icon(iconNode, { size: 16 }));
  t.append(text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2700);
}

/** Whether a key event belongs to a text field (input, textarea, select): the screens' keys leave those alone. */
export function isTyping(e: Event): boolean {
  const t = e.target;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

/** Whether the player asked for reduced motion: slides, flights and sweeps then cut straight to their end. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
