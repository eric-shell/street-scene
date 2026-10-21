/**
 * The HUD card: the one top left card the drone (Explore) and free roam share,
 * so both read alike and stay alike. A chamfered plate like the menu's cards,
 * its rule in the place's hue (the menu row's: Explore cyan, free roam green):
 * a badge and the title over a status line with Exit in the corner, three
 * readouts, then a foot of actions (the caller's, then Controls) with the hide
 * button on the right. Controls opens a dialog in the settings page's key list.
 *
 * H hides the HUD wherever a card is up: the whole UI layer and the music
 * player fade as they do in the menu's cinematic mode, and a small tag in the
 * top left corner brings them back (H again, or a click). One key listener for
 * every card, so a free roam card under the photo drone's never toggles twice.
 */
import { h, btn, iconBtn } from './dom';
import { EyeOff, Keyboard, X, icon, type IconNode } from './icons';
import type { Hue } from './rail';

/** A row of the controls dialog: key caps (alternatives side by side) and what they do. */
export type ControlRow = [keys: string[], action: string];

export interface HudCardOptions {
  /** The place's hue, the menu row's. */
  hue: Hue;
  icon: IconNode;
  title: string;
  /** The status line under the title (flight mode, district). */
  status: string;
  /** The three readouts' labels; setStat writes their values. */
  stats: [string, string, string];
  /** Buttons on the left of the foot, before Controls. */
  actions?: HTMLElement[];
  onExit: () => void;
  /** Exit's tooltip, e.g. Back to the car (default Exit). */
  exitTitle?: string;
  /** The controls dialog's rows. */
  controls: ControlRow[];
  /** Whether H may hide the HUD right now (not while paused or a map is open); default always. */
  canHide?: () => boolean;
  /** The controls dialog opened or closed (free roam pauses the drive under it, as under its map). */
  onControls?: (open: boolean) => void;
}

export class HudCard {
  readonly el: HTMLElement;
  private statusEl: HTMLElement;
  private values: HTMLElement[];
  private dialog: HTMLElement | null = null;

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
        btn(X, 'Exit', o.onExit, 'small hud-card-exit'),
      ),
      h('div', { class: 'hud-card-stats' }, ...o.stats.map((label, i) => h('div', { class: 'hud-card-stat' }, h('span', {}, label), this.values[i]))),
      h(
        'div',
        { class: 'hud-card-actions' },
        ...(o.actions ?? []),
        btn(Keyboard, 'Controls', () => this.openControls(), 'small'),
        h('span', { class: 'grow' }),
        iconBtn(EyeOff, 'Hide HUD (H)', () => setHudHidden(true), 'small'),
      ),
    );
    this.el.querySelector('.hud-card-exit')?.setAttribute('title', o.exitTitle ?? 'Exit');
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

  get controlsOpen(): boolean {
    return !!this.dialog;
  }

  openControls(): void {
    if (this.dialog) return;
    const list = h('div', { class: 'controls-list' }, ...this.o.controls.flatMap(([keys, action]) => [h('span', { class: 'keys' }, ...keys.flatMap((k, i) => (i ? [' / ', h('kbd', {}, k)] : [h('kbd', {}, k)]))), h('span', {}, action)]));
    const close = () => this.closeControls();
    this.dialog = h(
      'div',
      { class: 'screen center dim hud-card-controls', onclick: (e: Event) => e.target === this.dialog && close() },
      h(
        'div',
        { class: 'dialog panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${this.o.title} controls` },
        h('h2', {}, icon(Keyboard, { size: 22 }), h('span', { class: 'grow' }, 'Controls'), iconBtn(X, 'Close (Esc)', close, 'small')),
        list,
      ),
    );
    (document.getElementById('ui') ?? document.body).append(this.dialog);
    this.o.onControls?.(true);
  }

  closeControls(): void {
    if (!this.dialog) return;
    this.dialog.remove();
    this.dialog = null;
    this.o.onControls?.(false);
  }

  dispose(): void {
    this.closeControls();
    this.el.remove();
    cards.delete(this);
    if (!cards.size) setHudHidden(false);
  }
}

const cards = new Set<HudCard>();
let hidden = false;
let tag: HTMLElement | null = null;

/** Hides or shows the HUD (body.hud-off in ui.css) with the tag that brings it back. */
export function setHudHidden(on: boolean): void {
  hidden = on;
  document.body.classList.toggle('hud-off', on);
  tag ??= h('button', { class: 'hud-off-tag', type: 'button', title: 'Show the HUD (H)', onclick: () => setHudHidden(false) }, h('kbd', {}, 'H'), h('span', {}, 'Show HUD'));
  if (on) document.body.append(tag);
  else tag.remove();
}

/** Whether a card's controls dialog is open (the drone stops flying under it). */
export function hudControlsOpen(): boolean {
  for (const c of cards) if (c.controlsOpen) return true;
  return false;
}

// One listener for every card: Escape closes an open controls dialog before anything else sees it
// (capture, so a session's pause or the drone's exit never fires), H hides or shows the HUD.
window.addEventListener(
  'keydown',
  (e) => {
    if (!cards.size) return;
    const open = [...cards].find((c) => c.controlsOpen);
    if (open) {
      if (e.code === 'Escape') {
        e.stopImmediatePropagation();
        open.closeControls();
      }
      return;
    }
    if (e.code !== 'KeyH' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (!hidden && ![...cards].some((c) => c.o.canHide?.() ?? true)) return;
    setHudHidden(!hidden);
  },
  { capture: true },
);
