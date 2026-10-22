/**
 * Tiny DOM helpers for the plain-DOM UI, and the kit's components built from
 * them: the button, the segmented control, the chip, key caps, links, tabs
 * and the toast (styled by the partials beside this file).
 *
 * Class names follow BEM (CLAUDE.md, ui/styles/main.scss): `block`,
 * `block__element`, `block--modifier`, and `is-*` for states the code toggles.
 * The helpers take extra classes as one string where a word starting with `--`
 * is a modifier of the helper's block, so `btn(icon, 'Race', go, '--primary
 * event-card__go')` is a `btn btn--primary event-card__go`.
 */
import { icon, type IconNode } from './icons';

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

/** A small label chip: an optional icon and a short text. `cls`: modifiers (`--accent`, `--ink`, `--mode`, `--small`) and extra classes. */
export function chip(text: string, ico?: IconNode, cls = ''): HTMLElement {
  return h('span', { class: bem('chip', cls) }, ico && icon(ico, { size: 13 }), h('span', { class: 'chip__label' }, text));
}

/** Key caps: a `<kbd>` per key with `sep` between them (the help rows ' ', the controls list ' / '). */
export function keyCaps(keys: readonly string[], sep = ''): (HTMLElement | string)[] {
  return keys.flatMap((k, i) => (i && sep ? [sep, h('kbd', {}, k)] : [h('kbd', {}, k)]));
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
