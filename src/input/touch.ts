/**
 * On-screen controls for touch devices: drag anywhere on the left half to
 * steer, buttons on the right for gas, brake, handbrake and nitrous.
 */
export interface TouchState {
  active: boolean;
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
  nitrous: boolean;
  reset: boolean;
}

const STYLE = `
.nr-touch { position: fixed; inset: 0; pointer-events: none; z-index: 20; }
.nr-touch.hidden { display: none; }
.nr-steer { position: absolute; left: 0; top: 30%; bottom: 0; width: 50%; pointer-events: auto; touch-action: none; }
.nr-knob { position: absolute; width: 84px; height: 84px; margin: -42px 0 0 -42px; border-radius: 50%;
  border: 2px solid rgba(252,152,103,.6); background: rgba(25,24,26,.3); display: none; }
.nr-btn { position: absolute; pointer-events: auto; touch-action: none; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; font: 700 14px var(--display, system-ui), sans-serif; letter-spacing: .08em;
  color: #fcfcfa; background: rgba(25,24,26,.55); border: 2px solid rgba(147,146,147,.55); user-select: none; -webkit-user-select: none; }
.nr-btn.on { background: rgba(252,152,103,.5); }
.nr-gas { right: 18px; bottom: 26px; width: 96px; height: 96px; border-color: rgba(169,220,118,.75); }
.nr-brake { right: 128px; bottom: 18px; width: 74px; height: 74px; border-color: rgba(255,97,136,.75); }
.nr-hb { right: 128px; bottom: 104px; width: 64px; height: 64px; }
.nr-nos { right: 30px; bottom: 136px; width: 70px; height: 70px; border-color: rgba(120,220,232,.9); }
.nr-small { width: 44px; height: 44px; font-size: 11px; top: max(10px, env(safe-area-inset-top)); }
.nr-pause { right: 12px; }
.nr-cam { right: 64px; }
.nr-reset { right: 116px; }
`;

export class TouchControls {
  private root: HTMLDivElement;
  private s: TouchState = { active: false, steer: 0, throttle: 0, brake: 0, handbrake: false, nitrous: false, reset: false };
  private steerId: number | null = null;
  private steerX0 = 0;
  private knob: HTMLDivElement;

  constructor(parent: HTMLElement, onPause: () => void, onCamera: () => void) {
    if (!document.getElementById('nr-touch-style')) {
      const st = document.createElement('style');
      st.id = 'nr-touch-style';
      st.textContent = STYLE;
      document.head.appendChild(st);
    }
    this.root = document.createElement('div');
    this.root.className = 'nr-touch hidden';
    const steer = document.createElement('div');
    steer.className = 'nr-steer';
    this.knob = document.createElement('div');
    this.knob.className = 'nr-knob';
    steer.appendChild(this.knob);
    steer.addEventListener('pointerdown', (e) => {
      this.steerId = e.pointerId;
      this.steerX0 = e.clientX;
      steer.setPointerCapture(e.pointerId);
      this.knob.style.display = 'block';
      this.knob.style.left = `${e.clientX}px`;
      this.knob.style.top = `${e.clientY - steer.getBoundingClientRect().top}px`;
      this.s.active = true;
    });
    steer.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.steerId) return;
      this.s.steer = Math.max(-1, Math.min(1, (e.clientX - this.steerX0) / 70));
    });
    const endSteer = (e: PointerEvent) => {
      if (e.pointerId !== this.steerId) return;
      this.steerId = null;
      this.s.steer = 0;
      this.knob.style.display = 'none';
    };
    steer.addEventListener('pointerup', endSteer);
    steer.addEventListener('pointercancel', endSteer);
    this.root.appendChild(steer);

    const hold = (cls: string, label: string, set: (on: boolean) => void) => {
      const b = document.createElement('div');
      b.className = `nr-btn ${cls}`;
      b.textContent = label;
      const on = (e: PointerEvent) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        b.classList.add('on');
        this.s.active = true;
        set(true);
      };
      const off = () => {
        b.classList.remove('on');
        set(false);
      };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      this.root.appendChild(b);
    };
    hold('nr-gas', 'GAS', (v) => (this.s.throttle = v ? 1 : 0));
    hold('nr-brake', 'BRAKE', (v) => (this.s.brake = v ? 1 : 0));
    hold('nr-hb', 'E-BRK', (v) => (this.s.handbrake = v));
    hold('nr-nos', 'NOS', (v) => (this.s.nitrous = v));
    const tap = (cls: string, label: string, fn: () => void) => {
      const b = document.createElement('div');
      b.className = `nr-btn nr-small ${cls}`;
      b.textContent = label;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        fn();
      });
      this.root.appendChild(b);
    };
    tap('nr-pause', 'II', onPause);
    tap('nr-cam', 'CAM', onCamera);
    tap('nr-reset', 'RST', () => (this.s.reset = true));
    parent.appendChild(this.root);
  }

  state(): TouchState {
    const out = { ...this.s };
    this.s.reset = false;
    return out;
  }

  release(): void {
    this.s = { ...this.s, steer: 0, throttle: 0, brake: 0, handbrake: false, nitrous: false, reset: false };
    this.steerId = null;
    this.knob.style.display = 'none';
    this.root.querySelectorAll('.on').forEach((el) => el.classList.remove('on'));
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
    if (!v) this.release();
  }

  dispose(): void {
    this.root.remove();
  }
}
