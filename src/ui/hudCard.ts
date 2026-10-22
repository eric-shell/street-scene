/**
 * The HUD card: the one top left card the drone (Explore), free roam and
 * every race share, so all of them read alike and stay alike. A chamfered
 * plate like the menu's cards, its rule in the place's hue (the menu's: Explore
 * cyan, free roam green, each race type its own): a badge and the title over a
 * status line with Exit (a race's Pause) in the corner, three or four
 * readouts, then a foot of the caller's actions with the hide button on the
 * right. The keys live behind the screen's help button (ui/help.ts).
 *
 * H hides the HUD wherever a card is up: the whole UI layer and the music
 * player fade as they do in the menu's cinematic mode, and a small tag in the
 * top left corner brings them back (H again, or a click). One key listener for
 * every card, so a free roam card under the photo drone's never toggles twice.
 */
import { h, btn, iconBtn } from './dom';
import { EyeOff, X, icon, type IconNode } from './icons';
import type { Hue } from './rail';
import { helpOpen } from './help';

export interface HudCardOptions {
  /** The place's hue, the menu row's. */
  hue: Hue;
  icon: IconNode;
  title: string;
  /** The status line under the title (flight mode, district). */
  status: string;
  /** The readouts' labels (three or four, in equal columns); setStat writes their values. */
  stats: readonly string[];
  /** Buttons on the left of the foot. */
  actions?: HTMLElement[];
  onExit: () => void;
  /** The corner button's label and icon (default Exit with an X; a race's is Pause). */
  exitLabel?: string;
  exitIcon?: IconNode;
  /** Its tooltip, e.g. Back to the car (default the label). */
  exitTitle?: string;
  /** Whether H may hide the HUD right now (not while paused or a map is open); default always. */
  canHide?: () => boolean;
}

export class HudCard {
  readonly el: HTMLElement;
  private statusEl: HTMLElement;
  private values: HTMLElement[];

  constructor(readonly o: HudCardOptions) {
    this.statusEl = h('span', { class: 'hud-card-status' }, o.status);
    this.values = o.stats.map(() => h('b', {}, '–'));
    this.el = h(
      'div',
      { class: `hud-card hue-${o.hue}` },
      h(
        'div',
        { class: 'hud-card-head' },
        h('span', { class: 'hud-card-badge' }, icon(o.icon, { size: 20 })),
        h('div', { class: 'hud-card-title' }, h('b', {}, o.title), this.statusEl),
        btn(o.exitIcon ?? X, o.exitLabel ?? 'Exit', o.onExit, 'small hud-card-exit'),
      ),
      h('div', { class: 'hud-card-stats' }, ...o.stats.map((label, i) => h('div', { class: 'hud-card-stat' }, h('span', {}, label), this.values[i]))),
      h(
        'div',
        { class: 'hud-card-actions' },
        ...(o.actions ?? []),
        h('span', { class: 'grow' }),
        iconBtn(EyeOff, 'Hide HUD (H)', () => setHudHidden(true), 'small'),
      ),
    );
    this.el.querySelector('.hud-card-exit')?.setAttribute('title', o.exitTitle ?? o.exitLabel ?? 'Exit');
    cards.add(this);
  }

  /** The status line; writes the DOM only when it changes (called per frame). */
  setStatus(text: string): void {
    if (this.statusEl.textContent !== text) this.statusEl.textContent = text;
  }

  /** Readout `i`; writes the DOM only when it changes (called per frame). */
  setStat(i: number, text: string): void {
    const v = this.values[i];
    if (v && v.textContent !== text) v.textContent = text;
  }

  dispose(): void {
    this.el.remove();
    cards.delete(this);
    if (!cards.size) setHudHidden(false);
  }
}

const cards = new Set<HudCard>();
let hidden = false;
let tag: HTMLElement | null = null;

/** Hides or shows the HUD (`body.hud-off` in styles/hud/_hud-card.scss) with the tag that brings it back. */
export function setHudHidden(on: boolean): void {
  hidden = on;
  document.body.classList.toggle('hud-off', on);
  tag ??= h('button', { class: 'hud-off-tag', type: 'button', title: 'Show the HUD (H)', onclick: () => setHudHidden(false) }, h('kbd', {}, 'H'), h('span', {}, 'Show HUD'));
  if (on) document.body.append(tag);
  else tag.remove();
}

// One listener for every card: H hides or shows the HUD (not while a help panel is open over it).
window.addEventListener(
  'keydown',
  (e) => {
    if (!cards.size || helpOpen()) return;
    if (e.code !== 'KeyH' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (!hidden && ![...cards].some((c) => c.o.canHide?.() ?? true)) return;
    setHudHidden(!hidden);
  },
  { capture: true },
);
