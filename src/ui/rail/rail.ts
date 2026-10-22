/**
 * The rail: the one layout every full screen menu shares (main menu, pause,
 * results, garage). An opaque column down the left edge with a straight right
 * side and the accent rule down it, so the text never depends on the 3D scene
 * behind it (the main menu and the garage draw only a scrim there, their cards
 * being plates of their own); the scene keeps the rest of the screen and is
 * framed to the free area beside the rail (railInset, GameRenderer.setFraming). Parts:
 *  - railScreen: the screen root with the rail's background and edge.
 *  - screenHead: back button, the screen's icon and title, an aside on the right.
 *  - The help button (ui/panels/help.ts) holds every screen's keys and tips; it
 *    stands beside the music player, off the rail.
 *  - navRow: a row in a list of places or actions (the menu's Garage, Explore
 *    and Settings, the pause screen's actions), each in its own hue.
 *  - RailSteps: a screen's steps, sliding (the menu's, the pause screen's).
 * Sizes live in _rail.scss (`--rail-*`); on narrow screens the rail turns
 * into a sheet over the bottom of the screen.
 */
import { bem, h, iconBtn, prefersReducedMotion, sheen } from '../kit/dom';
import { ArrowLeft, ChevronRight, icon, type IconNode } from '../kit/icons';

type Child = Node | null | false | undefined;

/** A full screen with the rail down its left side; `cls` names the screen (menu-screen, pause-screen, results-screen) and its rail modifiers (`--scrim`). */
export function railScreen(cls: string, ...children: Child[]): HTMLElement {
  return h('div', { class: `screen ${bem('rail', cls)}` }, h('div', { class: 'rail__bg', 'aria-hidden': 'true' }), h('div', { class: 'rail__edge', 'aria-hidden': 'true' }), ...children);
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
    o.back && iconBtn(ArrowLeft, o.backLabel ?? 'Back (Esc)', o.back, '--small screen-head__back'),
    h('h2', { class: 'screen-head__title' }, icon(o.icon, { size: 20 }), h('span', { class: 'screen-head__text' }, o.title)),
    o.aside ?? null,
  );
}

/** The hues a row can wear (`.hue-*` in styles/base/_tokens.scss): the palette's accents. */
export type Hue = 'orange' | 'yellow' | 'red' | 'green' | 'cyan' | 'purple';

/**
 * A row in a list of places or actions: a badge in its hue with the icon, the
 * label over a one-line sub, and a chevron. The badge is dim at rest and
 * lights, with the row's edge and wash, on hover and focus.
 */
export function navRow(ico: IconNode, label: string, sub: string, hue: Hue, onClick: () => void, cls = ''): HTMLButtonElement {
  return h(
    'button',
    { class: bem('nav-row', `hue-${hue} ${cls}`), type: 'button', onclick: onClick },
    h('span', { class: 'nav-row__badge' }, icon(ico, { size: 20 })),
    h('span', { class: 'nav-row__text' }, h('span', { class: 'nav-row__label' }, label), h('span', { class: 'nav-row__sub' }, sub)),
    icon(ChevronRight, { size: 18 }),
    sheen(),
  );
}

/** How long a step takes to slide away (ms; `.rail__step.is-leaving` in _rail.scss). */
const STEP_LEAVE_MS = 260;

/**
 * A screen's steps in its rail column, one at a time (`.rail__step`): show()
 * puts the next one in, and the old one leaves from where it stands, out of
 * the flow, toward the side it came from, while the new one cascades in from
 * the other (_rail.scss).
 */
export class RailSteps {
  /** The step on screen. */
  current: HTMLElement | null = null;

  constructor(private readonly col: HTMLElement) {}

  /** Show a step holding `children`, sliding `dir` (null, the first step or reduced motion: at once). Returns whether it slid. */
  show(children: Child[], dir: 'fwd' | 'back' | null): boolean {
    const next = h('div', { class: 'rail__step' }, ...children);
    const slid = swapStep(this.col, this.current, next, dir);
    this.current = next;
    return slid;
  }
}

function swapStep(col: HTMLElement, old: HTMLElement | null, next: HTMLElement, dir: 'fwd' | 'back' | null): boolean {
  const slide = !!old && !!dir && !prefersReducedMotion();
  if (old && dir && slide) {
    old.style.top = `${old.offsetTop}px`;
    const way = dir === 'back' ? 'is-back' : 'is-forward';
    old.classList.add('is-leaving', way);
    old.setAttribute('aria-hidden', 'true');
    old.inert = true;
    next.classList.add('is-entering', way);
    col.append(next);
    col.scrollTop = 0;
    setTimeout(() => old.remove(), STEP_LEAVE_MS);
  } else {
    old?.remove();
    col.append(next);
  }
  return slide;
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
  const bg = root?.querySelector<HTMLElement>('.rail__bg') ?? null;
  if (!bg || document.body.classList.contains('is-cinematic')) return { left: 0, bottom: 0 };
  const r = bg.getBoundingClientRect();
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  if (r.width === 0 || r.height === 0) return { left: 0, bottom: 0 };
  // A sheet: full width, starting part way down.
  if (r.width >= w - 1) return { left: 0, bottom: r.top > 1 && r.top < hgt ? hgt - r.top : 0 };
  return { left: Math.max(0, r.right), bottom: 0 };
}
