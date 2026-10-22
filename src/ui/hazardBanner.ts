/**
 * Hazard warning banner in the race HUD: one line under the message slot,
 * "BRIDGE RISING" in amber while the gates ahead warn and come down, "BRIDGE
 * UP" in red with the seconds left while they hold traffic back, "CLEAR THE
 * BRIDGE" when the player is on a span that is about to lift. Lives in the
 * HUD root (`.hud-hazard` in styles/hud/_hud.scss); the session decides the text
 * (game/hazardFx.ts). Plain DOM, touched only when the text changes.
 */
import { TriangleAlert, icon } from './icons';

export type HazardLevel = 'warn' | 'stop';

export class HazardBanner {
  private readonly el: HTMLDivElement;
  private readonly textEl: HTMLElement;
  private text = '';
  private level: HazardLevel | null = null;

  constructor(hudRoot: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud-hazard';
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.appendChild(icon(TriangleAlert, { size: 20 }));
    this.textEl = document.createElement('b');
    this.el.append(ic, this.textEl);
    hudRoot.appendChild(this.el);
  }

  /** Show `text` at `level`, or hide the banner with null. */
  set(text: string | null, level: HazardLevel = 'warn'): void {
    const shown = text !== null;
    if (!shown) {
      if (this.level !== null) {
        this.el.classList.remove('show', 'warn', 'stop');
        this.level = null;
        this.text = '';
      }
      return;
    }
    if (text !== this.text) {
      this.textEl.textContent = text;
      this.text = text;
    }
    if (level !== this.level) {
      this.el.classList.remove('warn', 'stop');
      this.el.classList.add('show', level);
      this.level = level;
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
