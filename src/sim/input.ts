/**
 * One input frame is consumed per sim tick. Keyboard, touch, gamepad, AI and
 * replays all produce this shape. Frames are quantized before the sim reads
 * them so a recorded (quantized) log replays bit for bit.
 */
export interface InputFrame {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1..1, positive steers right */
  steer: number;
  handbrake: boolean;
  nitrous: boolean;
  /** Manual gearbox: -1 shift down, +1 shift up, 0 none. Edge triggered. */
  shift: -1 | 0 | 1;
  /** Request a reset to the road. Edge triggered. */
  reset: boolean;
  /** The rolling antilag button, held: with the throttle down on the move, a turbo car holds its antilag rpm and boost (car.ts). */
  antilag: boolean;
}

export const NEUTRAL_INPUT: Readonly<InputFrame> = Object.freeze({
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  nitrous: false,
  shift: 0,
  reset: false,
  antilag: false,
});

const clamp01 = (x: number) => (x > 1 ? 1 : x < 0 || !(x === x) ? 0 : x);

export function quantizeInput(f: InputFrame): InputFrame {
  const steer = f.steer > 1 ? 1 : f.steer < -1 ? -1 : f.steer === f.steer ? f.steer : 0;
  return {
    throttle: Math.round(clamp01(f.throttle) * 255) / 255,
    brake: Math.round(clamp01(f.brake) * 255) / 255,
    steer: Math.round(steer * 127) / 127,
    handbrake: !!f.handbrake,
    nitrous: !!f.nitrous,
    shift: f.shift === 1 ? 1 : f.shift === -1 ? -1 : 0,
    reset: !!f.reset,
    antilag: !!f.antilag,
  };
}

/** Pack a quantized frame into 4 bytes (as one uint32) for compact logs. */
export function packInput(f: InputFrame): number {
  const t = Math.round(clamp01(f.throttle) * 255);
  const b = Math.round(clamp01(f.brake) * 255);
  const s = Math.round(Math.max(-1, Math.min(1, f.steer)) * 127) + 127;
  const bits = (f.handbrake ? 1 : 0) | (f.nitrous ? 2 : 0) | (f.shift === 1 ? 4 : 0) | (f.shift === -1 ? 8 : 0) | (f.reset ? 16 : 0) | (f.antilag ? 32 : 0);
  return ((t << 24) | (b << 16) | (s << 8) | bits) >>> 0;
}

export function unpackInput(v: number): InputFrame {
  const bits = v & 0xff;
  return {
    throttle: ((v >>> 24) & 0xff) / 255,
    brake: ((v >>> 16) & 0xff) / 255,
    steer: (((v >>> 8) & 0xff) - 127) / 127,
    handbrake: (bits & 1) !== 0,
    nitrous: (bits & 2) !== 0,
    shift: bits & 4 ? 1 : bits & 8 ? -1 : 0,
    reset: (bits & 16) !== 0,
    antilag: (bits & 32) !== 0,
  };
}
