/**
 * The full map's card by the pointer: what is under it (a place, you, the
 * waypoint, the start or finish), which grid cell, how far and which way from
 * you, and badges for drift zones, shortcuts and where you are. On touch a
 * tap pins it, with a button that sets or clears the waypoint. FullMap
 * decides the contents; this only touches the DOM when they change and keeps
 * the card inside the map.
 */
import { bem, btn, h } from '../kit/dom';
import { Disc3, MapPin, Navigation, Navigation2, Route, icon, type IconNode } from '../kit/icons';

/** What the card says. */
export interface TipContent {
  name: string;
  /** The card's accent (CSS color). */
  ink: string;
  /** A note under the name ('' for none). */
  kind: string;
  /** Distance and direction from you, or 'Here'; the arrow turns to `bearing` (deg). */
  far: string;
  bearing: number;
  /** Grid cell ("C4"), or ''. */
  cell: string;
  drift: boolean;
  short: boolean;
  here: boolean;
  /** The hint of what a click does ('' for none). */
  act: string;
  /** The pinned card's button label ('' hides it). */
  button: string;
  /** A tapped card that stays (touch). */
  pinned: boolean;
}

export class MapTip {
  readonly el: HTMLDivElement;
  private readonly name: HTMLElement;
  private readonly cell: HTMLElement;
  private readonly kind: HTMLElement;
  private readonly far: HTMLElement;
  private readonly arrow: HTMLElement;
  private readonly drift: HTMLElement;
  private readonly short: HTMLElement;
  private readonly here: HTMLElement;
  private readonly act: HTMLElement;
  private readonly btn: HTMLButtonElement;
  private key = '';
  private w = 0;
  private h = 0;

  /** `onAction` runs when the pinned card's button is pressed. */
  constructor(onAction: () => void) {
    this.name = h('b', { class: 'map-tip__name' });
    this.cell = h('span', { class: 'map-tip__cell' });
    this.kind = h('div', { class: 'map-tip__kind' });
    this.arrow = h('span', { class: 'map-tip__arrow' }, icon(Navigation2, { size: 12 }));
    this.far = h('span', {});
    const badge = (kind: string, ico: IconNode, text: string) => h('span', { class: bem('chip', `--small map-tip__badge map-tip__badge--${kind}`) }, icon(ico, { size: 12 }), h('span', { class: 'chip__label' }, text));
    this.drift = badge('drift', Disc3, 'Drift zone');
    this.short = badge('shortcut', Route, 'Shortcut');
    this.here = badge('here', Navigation, 'You are here');
    this.act = h('div', { class: 'map-tip__action' });
    this.btn = btn(MapPin, 'Set waypoint', onAction, '--small --primary map-tip__button');
    this.el = h(
      'div',
      { class: 'map-tip', 'aria-hidden': 'true' },
      h('div', { class: 'map-tip__head' }, h('i', { class: 'map-dot' }), this.name, this.cell),
      this.kind,
      h('div', { class: 'map-tip__distance' }, this.arrow, this.far),
      h('div', { class: 'map-tip__badges' }, this.drift, this.short, this.here),
      this.act,
      this.btn,
    );
  }

  /** Show the card with these contents (the DOM is only touched when they change). */
  show(t: TipContent): void {
    const key = `${t.name}|${t.ink}|${t.kind}|${t.far}|${t.cell}|${t.drift}|${t.short}|${t.here}|${t.act}|${t.button}`;
    if (key === this.key) return;
    this.key = key;
    this.el.style.setProperty('--ink', t.ink);
    this.name.textContent = t.name;
    this.cell.textContent = t.cell;
    this.kind.textContent = t.kind;
    this.kind.hidden = !t.kind;
    this.far.textContent = t.far;
    this.arrow.hidden = t.far === 'Here';
    this.arrow.style.transform = `rotate(${Math.round(t.bearing)}deg)`;
    this.drift.hidden = !t.drift;
    this.short.hidden = !t.short;
    this.here.hidden = !t.here;
    this.act.textContent = t.act;
    this.act.hidden = !t.act;
    this.btn.hidden = !t.button;
    if (t.button) (this.btn.querySelector('.btn__label') as HTMLElement).textContent = t.button;
    this.el.classList.add('is-visible');
    this.el.classList.toggle('is-pinned', t.pinned);
    this.w = 0;
  }

  /** Put the card by the pointer (x, y in CSS px), flipped to stay inside a W x H map. */
  place(x: number, y: number, W: number, H: number): void {
    if (!this.w) {
      this.w = this.el.offsetWidth;
      this.h = this.el.offsetHeight;
    }
    const off = 16;
    let left = x + off;
    let top = y + off;
    if (left + this.w > W - 8) left = x - off - this.w;
    if (top + this.h > H - 8) top = y - off - this.h;
    left = Math.max(8, Math.min(W - 8 - this.w, left));
    top = Math.max(28, Math.min(H - 8 - this.h, top));
    this.el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  hide(): void {
    if (!this.el.classList.contains('is-visible')) return;
    this.el.classList.remove('is-visible', 'is-pinned');
    this.key = '';
  }

  /** Rewrite the contents on the next show, even if they look the same. */
  invalidate(): void {
    this.key = '';
  }

  /** Measure the card again before placing it (the map was resized). */
  remeasure(): void {
    this.w = 0;
  }
}
