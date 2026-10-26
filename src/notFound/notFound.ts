/**
 * The 404 page (404.html; Vercel serves it for any path that is not a file): "Wrong turn" on a card over a
 * street you can drive (wrongTurn.ts), with the way back to the game and into today's race. The car takes
 * WASD or the arrows with Space for the handbrake, a gamepad, or a finger or mouse held down to drive toward
 * it; drifting scores like the race's callouts, and the best stays on the device. The page view goes to
 * analytics like the game's, so broken links people follow show up on the dashboard by their path.
 */
import './notFound.scss';
import { btn, h, isTyping, keyCaps, prefersReducedMotion } from '../ui/kit/dom';
import { Flag, Route } from '../ui/kit/icons';
import { loadText, saveText } from '../shared/store';
import { initAnalytics } from '../analytics/telemetry';
import { Cruise, StreetCar, StreetView, type Controls, type DriftEvent } from './wrongTurn';

const BEST_KEY = 'notFound.best';
/** How long a banked or crashed drift's line stays up (ms). */
const CALLOUT_MS = 1600;

const reduced = prefersReducedMotion();
const go = (href: string) => () => location.assign(href);

const canvas = h('canvas', { class: 'not-found__street', 'aria-hidden': 'true' });
const live = h('b', { class: 'not-found__points' }, '0');
const callout = h('span', { class: 'not-found__callout' });
let best = Number(loadText(BEST_KEY)) || 0;
const bestEl = h('span', { class: 'not-found__best' }, best ? `Best ${best.toLocaleString()}` : 'Drift to score');
const drift = h('div', { class: 'not-found__drift', 'aria-live': 'polite' }, h('span', { class: 'label label--kicker' }, 'Drift'), live, callout, bestEl);

document.getElementById('app')!.replaceChildren(
  h(
    'main',
    { class: 'not-found' },
    canvas,
    h(
      'section',
      { class: 'not-found__card' },
      h('a', { class: 'logo not-found__logo', href: '/' }, 'STREET SCENE'),
      h('p', { class: 'not-found__code' }, '404'),
      h('h1', { class: 'not-found__title' }, 'Wrong turn'),
      h('p', { class: 'not-found__text' }, 'This street isn’t on the map. Take a lap, then head back to the race.'),
      h('div', { class: 'not-found__actions' }, btn(Route, 'Back to the streets', go('/'), '--large --primary --cta'), btn(Flag, 'Race today’s city', go('/?race=sprint'), '--large')),
    ),
    drift,
    h(
      'p',
      { class: 'not-found__hint' },
      h('span', { class: 'not-found__hint-keys' }, ...keyCaps(['W A S D']), ' or arrows to drive, ', ...keyCaps(['Space']), ' handbrake'),
      h('span', { class: 'not-found__hint-touch' }, 'Hold anywhere to drive toward your finger'),
    ),
  ),
);

// ---------------------------------------------------------------------------
// Input: keys, a held pointer, a pad. The first of any hands the car over from the cruise.
// ---------------------------------------------------------------------------
const keys = new Set<string>();
const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
let pointer: { x: number; y: number } | null = null;
let manual = false;

window.addEventListener('keydown', (e) => {
  if (!DRIVE_KEYS.has(e.code) || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  // Space and Enter on a focused button press it; everything else drives.
  if (e.code === 'Space' && e.target instanceof HTMLButtonElement) return;
  e.preventDefault();
  keys.add(e.code);
  manual = true;
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => {
  keys.clear();
  pointer = null;
});
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointer = { x: e.clientX, y: e.clientY };
  manual = true;
});
canvas.addEventListener('pointermove', (e) => pointer && (pointer = { x: e.clientX, y: e.clientY }));
for (const t of ['pointerup', 'pointercancel'] as const) canvas.addEventListener(t, () => (pointer = null));

const held = (...codes: string[]) => codes.some((c) => keys.has(c));

function padControls(): Controls | null {
  for (const p of navigator.getGamepads?.() ?? []) {
    if (!p?.connected) continue;
    const steer = Math.abs(p.axes[0] ?? 0) > 0.12 ? p.axes[0] : 0;
    const throttle = p.buttons[7]?.value ?? 0;
    const brake = p.buttons[6]?.value ?? 0;
    const handbrake = !!(p.buttons[0]?.pressed || p.buttons[1]?.pressed);
    if (steer || throttle > 0.05 || brake > 0.05 || handbrake) return { steer, throttle, brake, handbrake };
  }
  return null;
}

function controls(car: StreetCar): Controls {
  const pad = padControls();
  if (pad) {
    manual = true;
    return pad;
  }
  if (pointer) {
    // Drive toward the finger: steer at it, ease off as it comes close, back up when it is behind.
    const t = view.toWorld(pointer.x, pointer.y);
    const err = Math.atan2(t.y - car.y, t.x - car.x) - car.heading;
    const a = Math.atan2(Math.sin(err), Math.cos(err));
    const dist = Math.hypot(t.x - car.x, t.y - car.y);
    const behind = Math.abs(a) > 2.2 && dist < 25;
    return { steer: Math.max(-1, Math.min(1, (behind ? -a : a) * 2)), throttle: behind ? 0 : Math.min(1, dist / 12), brake: behind ? 1 : 0, handbrake: Math.abs(a) > 1.1 && car.speed > 12 };
  }
  if (!manual) return reduced ? { steer: 0, throttle: 0, brake: 0, handbrake: false } : cruise.controls(car);
  return {
    steer: (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0),
    throttle: held('KeyW', 'ArrowUp') ? 1 : 0,
    brake: held('KeyS', 'ArrowDown') ? 1 : 0,
    handbrake: held('Space'),
  };
}

// ---------------------------------------------------------------------------
// The drift readout: live points while sliding, then the drift banked (a new best saved) or lost to a wall.
// ---------------------------------------------------------------------------
let calloutTimer: ReturnType<typeof setTimeout> | undefined;
let shown = -1;
function onDrift(e: DriftEvent): void {
  if (e.kind === 'live') {
    if (e.points === shown) return;
    shown = e.points;
    live.textContent = e.points.toLocaleString();
    drift.classList.add('is-live');
    return;
  }
  // The cruise's drifts are a show, not a score.
  if (!manual) {
    drift.classList.remove('is-live');
    return;
  }
  shown = -1;
  drift.classList.remove('is-live');
  const record = e.kind === 'banked' && e.points > best;
  if (record) {
    best = e.points;
    saveText(BEST_KEY, String(best));
    bestEl.textContent = `Best ${best.toLocaleString()}`;
  }
  callout.textContent = e.kind === 'crashed' ? `Crashed! −${e.points.toLocaleString()}` : record ? `New best +${e.points.toLocaleString()}` : `+${e.points.toLocaleString()}`;
  callout.className = `not-found__callout is-shown ${e.kind === 'crashed' ? 'is-crashed' : record ? 'is-best' : ''}`;
  clearTimeout(calloutTimer);
  calloutTimer = setTimeout(() => callout.classList.remove('is-shown'), CALLOUT_MS);
}

// ---------------------------------------------------------------------------
// The loop: rAF stops in a hidden tab, and the car's fixed ticks cap a long gap.
// ---------------------------------------------------------------------------
const car = new StreetCar();
const cruise = new Cruise();
const view = new StreetView(canvas, reduced);
view.jump(car);
window.addEventListener('resize', () => view.resize());
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  car.step(dt, controls(car), onDrift, (speed, x, y) => view.hit(speed, x, y));
  view.frame(car, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

initAnalytics(null);
