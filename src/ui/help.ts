/**
 * The help button: one small "?" in the bottom left of every screen (the
 * menu's and the garage's rails, pause and results, the HUD beside the
 * minimap) that opens a small panel of that screen's keys and tips above it.
 * It replaces the key legends along the bottom of the rails and the HUD card's
 * Controls dialog, so the screens stay clean and every hint lives in one
 * place with one look. A key row with an action is a button too, so what a
 * key does stays in reach on a touch screen (hide the menu, the garage's
 * camera).
 *
 * One key listener for every panel: `?` toggles the panel of the screen on
 * top (the last help in the page that is on screen: a pause screen or the
 * drone is added after the HUD under it), and Escape closes an open panel
 * before anything else sees the key (capture), so it never also pauses,
 * backs out of a step or leaves the garage. A click anywhere else closes it.
 * Only one panel is open at a time. Helps are found through the page, so one
 * on a screen that is simply removed (pause, results) is never held on to.
 */
import { h } from './dom';
import { X, icon } from './icons';

/** A key row: the caps (alternatives side by side) and what they do; with an action the row is a button that does it. */
export interface HelpKey {
  keys: string[];
  label: string;
  action?: () => void;
}

/** The music player's keys, which work on every screen (ui/musicWidget.ts). */
export const MUSIC_KEYS: HelpKey[] = [
  { keys: ['M'], label: 'Mute music' },
  { keys: ['[', ']'], label: 'Previous, next track' },
];

export interface HelpSection {
  /** The group's caption (Keys, Flying, Tips). */
  title: string;
  keys?: HelpKey[];
  /** Short tips about what is on screen. */
  tips?: string[];
}

export interface HelpOptions {
  /** The panel's title: the screen's name. */
  title: string;
  /** The sections, read each time it opens (a menu step shows its own). */
  sections: () => HelpSection[];
  /** The panel opened or closed (a drive pauses under it, the drone holds still). */
  onToggle?: (open: boolean) => void;
}

export class Help {
  /** The button with its panel; the caller places it (`.help` in ui/styles/panels/_help.scss). */
  readonly el: HTMLElement;
  private readonly btn: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private open = false;

  constructor(private readonly o: HelpOptions) {
    this.panel = h('div', { class: 'help-panel', role: 'dialog', 'aria-label': `${o.title}: keys and tips`, hidden: true });
    this.btn = h('button', { class: 'help-btn', type: 'button', title: 'Keys and tips (?)', 'aria-label': 'Keys and tips', 'aria-expanded': 'false', onclick: () => this.toggle() }, '?') as HTMLButtonElement;
    this.el = h('div', { class: 'help' }, this.panel, this.btn);
    byEl.set(this.el, this);
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    if (this.open) return;
    openHelp?.close();
    this.panel.replaceChildren(
      h('div', { class: 'help-head' }, h('b', {}, this.o.title), h('span', {}, 'Keys and tips'), h('button', { class: 'help-close', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => this.close() }, icon(X, { size: 16 }))),
      // The sections scroll inside the panel, so its chamfered edges stay put.
      h(
        'div',
        { class: 'help-body' },
        ...this.o.sections().map((s) =>
          h(
            'section',
            { class: 'help-section' },
            h('div', { class: 'section-title' }, s.title),
            s.keys?.length ? h('div', { class: 'help-keys' }, ...s.keys.map((k) => this.row(k))) : null,
            s.tips?.length ? h('ul', { class: 'help-tips' }, ...s.tips.map((t) => h('li', {}, t))) : null,
          ),
        ),
      ),
    );
    this.panel.hidden = false;
    this.open = true;
    openHelp = this;
    this.btn.classList.add('on');
    this.btn.setAttribute('aria-expanded', 'true');
    this.o.onToggle?.(true);
  }

  close(): void {
    if (!this.open) return;
    this.panel.hidden = true;
    this.open = false;
    if (openHelp === this) openHelp = null;
    this.btn.classList.remove('on');
    this.btn.setAttribute('aria-expanded', 'false');
    this.o.onToggle?.(false);
  }

  dispose(): void {
    this.close();
    this.el.remove();
  }

  private row(k: HelpKey): HTMLElement {
    const caps = h('span', { class: 'keys' }, ...k.keys.flatMap((key, i) => (i ? [' ', h('kbd', {}, key)] : [h('kbd', {}, key)])));
    if (!k.action) return h('div', { class: 'help-row' }, caps, h('span', {}, k.label));
    const run = k.action;
    return h('button', { class: 'help-row act', type: 'button', onclick: () => (this.close(), run()) }, caps, h('span', {}, k.label));
  }
}

/** Each help by its element, for finding them through the page. */
const byEl = new WeakMap<Element, Help>();
/** The one open panel; a screen removed with its panel open drops it. */
let openHelp: Help | null = null;

/** The open panel, if its screen is still up. */
function current(): Help | null {
  if (openHelp && !openHelp.el.isConnected) openHelp = null;
  return openHelp;
}

/** Whether a help panel is open (the drone holds still under one; called per frame). */
export function helpOpen(): boolean {
  return !!current();
}

/** The help of the screen on top: the last in the page that is on screen (a HUD hidden under the drone has no boxes). */
function onTop(): Help | undefined {
  const els = document.querySelectorAll('.help');
  for (let i = els.length - 1; i >= 0; i--) if (els[i].getClientRects().length) return byEl.get(els[i]);
  return undefined;
}

window.addEventListener(
  'keydown',
  (e) => {
    const open = current();
    if (open && e.code === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      open.close();
      return;
    }
    if (e.key !== '?' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    // Not while the UI is faded out (the menu's cinematic mode, a hidden HUD): the panel would open unseen.
    if (document.body.classList.contains('cinematic') || document.body.classList.contains('hud-off')) return;
    const top = open ?? onTop();
    if (!top) return;
    e.preventDefault();
    top.toggle();
  },
  { capture: true },
);

// A click or tap anywhere outside the open panel and its button closes it.
window.addEventListener(
  'pointerdown',
  (e) => {
    const open = current();
    if (open && !(e.target instanceof Node && open.el.contains(e.target))) open.close();
  },
  { capture: true },
);
