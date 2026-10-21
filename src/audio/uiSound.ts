/**
 * Menu sounds, synthesized like the rest of the game's effects (no files): a
 * soft tick as the pointer or keyboard focus lands on a control, a click when
 * one is pressed, a blip when a race type is picked, a whoosh as a menu step
 * slides, the rush of the screen wipe and the garage's roller door rattling
 * down onto a clunk and back up. They play on the interface bus
 * (engineAudio.ts AudioHub.uiBus, so the Interface level applies) and only
 * once the audio context runs: a suspended context would queue them up and
 * play them all at once on the first gesture. Hovering never creates the audio
 * context; the first press does. The Interface level in the sound settings
 * sets how loud they are, down to off.
 *
 * installUiSounds wires the ticks and clicks to every control by delegation
 * (one listener per event type on the document), so screens get them without
 * any code of their own; the other sounds are called where they happen. All
 * randomness is cosmetic. Render side only.
 */
import { audioHub } from './engineAudio';

/** Levels (linear gain into the interface bus) and timings (s). */
const UI = {
  tick: 0.05,
  press: 0.11,
  blip: 0.06,
  whoosh: 0.13,
  wipe: 0.2,
  rattle: 0.16,
  clunk: 0.42,
  /** Ticks closer together than this are dropped (fast sweeps over a list). */
  tickGap: 0.045,
} as const;

/** Set by the first press: the audio context exists from then on (a hover never creates it). */
let started = false;
let lastTick = 0;

/** The context and bus when a sound may play now, else null. */
function live(create = false): { ctx: AudioContext; out: AudioNode; noise: AudioBuffer } | null {
  if (!started && !create) return null;
  const hub = audioHub();
  if (!hub) return null;
  started = true;
  if (hub.ctx.state !== 'running') return null;
  return { ctx: hub.ctx, out: hub.uiBus, noise: hub.noise };
}

/** A gain envelope: up to `peak` in `attack` s, then an exponential fall over `decay` s. */
function env(ctx: AudioContext, t: number, peak: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

/** A burst of the shared noise through a filter, from a random spot in the buffer. */
function noise(a: NonNullable<ReturnType<typeof live>>, t: number, dur: number, type: BiquadFilterType, hz: number, q: number, peak: number, attack = 0.002): { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } {
  const { ctx } = a;
  const src = ctx.createBufferSource();
  src.buffer = a.noise;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(hz, t);
  filter.Q.value = q;
  const gain = env(ctx, t, peak, attack, Math.max(0.005, dur - attack));
  src.connect(filter).connect(gain).connect(a.out);
  src.start(t, Math.random() * 1.5, dur + 0.05);
  return { src, filter, gain };
}

/** A pitched blip gliding from f0 to f1 Hz. */
function tone(a: NonNullable<ReturnType<typeof live>>, t: number, dur: number, f0: number, f1: number, peak: number, type: OscillatorType = 'sine'): OscillatorNode {
  const { ctx } = a;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const gain = env(ctx, t, peak, 0.003, dur);
  osc.connect(gain).connect(a.out);
  osc.start(t);
  osc.stop(t + dur + 0.05);
  return osc;
}

/** The pointer or focus landed on a control. */
export function uiTick(): void {
  const a = live();
  if (!a || a.ctx.currentTime - lastTick < UI.tickGap) return;
  lastTick = a.ctx.currentTime;
  const t = a.ctx.currentTime;
  noise(a, t, 0.012, 'bandpass', 5200, 3, UI.tick);
  tone(a, t, 0.02, 2600, 2300, UI.tick * 0.35);
}

/** A control was pressed; `back` is the lower click of a back or close. */
export function uiPress(back = false): void {
  const a = live(true);
  if (!a) return;
  const t = a.ctx.currentTime;
  noise(a, t, 0.018, 'bandpass', 3200, 1.6, UI.press * 0.7);
  tone(a, t, 0.06, back ? 720 : 1150, back ? 480 : 760, UI.press);
}

/** A race type picked: two quick rising notes. */
export function uiBlip(): void {
  const a = live(true);
  if (!a) return;
  const t = a.ctx.currentTime;
  tone(a, t, 0.05, 880, 880, UI.blip, 'triangle');
  tone(a, t + 0.055, 0.08, 1320, 1320, UI.blip, 'triangle');
}

/** A menu step slides: air sweeping up going forward, down coming back. */
export function uiWhoosh(forward = true): void {
  const a = live();
  if (!a) return;
  const t = a.ctx.currentTime;
  const n = noise(a, t, 0.32, 'bandpass', forward ? 500 : 2600, 1.2, UI.whoosh, 0.09);
  n.filter.frequency.exponentialRampToValueAtTime(forward ? 2600 : 500, t + 0.3);
}

/** The screen wipe: a rising rush into a soft thump as the card covers the screen. */
export function uiWipe(): void {
  const a = live();
  if (!a) return;
  const t = a.ctx.currentTime;
  const n = noise(a, t, 0.5, 'bandpass', 300, 0.9, UI.wipe, 0.3);
  n.filter.frequency.exponentialRampToValueAtTime(3200, t + 0.42);
  tone(a, t + 0.36, 0.22, 110, 42, UI.wipe * 1.4);
}

/** The roller door: slats clattering for `dur` s, rising in pitch going up. */
function rattle(a: NonNullable<ReturnType<typeof live>>, t: number, dur: number, up: boolean): void {
  const { ctx } = a;
  const src = ctx.createBufferSource();
  src.buffer = a.noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 1.4;
  filter.frequency.setValueAtTime(up ? 700 : 1100, t);
  filter.frequency.linearRampToValueAtTime(up ? 1500 : 800, t + dur);
  const level = env(ctx, t, UI.rattle, 0.05, dur);
  // Each slat hinge knocks: a square LFO chops the level between 10% and full some 30 times a second.
  const chop = ctx.createGain();
  chop.gain.value = 0.55;
  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.setValueAtTime(up ? 22 : 34, t);
  lfo.frequency.linearRampToValueAtTime(up ? 30 : 26, t + dur);
  const depth = ctx.createGain();
  depth.gain.value = 0.45;
  lfo.connect(depth).connect(chop.gain);
  src.connect(filter).connect(level).connect(chop).connect(a.out);
  src.start(t, Math.random() * 1.5, dur + 0.1);
  lfo.start(t);
  lfo.stop(t + dur + 0.1);
}

/** The door comes down: the clatter, then the bottom rail landing. */
export function uiDoorDown(dur: number): void {
  const a = live();
  if (!a) return;
  const t = a.ctx.currentTime;
  rattle(a, t, dur * 0.8, false);
  tone(a, t + dur * 0.72, 0.24, 90, 40, UI.clunk);
  noise(a, t + dur * 0.72, 0.12, 'lowpass', 420, 0.7, UI.clunk * 0.6);
}

/** The door rolls up. */
export function uiDoorUp(dur: number): void {
  const a = live();
  if (!a) return;
  rattle(a, a.ctx.currentTime, dur * 0.9, true);
}

/** Controls that tick under the pointer and click when pressed. */
const CONTROLS = '.btn, .nav-item, .mode-tile, .event-map, .course-map.opens, .tab, .seg button, .key-action, .g-item, .g-swatch, .garage-tab, .fullmap button';

/**
 * Wire ticks and clicks to every control in the document, once: a tick when
 * the mouse enters a control or keyboard focus lands on one, a click when one
 * is pressed (a lower one for back and close buttons).
 */
export function installUiSounds(): void {
  let hovered: Element | null = null;
  document.addEventListener('pointerover', (e) => {
    const el = e.target instanceof Element ? e.target.closest(CONTROLS) : null;
    if (el === hovered) return;
    hovered = el;
    if (el && e.pointerType === 'mouse' && !(el as HTMLButtonElement).disabled) uiTick();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (el?.matches(CONTROLS) && el.matches(':focus-visible')) uiTick();
  });
  document.addEventListener(
    'click',
    (e) => {
      const el = e.target instanceof Element ? e.target.closest(CONTROLS) : null;
      if (!el || (el as HTMLButtonElement).disabled || el.closest('[data-sound="off"]')) return;
      const label = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').toLowerCase();
      uiPress(el.classList.contains('back') || label.startsWith('back') || label.startsWith('close') || label.startsWith('cancel'));
    },
    true,
  );
}
