/**
 * Gamepad navigation for every screen that is not driving: the menu, pause,
 * results, settings and the garage. Those screens are built for the keyboard,
 * so the pad speaks keyboard to them: the d-pad and left stick send arrow
 * keys (repeating while held), A sends Enter to the focused control and
 * presses it if nothing took the key, B and Start send Escape (back a step,
 * or out of the pause screen). An arrow no screen handles moves focus to the
 * nearest control that way, and left / right on a focused slider steps it.
 *
 * The events it sends are untrusted, which handlers that only exist for real
 * keys (page scroll blocking, the garage's hold to rev) check to stay out of
 * the way. main.ts polls it every frame and says whether the pad belongs to
 * the UI; while it does not, buttons are only tracked, so the Start that
 * paused the race is not also read as an Escape that resumes it.
 */
const NAV = {
  /** Stick deflection that counts as a direction (0..1). */
  stick: 0.5,
  /** A held direction repeats after this long (s), then this often (s). */
  repeatDelay: 0.4,
  repeatEvery: 0.12,
  /** Slider steps over its whole range, one per press. */
  sliderSteps: 20,
} as const;

type Dir = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
/** Standard mapping d-pad buttons. */
const DPAD: [Dir, number][] = [
  ['ArrowUp', 12],
  ['ArrowDown', 13],
  ['ArrowLeft', 14],
  ['ArrowRight', 15],
];
const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export class PadNav {
  private prev: boolean[] = [];
  private held: Dir | null = null;
  private heldFor = 0;
  private nextRepeat = 0;

  /** Once per frame (dt in s). With `active` false the pad is only tracked. */
  poll(dt: number, active: boolean): void {
    const pad = firstPad();
    if (!pad) {
      this.prev = [];
      this.held = null;
      return;
    }
    const pressed = (i: number) => !!pad.buttons[i]?.pressed;
    const edge = (i: number) => pressed(i) && !this.prev[i];
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    let dir: Dir | null = DPAD.find(([, i]) => pressed(i))?.[0] ?? null;
    if (!dir && Math.max(Math.abs(ax), Math.abs(ay)) > NAV.stick) dir = Math.abs(ay) >= Math.abs(ax) ? (ay < 0 ? 'ArrowUp' : 'ArrowDown') : ax < 0 ? 'ArrowLeft' : 'ArrowRight';
    if (dir !== this.held) {
      this.held = dir;
      this.heldFor = 0;
      this.nextRepeat = NAV.repeatDelay;
      if (dir && active) this.arrow(dir);
    } else if (dir && active) {
      this.heldFor += dt;
      if (this.heldFor >= this.nextRepeat) {
        this.nextRepeat += NAV.repeatEvery;
        this.arrow(dir);
      }
    }
    if (active) {
      if (edge(0)) this.press();
      if (edge(1) || edge(9)) send('Escape');
    }
    this.prev = pad.buttons.map((b) => b.pressed);
  }

  private arrow(dir: Dir): void {
    if (send(dir)) return;
    const el = focused();
    if (el instanceof HTMLInputElement && el.type === 'range' && (dir === 'ArrowLeft' || dir === 'ArrowRight')) {
      const min = Number(el.min || 0);
      const max = Number(el.max || 100);
      const v = Number(el.value) + ((dir === 'ArrowRight' ? 1 : -1) * (max - min)) / NAV.sliderSteps;
      el.value = String(Math.max(min, Math.min(max, v)));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    moveFocus(el, dir);
  }

  private press(): void {
    if (send('Enter')) return;
    const el = focused();
    if (el && !(el instanceof HTMLInputElement && el.type === 'range')) el.click();
    else moveFocus(null, 'ArrowDown');
  }
}

function firstPad(): Gamepad | null {
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  for (const pad of pads) if (pad?.connected) return pad;
  return null;
}

/** The focused control, or null when focus is on nothing in particular. */
function focused(): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body && usable(el) ? el : null;
}

/** A key press and release on the focused element; true when a handler took the press. */
function send(key: string): boolean {
  const target = focused() ?? document.body;
  const down = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
  target.dispatchEvent(down);
  target.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true }));
  return down.defaultPrevented;
}

function usable(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled || el.closest('[inert], [aria-hidden="true"]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

/**
 * Focus the nearest usable control from `from` in direction `dir`: candidates
 * must lie ahead of it, and sideways offset counts double so a column or row
 * is followed before a jump across. With nothing focused, the topmost and
 * leftmost control.
 */
function moveFocus(from: HTMLElement | null, dir: Dir): void {
  const all = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el !== from && usable(el));
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  const o = from?.getBoundingClientRect();
  const ox = o ? o.left + o.width / 2 : 0;
  const oy = o ? o.top + o.height / 2 : 0;
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - ox;
    const dy = r.top + r.height / 2 - oy;
    let score: number;
    if (!o) score = dy + dx * 0.25;
    else {
      const ahead = dir === 'ArrowUp' ? -dy : dir === 'ArrowDown' ? dy : dir === 'ArrowLeft' ? -dx : dx;
      const side = dir === 'ArrowUp' || dir === 'ArrowDown' ? Math.abs(dx) : Math.abs(dy);
      if (ahead < 1) continue;
      score = ahead + side * 2;
    }
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  best?.focus({ focusVisible: true } as FocusOptions);
}
