/**
 * Turns keyboard, touch and gamepad into one InputFrame per sim tick.
 * Steering ramps instead of snapping. Edge actions (shift, reset) latch until
 * the next sample. Everything is released when the window loses focus.
 */
import { InputFrame } from '../sim/input';
import { TouchControls } from './touch';

const STEER_RATE = 3.2; // per second toward full lock
const STEER_RETURN = 6; // per second back to center
const PEDAL_RATE = 9;

type Action = 'camera' | 'pause' | 'dev' | 'freecam';

export class InputManager {
  private keys = new Set<string>();
  private steer = 0;
  private throttle = 0;
  private brake = 0;
  private shiftLatch: -1 | 0 | 1 = 0;
  private resetLatch = false;
  private listeners = new Map<Action, Set<() => void>>();
  private abort = new AbortController();
  private gamepadPrev: boolean[] = [];
  readonly touch: TouchControls | null;
  enabled = true;

  constructor(uiRoot: HTMLElement) {
    const o = { signal: this.abort.signal };
    window.addEventListener('keydown', (e) => this.onKey(e, true), o);
    window.addEventListener('keyup', (e) => this.onKey(e, false), o);
    window.addEventListener('blur', () => this.releaseAll(), o);
    document.addEventListener('visibilitychange', () => document.hidden && this.releaseAll(), o);
    const touchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.touch = touchDevice ? new TouchControls(uiRoot, () => this.emit('pause'), () => this.emit('camera')) : null;
  }

  on(action: Action, fn: () => void): () => void {
    let set = this.listeners.get(action);
    if (!set) this.listeners.set(action, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(a: Action): void {
    this.listeners.get(a)?.forEach((fn) => fn());
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    if (down && !e.repeat) {
      switch (e.code) {
        case 'KeyC':
          this.emit('camera');
          break;
        case 'Escape':
        case 'KeyP':
          this.emit('pause');
          break;
        case 'Backquote':
        case 'F2':
          this.emit('dev');
          break;
        case 'KeyF':
          if (e.shiftKey) this.emit('freecam');
          break;
        case 'KeyQ':
          this.shiftLatch = -1;
          break;
        case 'KeyE':
          this.shiftLatch = 1;
          break;
        case 'KeyR':
          this.resetLatch = true;
          break;
      }
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
  }

  releaseAll(): void {
    this.keys.clear();
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.shiftLatch = 0;
    this.resetLatch = false;
    this.touch?.release();
  }

  private k(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /** Produce exactly one frame. Call once per sim tick with the fixed dt. */
  sample(dt: number): InputFrame {
    if (!this.enabled) return { throttle: 0, brake: 0, steer: 0, handbrake: false, nitrous: false, shift: 0, reset: false };
    const left = this.k('KeyA', 'ArrowLeft');
    const right = this.k('KeyD', 'ArrowRight');
    const steerTarget = (right ? 1 : 0) - (left ? 1 : 0);
    const rate = steerTarget === 0 || Math.sign(steerTarget) !== Math.sign(this.steer) ? STEER_RETURN : STEER_RATE;
    this.steer = approach(this.steer, steerTarget, rate * dt);
    this.throttle = approach(this.throttle, this.k('KeyW', 'ArrowUp') ? 1 : 0, PEDAL_RATE * dt);
    this.brake = approach(this.brake, this.k('KeyS', 'ArrowDown') ? 1 : 0, PEDAL_RATE * dt);
    const frame: InputFrame = {
      throttle: this.throttle,
      brake: this.brake,
      steer: this.steer,
      handbrake: this.k('Space'),
      nitrous: this.k('ShiftLeft', 'ShiftRight', 'KeyN'),
      shift: this.shiftLatch,
      reset: this.resetLatch,
    };
    this.shiftLatch = 0;
    this.resetLatch = false;

    // Touch overrides when active.
    const t = this.touch?.state();
    if (t && t.active) {
      frame.steer = t.steer;
      frame.throttle = Math.max(frame.throttle, t.throttle);
      frame.brake = Math.max(frame.brake, t.brake);
      frame.handbrake ||= t.handbrake;
      frame.nitrous ||= t.nitrous;
      if (t.reset) frame.reset = true;
    }

    // Gamepad (standard mapping).
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const ax = pad.axes[0] ?? 0;
      const steer = Math.abs(ax) > 0.12 ? Math.sign(ax) * ((Math.abs(ax) - 0.12) / 0.88) : 0;
      const b = (i: number) => pad.buttons[i]?.value ?? 0;
      const pressed = (i: number) => !!pad.buttons[i]?.pressed;
      if (Math.abs(steer) > Math.abs(frame.steer)) frame.steer = steer;
      frame.throttle = Math.max(frame.throttle, b(7));
      frame.brake = Math.max(frame.brake, b(6));
      frame.handbrake ||= pressed(2);
      frame.nitrous ||= pressed(0) || pressed(1);
      const edge = (i: number) => pressed(i) && !this.gamepadPrev[i];
      if (edge(5)) frame.shift = 1;
      if (edge(4)) frame.shift = -1;
      if (edge(3)) frame.reset = true;
      if (edge(9)) this.emit('pause');
      if (edge(8)) this.emit('camera');
      this.gamepadPrev = pad.buttons.map((x) => x.pressed);
      break;
    }
    return frame;
  }

  setTouchVisible(v: boolean): void {
    this.touch?.setVisible(v);
  }

  dispose(): void {
    this.abort.abort();
    this.touch?.dispose();
  }
}

function approach(x: number, t: number, d: number): number {
  return x < t ? Math.min(x + d, t) : Math.max(x - d, t);
}
