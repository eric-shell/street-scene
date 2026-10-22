/**
 * The rail: the one layout every full screen menu shares (main menu, pause,
 * results, garage). An opaque column down the left edge with a straight right
 * side and the accent rule down it, so the text never depends on the 3D scene
 * behind it; the scene keeps the rest of the screen and is framed to
 * the free area beside the rail (railInset, GameRenderer.setFraming). Parts:
 *  - railScreen: the screen root with the rail's background and edge.
 *  - screenHead: back button, the screen's icon and title, an aside on the right.
 *  - keybar: the key legend along the bottom of the rail. Plain hints only show
 *    with a keyboard; hints with an action stay as buttons on touch screens.
 *  - navRow: a row in a list of places or actions (the menu's Garage, Explore
 *    and Settings, the pause screen's actions), each in its own hue.
 *  - swapStep: a screen's steps slide (the menu's, the pause screen's).
 * Sizes live in styles/rail/_rail.scss (`--rail-*`); on narrow screens the rail
 * turns into a sheet over the bottom of the screen.
 */
import { h, iconBtn, sheen } from './dom';
import { ArrowLeft, ChevronRight, icon, type IconNode } from './icons';

type Child = Node | null | false | undefined;

/** A full screen with the rail down its left side; `cls` names the screen (home, pause, results). */
export function railScreen(cls: string, ...children: Child[]): HTMLElement {
  return h('div', { class: `screen rail-screen ${cls}`.trim() }, h('div', { class: 'rail-bg', 'aria-hidden': 'true' }), h('div', { class: 'rail-edge', 'aria-hidden': 'true' }), ...children);
}

export interface ScreenHeadOptions {
  icon: IconNode;
  title: string;
  /** Shows a back button (Escape does the same wherever the screen handles it). */
  back?: () => void;
  backLabel?: string;
  /** Anything on the right: a chip, a value, an action. */
  aside?: Child;
}

/** A screen's header: back, its icon and title, and an aside. Every rail screen opens with one (the home step has the logo instead). */
export function screenHead(o: ScreenHeadOptions): HTMLElement {
  return h(
    'div',
    { class: 'screen-head' },
    o.back && iconBtn(ArrowLeft, o.backLabel ?? 'Back (Esc)', o.back, 'small back'),
    h('h2', { class: 'screen-title' }, icon(o.icon, { size: 20 }), h('span', {}, o.title)),
    o.aside ?? null,
  );
}

export interface KeyHint {
  /** Key caps, alternatives shown side by side (e.g. ['W', 'Space']). */
  keys: string[];
  label: string;
  /** Makes the hint a button that does the same as the key (kept on touch screens). */
  action?: () => void;
  title?: string;
}

/** The key legend along the bottom of a rail. */
export function keybar(items: KeyHint[]): HTMLElement {
  return h(
    'div',
    { class: 'keybar' },
    ...items.map((k) => {
      const caps = k.keys.map((key) => h('kbd', {}, key));
      return k.action
        ? h('button', { class: 'key key-action', type: 'button', title: k.title ?? k.label, onclick: k.action }, ...caps, h('span', {}, k.label))
        : h('span', { class: 'key' }, ...caps, h('span', {}, k.label));
    }),
  );
}

/** The hues a row can wear (`.hue-*` in styles/menu/_nav.scss): the palette's accents. */
export type Hue = 'orange' | 'yellow' | 'red' | 'green' | 'cyan' | 'purple';

/**
 * A row in a list of places or actions: a badge in its hue with the icon, the
 * label over a one-line sub, and a chevron. The badge is dim at rest and
 * lights, with the row's edge and wash, on hover and focus.
 */
export function navRow(ico: IconNode, label: string, sub: string, hue: Hue, onClick: () => void, cls = ''): HTMLButtonElement {
  return h(
    'button',
    { class: `nav-item hue-${hue} ${cls}`.trim(), type: 'button', onclick: onClick },
    h('span', { class: 'nav-badge' }, icon(ico, { size: 20 })),
    h('span', { class: 'nav-text' }, h('span', { class: 'nav-label' }, label), h('span', { class: 'nav-sub' }, sub)),
    icon(ChevronRight, { size: 18 }),
    sheen(),
  );
}

/** How long a step takes to slide away (ms; `.menu-step.leave` in styles/menu/_home.scss). */
export const STEP_LEAVE_MS = 260;

/**
 * Swap a screen's step in its column: the old step leaves from where it
 * stands, out of the flow, toward the side it came from, while the new one
 * cascades in from the other (`.menu-step` in styles/menu/_home.scss). `dir` null, no old step or
 * reduced motion swap at once. Returns whether it slid.
 */
export function swapStep(col: HTMLElement, old: HTMLElement | null, next: HTMLElement, dir: 'fwd' | 'back' | null): boolean {
  const slide = !!old && !!dir && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (old && dir && slide) {
    old.style.top = `${old.offsetTop}px`;
    old.classList.add('leave', dir);
    old.setAttribute('aria-hidden', 'true');
    old.inert = true;
    next.classList.add('enter', dir);
    col.append(next);
    col.scrollTop = 0;
    setTimeout(() => old.remove(), STEP_LEAVE_MS);
  } else {
    old?.remove();
    col.append(next);
  }
  return slide;
}

/** A small label chip: an optional icon and a short text. */
export function chip(text: string, ico?: IconNode, cls = ''): HTMLElement {
  return h('span', { class: `chip ${cls}`.trim() }, ico && icon(ico, { size: 13 }), h('span', {}, text));
}

export interface Inset {
  /** Screen covered from the left (CSS px): the rail's right edge. */
  left: number;
  /** Screen covered from the bottom (CSS px): a rail turned bottom sheet on a narrow screen. */
  bottom: number;
}

/**
 * How much of the screen the rail inside `root` covers, for framing the 3D
 * view beside it: from the left on wide screens, from the bottom where it is a
 * sheet. Zero when there is no rail, it is hidden, or it covers everything.
 * Reads layout, so call it when the screen changes or resizes, not per frame.
 */
export function railInset(root: ParentNode | null = document): Inset {
  const bg = root?.querySelector<HTMLElement>('.rail-bg') ?? null;
  if (!bg || document.body.classList.contains('cinematic')) return { left: 0, bottom: 0 };
  const r = bg.getBoundingClientRect();
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  if (r.width === 0 || r.height === 0) return { left: 0, bottom: 0 };
  // A sheet: full width, starting part way down.
  if (r.width >= w - 1) return { left: 0, bottom: r.top > 1 && r.top < hgt ? hgt - r.top : 0 };
  return { left: Math.max(0, r.right), bottom: 0 };
}
