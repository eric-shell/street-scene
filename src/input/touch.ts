/**
 * On-screen controls for touch devices: drag anywhere on the left half to
 * steer, buttons on the right for gas, brake, handbrake and nitrous. Styled by
 * _touch-controls.scss beside this file.
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

export class TouchControls {
  private root: HTMLDivElement;
  private s: TouchState = { active: false, steer: 0, throttle: 0, brake: 0, handbrake: false, nitrous: false, reset: false };
  private steerId: number | null = null;
  private steerX0 = 0;
  private knob: HTMLDivElement;

  constructor(parent: HTMLElement, onPause: () => void, onCamera: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'touch-controls is-hidden';
    const steer = document.createElement('div');
    steer.className = 'touch-controls__steer';
    this.knob = document.createElement('div');
    this.knob.className = 'touch-controls__knob';
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

    const hold = (mod: string, label: string, set: (on: boolean) => void) => {
      const b = document.createElement('div');
      b.className = `touch-controls__button touch-controls__button--${mod}`;
      b.textContent = label;
      const on = (e: PointerEvent) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        b.classList.add('is-pressed');
        this.s.active = true;
        set(true);
      };
      const off = () => {
        b.classList.remove('is-pressed');
        set(false);
      };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      this.root.appendChild(b);
    };
    hold('gas', 'GAS', (v) => (this.s.throttle = v ? 1 : 0));
    hold('brake', 'BRAKE', (v) => (this.s.brake = v ? 1 : 0));
    hold('handbrake', 'E-BRK', (v) => (this.s.handbrake = v));
    hold('nitrous', 'NOS', (v) => (this.s.nitrous = v));
    const tap = (mod: string, label: string, fn: () => void) => {
      const b = document.createElement('div');
      b.className = `touch-controls__button touch-controls__button--small touch-controls__button--${mod}`;
      b.textContent = label;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        fn();
      });
      this.root.appendChild(b);
    };
    tap('pause', 'II', onPause);
    tap('camera', 'CAM', onCamera);
    tap('reset', 'RST', () => (this.s.reset = true));
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
    this.root.querySelectorAll('.is-pressed').forEach((el) => el.classList.remove('is-pressed'));
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('is-hidden', !v);
    if (!v) this.release();
  }

  dispose(): void {
    this.root.remove();
  }
}
