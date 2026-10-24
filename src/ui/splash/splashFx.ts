/**
 * Splash motion graphics: one 2D canvas behind the title, a drive down a city
 * street at night in one-point perspective, suggested in light and silhouette
 * rather than modelled. Buildings line both sides, their lit windows streaming
 * past, neon blade signs hanging off them; streetlights march along the curbs
 * between street trees, each pooling warm light on the wet road and washing
 * the wall behind it. The street passes under the elevated expressway (its
 * lamps lit, traffic sliding along its parapet) and the elevated railway (a
 * train crossing), and every cross street and alley mouth is closed with the
 * race route's cyan barrier, a street meet's crowd behind it flashing phones.
 * Racers come through in packs, one direction at a time: taillights bursting
 * past from behind and pulling away, some lighting their nitrous in the
 * stages' colors, or headlights rushing at us from the far end. Downtown's
 * towers stand at the end of the street under searchlights and a helicopter,
 * the city glow behind them; neon bokeh drifts across the view and fine rain
 * falls over everything. When the title flies onto the menu, warp() lights the
 * nitrous: everything speeds up, the windows stretch into streaks and the
 * frame's edges burn through the stage colors while the splash fades onto the
 * menu city, which takes over the same nitrous warp (splash.ts).
 *
 * Cheap by design (window rows batched into a few paths per frame, glows
 * pre-rendered as sprites, no shadow blur), because the city's first frames
 * render underneath at the same time; it only runs while the splash is up.
 * Reduced motion never starts it.
 */

import { NITRO_STAGE_COLORS, PALETTE, rgb } from '../kit/palette';

export interface SplashFx {
  /** Light the nitrous: speed everything up for the flight onto the menu. */
  warp(): void;
  stop(): void;
}

/** Timeline (s from start), speeds, the street's dimensions (road units: the curbs are at ±2) and counts. */
const FX = {
  /** Reveals: the road drawing out from the vanishing point, then the buildings, the streetlights, bokeh and rain, and the skyline. */
  roadIn: [0.1, 0.9],
  streetIn: [0.15, 1.25],
  lampsIn: [0.35, 1.3],
  bokehIn: [0.25, 1.6],
  rainIn: [0, 0.8],
  skyIn: [0.2, 1.4],
  /** The first pack comes through from behind at this time, the next after a gap (s). */
  packFrom: 0.35,
  packGap: [1.0, 1.7],
  /** Cars per pack, and the gap between them (units). */
  packSize: [3, 5],
  packSpacing: [1.4, 2.6],
  /** Pack speeds relative to the camera (units/s): pulling away from behind, and oncoming. */
  awaySpeed: [13, 20],
  oncomingSpeed: [30, 38],
  /** Chance per second a racer pulling away lights its nitrous, and how long a burn lasts (s). */
  nitroChance: 0.35,
  nitroBurn: [0.5, 1.2],
  /** The sway of the vanishing point (fraction of width, rad/s), like the view from a moving car. */
  sway: 0.012,
  swayRate: 0.7,
  /** Travel (units/s), lane dash spacing and length, the far plane, and the length the street repeats over. */
  dashSpeed: 16,
  dashSpacing: 4,
  dashLength: 1.6,
  far: 70,
  span: 96,
  /** Building line, storey height, window bay and how many windows are lit. */
  wall: 3.3,
  storey: 0.9,
  bay: 0.8,
  lit: 0.32,
  /** Building lengths and heights, the chance of a blade sign, and of a barrier across an alley mouth. */
  length: [4, 11],
  height: [3.2, 10],
  signs: 0.4,
  alleyBarrier: 0.6,
  /** Streetlights: spacing, pole line, height and how far the arm reaches over the road. */
  lampGap: 9,
  lampX: 2.35,
  lampH: 2.6,
  lampReach: 0.65,
  /** Street trees halfway between the lamps: their line, crown center height and radius (units). */
  treeX: 2.8,
  treeY: 2.1,
  treeR: 0.62,
  /** Corner clearance each side of a cross street (units). */
  corner: 0.8,
  /** Windows fade into the haze from here to the far plane. */
  hazeFrom: 26,
  /** Warp: speed multiplier reached and how fast (1/s); the nitrous climbs a stage this often (s). */
  warpMax: 7,
  warpRate: 5,
  warpStage: 0.22,
  bokeh: 20,
  rain: 90,
  towers: 26,
} as const;

/**
 * Where the street passes under something, along the repeating span (units):
 * the expressway (its deck's depth along the street, the underside and top
 * heights) and the elevated railway's viaduct with a train on it.
 */
const CROSSINGS = [
  { kind: 'expressway', at: 34, depth: 4.5, under: 4.2, top: 5.0 },
  { kind: 'rail', at: 78, depth: 1.6, under: 4.0, top: 4.35 },
] as const;
type Crossing = (typeof CROSSINGS)[number];

/** Sign and bokeh colors: signs use the first four; taillights are [1], headlights [4], streetlights [5], the meet's backlight [0] and its barrier [3]. */
const NEON = [PALETTE.orange, PALETTE.red, PALETTE.yellow, PALETTE.cyan, '#fff4d6', '#ffb45e', PALETTE.purple];
/** Sprite index per nitrous stage (cyan, purple, red: the HUD bar's colors). */
const NITRO_SPRITE = NITRO_STAGE_COLORS.map((c) => NEON.indexOf(PALETTE[c]));
const NITRO_RGB = NITRO_STAGE_COLORS.map((c) => rgb(c));
/** Facade tones at night: charcoal, soot brick, blue-grey concrete, warm stucco in shadow. */
const FACADES = [
  [26, 24, 29],
  [38, 24, 24],
  [24, 28, 36],
  [36, 31, 28],
];
/** Lit window colors: warm lamps mostly, the odd cool screen. */
const WINDOWS = ['rgba(255,216,140,0.85)', 'rgba(255,240,214,0.8)', 'rgba(150,200,255,0.7)'];
/** "r,g,b" triples for the gradients built per frame. */
const ORANGE = rgb('orange');
const YELLOW = rgb('yellow');
const RED = rgb('red');
const CYAN = rgb('cyan');
const BG = rgb('bg0');
const HEAD = '255,250,235';
const ease = (a: number, b: number, t: number) => {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};
const between = (r: readonly [number, number]) => r[0] + Math.random() * (r[1] - r[0]);
/** Positive modulo. */
const mod = (a: number, n: number) => ((a % n) + n) % n;
/** A deterministic hash in 0..1, so a building keeps its window pattern as it streams past. */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** A soft round light, pre-rendered once per color (drawImage is far cheaper than live gradients). */
function bokehSprite(color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, color);
  grad.addColorStop(0.55, color + '88');
  grad.addColorStop(1, color + '00');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

/** A racer: lane center (road units, - left), depth (units), +1 pulling away (taillights) or -1 oncoming (headlights). */
interface Racer {
  x: number;
  z: number;
  dir: number;
  speed: number;
  /** Weave and surge phase (rad), so the pack trades places. */
  phase: number;
  /** Nitrous burn left (s) and its stage (0..2). */
  burn: number;
  stage: number;
}

/** A building along one side of the street: where it starts along the repeating span, its length, height and look. */
interface Building {
  z: number;
  len: number;
  h: number;
  /** Facade fill. */
  fill: string;
  /** Blade sign: color index (-1 for none), its bottom (units up) and how far along the building it hangs. */
  sign: number;
  signY: number;
  signAt: number;
  /** Lit windows per WINDOWS color, flat triples: bay along the building, storey, and a hash for flicker. */
  windows: number[][];
}

/** A gap in the building line (a cross street or an alley mouth); a closed one has the cyan barrier and a meet's crowd behind it. */
interface Gap {
  z: number;
  len: number;
  closed: boolean;
  /** The crowd, flat pairs: place along the gap (0..1) and height (units). */
  crowd: number[];
}

/** One side of the street: buildings end to end over the repeating span, an alley gap here and there, a cross street at each crossing. */
function street(): { buildings: Building[]; gaps: Gap[] } {
  const buildings: Building[] = [];
  const gaps: Gap[] = [];
  const gap = (z: number, len: number, closed: boolean) => {
    const crowd: number[] = [];
    if (closed) for (let u = 0.08 + Math.random() * 0.1; u < 0.95; u += 0.07 + Math.random() * 0.12) crowd.push(u, 0.42 + Math.random() * 0.12);
    gaps.push({ z, len, closed, crowd });
  };
  let z = 0;
  while (z < FX.span - 2) {
    let len = Math.min(between(FX.length), FX.span - z);
    // A cross street under each crossing: stop the building short of it, or start past it.
    const cross = CROSSINGS.find((c) => z < c.at + c.depth + FX.corner && z + len > c.at - FX.corner);
    if (cross) {
      const room = cross.at - FX.corner - z;
      if (room < 2) {
        const end = cross.at + cross.depth + FX.corner;
        gap(z, end - z, true);
        z = end;
        continue;
      }
      len = room;
    }
    const h = FX.height[0] + Math.random() ** 1.4 * (FX.height[1] - FX.height[0]);
    const shade = Math.random() * 6;
    const tone = FACADES[Math.floor(Math.random() * FACADES.length)];
    const windows: number[][] = WINDOWS.map(() => []);
    for (let bay = 0; 0.25 + bay * FX.bay < len - 0.5; bay++) {
      for (let row = 0; 1 + row * FX.storey < h - 0.5; row++) {
        const n = Math.random();
        if (n < FX.lit) windows[Math.floor((n / FX.lit) * 9) % WINDOWS.length].push(bay, row, n);
      }
    }
    buildings.push({
      z,
      len,
      h,
      fill: `rgb(${Math.round(tone[0] + shade)},${Math.round(tone[1] + shade)},${Math.round(tone[2] + shade)})`,
      sign: Math.random() < FX.signs ? Math.floor(Math.random() * 4) : -1,
      signY: 1.1 + Math.random() * 1.3,
      signAt: 0.2 + Math.random() * 0.6,
      windows,
    });
    z += len;
    if (cross) continue;
    if (Math.random() < 0.25) {
      const w = 0.6 + Math.random();
      gap(z, w, Math.random() < FX.alleyBarrier);
      z += w;
    } else z += 0.05;
  }
  return { buildings, gaps };
}

/** A downtown tower at the end of the street: lateral place and width (units), height, and its lit windows as (u, v) pairs. */
interface Tower {
  x: number;
  w: number;
  h: number;
  z: number;
  fill: string;
  windows: number[];
  /** Aircraft warning light on top. */
  beacon: boolean;
}

function skyline(): Tower[] {
  return Array.from({ length: FX.towers }, (_, i) => {
    const x = (i / (FX.towers - 1) - 0.5) * 120 + (Math.random() - 0.5) * 4;
    // Tallest in the middle, downtown's core.
    const core = 1 - Math.min(1, Math.abs(x) / 60);
    const h = 18 + core * core * 55 * (0.5 + Math.random() * 0.5);
    const windows: number[] = [];
    for (let k = 0; k < 6 + h / 4; k++) windows.push(Math.random(), Math.random());
    const v = Math.round(12 + Math.random() * 8);
    return { x, w: 4 + Math.random() * 5, h, z: 115 + Math.random() * 40, fill: `rgb(${v},${v + 1},${v + 6})`, windows, beacon: h > 45 };
  }).sort((a, b) => b.z - a.z);
}

export interface SplashFxLayout {
  /** Horizon height (CSS px from the top). */
  horizon(): number;
  /** Where the title block is, so a dark plate keeps it readable over the street. */
  title(): DOMRect;
}

export function startSplashFx(canvas: HTMLCanvasElement, layout: SplashFxLayout): SplashFx {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { warp() {}, stop() {} };
  const sprites = NEON.map(bokehSprite);
  let W = 0;
  let H = 0;
  let horizon = 0;
  let dpr = 1;
  let title = new DOMRect();

  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    horizon = layout.horizon();
    title = layout.title();
  };
  resize();
  window.addEventListener('resize', resize);

  const sides = [street(), street()];
  const towers = skyline();
  const bokeh = Array.from({ length: FX.bokeh }, () => ({
    x: Math.random(),
    y: Math.random() * 0.9,
    r: 8 + Math.random() ** 2 * 54,
    sprite: Math.floor(Math.random() * 4),
    phase: Math.random() * 6.28,
    drift: (Math.random() - 0.5) * 0.012,
    alpha: 0.1 + Math.random() * 0.24,
  }));
  const rain = Array.from({ length: FX.rain }, () => ({ x: Math.random() * 1.2 - 0.1, y: Math.random(), len: 8 + Math.random() * 16, v: 0.9 + Math.random() * 0.6 }));
  /** Expressway traffic along the parapet: lateral place (units, wrapping over ±40), speed and which way. */
  const deckCars = Array.from({ length: 10 }, (_, i) => ({ x: Math.random() * 80, v: 9 + Math.random() * 5, dir: i % 2 ? 1 : -1 }));
  const racers: Racer[] = [];
  let nextPack: number = FX.packFrom;
  let lastDir = -1;

  // Projection: road units to screen. The near plane z = 1 puts the curbs (x = ±2) near the screen sides;
  // y is height above the road in the same units, the eye sitting h0 above it.
  let vpx = 0;
  let F = 1;
  let h0 = 1;
  const X = (x: number, z: number) => vpx + (x * F) / z;
  const Y = (y: number, z: number) => horizon + ((h0 - y) * F) / z;

  const t0 = performance.now();
  let last = t0;
  let travel = 0;
  let speed = 1;
  let warping = false;
  let warpAt = 0;
  let raf = 0;

  /** A wall quad on the building line at `side`: z0..z1 along the street, y0..y1 up, added to the current path. */
  const wallQuad = (g: CanvasRenderingContext2D, side: number, z0: number, z1: number, y0: number, y1: number) => {
    const x = side * FX.wall;
    g.moveTo(X(x, z0), Y(y0, z0));
    g.lineTo(X(x, z1), Y(y0, z1));
    g.lineTo(X(x, z1), Y(y1, z1));
    g.lineTo(X(x, z0), Y(y1, z0));
    g.closePath();
  };
  /** Where a span position sits in front of the camera now (units). */
  const depth = (at: number) => mod(at - travel, FX.span) - 4;

  /** A pack of racers, all one way: from behind the camera pulling away, or from the far end rushing at us. */
  const spawnPack = () => {
    const dir = Math.random() < 0.75 ? -lastDir : lastDir;
    lastDir = dir;
    const n = Math.round(between(FX.packSize));
    const v = between(dir > 0 ? FX.awaySpeed : FX.oncomingSpeed);
    let z = dir > 0 ? -0.2 : FX.far;
    for (let k = 0; k < n; k++) {
      const lane = (k + (Math.random() < 0.5 ? 0 : 1)) % 2 ? 1.45 : 0.55;
      racers.push({ x: dir * lane, z, dir, speed: v + (Math.random() - 0.5) * 2, phase: Math.random() * 6.28, burn: 0, stage: 0 });
      z -= dir * between(FX.packSpacing);
    }
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const t = (now - t0) / 1000;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (warping) speed += (FX.warpMax - speed) * (1 - Math.exp(-dt * FX.warpRate));
    travel += dt * FX.dashSpeed * speed;
    vpx = W / 2 + Math.sin(t * FX.swayRate) * W * FX.sway;
    F = 0.36 * W;
    h0 = (H - horizon) / F;
    const g = ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const rd = ease(FX.roadIn[0], FX.roadIn[1], t);
    const st = ease(FX.streetIn[0], FX.streetIn[1], t);
    const lp = ease(FX.lampsIn[0], FX.lampsIn[1], t);
    const sky = ease(FX.skyIn[0], FX.skyIn[1], t);
    // How far the street has drawn out toward the viewer as it reveals.
    const reach = FX.far - (FX.far - 1) * st;
    const near = Math.max(0.35, reach);
    const stretch = warping ? 1 + (speed - 1) * 0.55 : 1;

    // The city glowing at the far end of the street, and a haze along the horizon.
    {
      const glow = g.createRadialGradient(vpx, horizon, 0, vpx, horizon, W * 0.42);
      glow.addColorStop(0, `rgba(${ORANGE},${0.2 * rd})`);
      glow.addColorStop(0.35, `rgba(${RED},${0.07 * rd})`);
      glow.addColorStop(1, `rgba(${RED},0)`);
      g.fillStyle = glow;
      g.fillRect(0, 0, W, H);
    }

    // The sky over the end of the street: searchlights sweeping, downtown's towers, a helicopter.
    if (sky > 0) {
      g.globalCompositeOperation = 'lighter';
      for (let k = 0; k < 2; k++) {
        const bx = vpx + (k ? 1 : -1) * W * 0.07;
        const a = (k ? 0.3 : -0.25) + Math.sin(t * (0.45 + k * 0.17) + k * 2) * 0.35;
        const len = horizon * 1.1;
        const tx = bx + Math.sin(a) * len;
        const ty = horizon - Math.cos(a) * len;
        const beam = g.createLinearGradient(bx, horizon, tx, ty);
        beam.addColorStop(0, `rgba(220,230,255,${0.1 * sky})`);
        beam.addColorStop(1, 'rgba(220,230,255,0)');
        g.fillStyle = beam;
        const half = W * 0.03;
        g.beginPath();
        g.moveTo(bx, horizon);
        g.lineTo(tx + Math.cos(a) * half, ty + Math.sin(a) * half);
        g.lineTo(tx - Math.cos(a) * half, ty - Math.sin(a) * half);
        g.closePath();
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = sky;
      for (const tw of towers) {
        const x0 = X(tw.x - tw.w / 2, tw.z);
        const top = Y(tw.h, tw.z);
        g.fillStyle = tw.fill;
        g.fillRect(x0, top, X(tw.x + tw.w / 2, tw.z) - x0, Y(0, tw.z) - top);
      }
      // Their windows in one path, then the warning lights blinking on the tallest.
      g.fillStyle = 'rgba(255,214,150,0.55)';
      g.beginPath();
      for (const tw of towers) {
        const x0 = X(tw.x - tw.w / 2, tw.z);
        const w = X(tw.x + tw.w / 2, tw.z) - x0;
        const top = Y(tw.h, tw.z);
        const hgt = Y(0, tw.z) - top;
        const px = Math.max(1, w * 0.06);
        for (let i = 0; i < tw.windows.length; i += 2) g.rect(x0 + tw.windows[i] * (w - px), top + 2 + tw.windows[i + 1] * (hgt - 2), px, px);
      }
      g.fill();
      g.globalCompositeOperation = 'lighter';
      for (const tw of towers) if (tw.beacon && Math.sin(t * 3 + tw.x) > 0.2) g.drawImage(sprites[1], X(tw.x, tw.z) - 4, Y(tw.h, tw.z) - 4, 8, 8);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      // The helicopter: drifting over the towers, strobes blinking, its searchlight down into the city.
      const hx = vpx + Math.sin(t * 0.21 + 1) * W * 0.22;
      const hy = horizon * 0.22 + Math.sin(t * 0.5) * horizon * 0.03;
      g.globalCompositeOperation = 'lighter';
      const cone = g.createLinearGradient(hx, hy, hx, horizon);
      cone.addColorStop(0, `rgba(235,240,255,${0.12 * sky})`);
      cone.addColorStop(1, 'rgba(235,240,255,0)');
      g.fillStyle = cone;
      const sweep = Math.sin(t * 0.8) * W * 0.04;
      g.beginPath();
      g.moveTo(hx, hy);
      g.lineTo(hx + sweep + W * 0.035, horizon);
      g.lineTo(hx + sweep - W * 0.035, horizon);
      g.closePath();
      g.fill();
      g.globalAlpha = sky;
      if (t % 1 < 0.12) g.drawImage(sprites[4], hx - 6, hy - 6, 12, 12);
      if ((t + 0.5) % 1 < 0.5) g.drawImage(sprites[1], hx - 4 - 6, hy - 2, 8, 8);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    // Meets: in each closed gap a crowd stands backlit behind the barrier, phones flashing. Before the
    // facades, since any building nearer than the gap stands in front of them.
    if (st > 0) {
      for (let side = -1; side <= 1; side += 2) {
        for (const gp of sides[side < 0 ? 0 : 1].gaps) {
          if (!gp.closed) continue;
          const zs = depth(gp.z);
          if (zs + gp.len < near || zs > FX.far * 0.8) continue;
          const zm = Math.max(near, zs + gp.len / 2);
          const fade = st * (1 - ease(FX.hazeFrom, FX.far * 0.8, zm));
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = 0.35 * fade;
          const bw = Math.abs(X(side * (FX.wall + 1.5), zm) - X(side * FX.wall, zm)) * 2;
          g.drawImage(sprites[0], X(side * (FX.wall + 1.2), zm) - bw / 2, Y(1.2, zm), bw, Y(0, zm) - Y(1.2, zm));
          g.globalCompositeOperation = 'source-over';
          g.globalAlpha = fade;
          g.fillStyle = 'rgb(8,8,11)';
          g.beginPath();
          const px = side * (FX.wall + 0.45);
          for (let i = 0; i < gp.crowd.length; i += 2) {
            const z = zs + gp.crowd[i] * gp.len;
            if (z < near) continue;
            const x = X(px, z);
            const r = (0.09 * F) / z;
            const top = Y(gp.crowd[i + 1], z);
            g.rect(x - r, top + r, r * 2, Y(0, z) - top - r);
            g.moveTo(x + r * 0.8, top + r * 0.5);
            g.arc(x, top + r * 0.5, r * 0.8, 0, Math.PI * 2);
          }
          g.fill();
          g.globalCompositeOperation = 'lighter';
          for (let i = 0; i < gp.crowd.length; i += 2) {
            const z = zs + gp.crowd[i] * gp.len;
            if (z < near || hash(gp.crowd[i] * 57 + Math.floor(t * 6 + i)) > 0.05) continue;
            const r = Math.max(2, (0.12 * F) / z);
            g.drawImage(sprites[4], X(px, z) - r, Y(gp.crowd[i + 1] * 0.85, z) - r, r * 2, r * 2);
          }
          g.globalCompositeOperation = 'source-over';
          g.globalAlpha = 1;
        }
      }
    }

    // Buildings between two depths: facades on both building lines, storey bands, lit windows and the cornice.
    const buildings = (lo: number, hi: number) => {
      for (let side = -1; side <= 1; side += 2) {
        const list = sides[side < 0 ? 0 : 1].buildings;
        // Facades.
        g.globalAlpha = st;
        for (const b of list) {
          const zs = depth(b.z);
          const z0 = Math.max(lo, zs);
          const z1 = Math.min(hi, zs + b.len);
          if (z1 <= z0) continue;
          g.fillStyle = b.fill;
          g.beginPath();
          wallQuad(g, side, z0, z1, 0, b.h);
          g.fill();
        }
        // Storey bands: a darker strip where each row of windows sits.
        g.fillStyle = 'rgba(0,0,0,0.28)';
        g.beginPath();
        for (const b of list) {
          const zs = depth(b.z);
          const z0 = Math.max(lo, zs + 0.15);
          const z1 = Math.min(hi, zs + b.len - 0.15);
          if (z1 <= z0) continue;
          for (let y = 1.0; y < b.h - 0.5; y += FX.storey) wallQuad(g, side, z0, z1, y, y + 0.5);
        }
        g.fill();
        // Lit windows, batched per color and per haze band; the warp stretches them into streaks.
        for (let haze = 0; haze < 2; haze++) {
          for (let c = 0; c < WINDOWS.length; c++) {
            g.fillStyle = WINDOWS[c];
            g.globalAlpha = st * (haze ? 0.45 : 1);
            g.beginPath();
            for (const b of list) {
              const zs = depth(b.z);
              if (zs + b.len < lo || zs > hi) continue;
              const w = b.windows[c];
              for (let i = 0; i < w.length; i += 3) {
                const wz = zs + 0.25 + w[i] * FX.bay;
                const a = Math.max(lo, wz);
                const e = Math.min(hi, wz + 0.42 * stretch);
                if (e <= a || (a >= FX.hazeFrom ? 1 : 0) !== haze) continue;
                // Now and then a light goes off for a moment.
                const n = w[i + 2];
                if (hash(n * 91 + Math.floor(t * 0.7 + n * 13)) < 0.04) continue;
                const y = 1 + w[i + 1] * FX.storey;
                wallQuad(g, side, a, e, y, y + 0.5);
              }
            }
            g.fill();
          }
        }
        // Cornices catching the street's light.
        g.globalAlpha = st * 0.5;
        g.strokeStyle = 'rgba(255,255,255,0.12)';
        g.lineWidth = 1;
        g.beginPath();
        for (const b of list) {
          const zs = depth(b.z);
          const z0 = Math.max(lo, zs);
          const z1 = Math.min(hi, zs + b.len);
          if (z1 <= z0) continue;
          g.moveTo(X(side * FX.wall, z0), Y(b.h, z0));
          g.lineTo(X(side * FX.wall, z1), Y(b.h, z1));
        }
        g.stroke();
        g.globalAlpha = 1;
      }
    };

    /** A crossing overhead: the expressway's deck (fascia, underside, lamps, traffic on top) or the railway's viaduct and its train. */
    const crossing = (c: Crossing, z: number) => {
      const zb = z + c.depth;
      const za = Math.max(near, z);
      if (zb <= za) return;
      const fade = st * (1 - ease(FX.hazeFrom, FX.far, za));
      const wide = 60;
      g.globalAlpha = fade;
      // The underside, from its front edge to its back.
      g.fillStyle = c.kind === 'expressway' ? 'rgb(16,16,19)' : 'rgb(12,12,15)';
      g.beginPath();
      g.moveTo(X(-wide, za), Y(c.under, za));
      g.lineTo(X(wide, za), Y(c.under, za));
      g.lineTo(X(wide, zb), Y(c.under, zb));
      g.lineTo(X(-wide, zb), Y(c.under, zb));
      g.closePath();
      g.fill();
      // The fascia, catching the street light along its bottom edge.
      if (z >= near) {
        g.fillStyle = c.kind === 'expressway' ? 'rgb(34,33,37)' : 'rgb(24,24,28)';
        g.fillRect(X(-wide, z), Y(c.top, z), X(wide, z) - X(-wide, z), Y(c.under, z) - Y(c.top, z));
        g.fillStyle = `rgba(${ORANGE},0.35)`;
        g.fillRect(X(-wide, z), Y(c.under, z) - 1.5, X(wide, z) - X(-wide, z), 1.5);
      }
      // Piers on the sidewalks, in the middle of the deck.
      const zp = z + c.depth / 2;
      if (zp > near) {
        g.fillStyle = 'rgb(22,22,26)';
        for (const s of [-1, 1]) {
          const x0 = X(s * 2.55, zp);
          const x1 = X(s * (c.kind === 'expressway' ? 3.05 : 2.85), zp);
          g.fillRect(Math.min(x0, x1), Y(c.under, zp), Math.abs(x1 - x0), Y(0, zp) - Y(c.under, zp));
        }
      }
      if (z < near) {
        g.globalAlpha = 1;
        return;
      }
      g.globalCompositeOperation = 'lighter';
      const s = F / z;
      if (c.kind === 'expressway') {
        // Its lamps along the parapet, and traffic sliding by under them.
        for (let k = -6; k <= 6; k++) {
          const r = Math.min(W * 0.03, Math.max(2, s * 0.3));
          g.globalAlpha = 0.7 * fade;
          g.drawImage(sprites[5], X(k * 5, z) - r, Y(c.top + 0.55, z) - r, r * 2, r * 2);
        }
        for (const d of deckCars) {
          const x = mod(d.x + d.dir * d.v * t, 80) - 40;
          const r = Math.max(1.5, s * 0.07);
          g.globalAlpha = 0.85 * fade;
          for (const off of [-0.17, 0.17]) g.drawImage(sprites[d.dir > 0 ? 4 : 1], X(x + off, z) - r, Y(c.top + 0.12, z) - r, r * 2, r * 2);
        }
      } else {
        // The train: a run of lit cars crossing, then the empty viaduct for a while.
        const run = mod(t * 14, 160) - 80;
        g.globalAlpha = fade;
        for (let k = 0; k < 4; k++) {
          const x0 = run + k * 4.6;
          g.globalCompositeOperation = 'source-over';
          g.fillStyle = 'rgb(30,30,36)';
          g.fillRect(X(x0, z), Y(c.top + 0.85, z), X(x0 + 4.4, z) - X(x0, z), Y(c.top, z) - Y(c.top + 0.85, z));
          g.globalCompositeOperation = 'lighter';
          g.fillStyle = 'rgba(255,236,190,0.75)';
          for (let wnd = 0; wnd < 6; wnd++) {
            const wx = x0 + 0.35 + wnd * 0.65;
            g.fillRect(X(wx, z), Y(c.top + 0.65, z), X(wx + 0.4, z) - X(wx, z), Y(c.top + 0.35, z) - Y(c.top + 0.65, z));
          }
        }
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    };

    // Painter's order: buildings beyond the crossings, each crossing, then the nearer buildings in front.
    if (st > 0) {
      const over = CROSSINGS.map((c) => ({ c, z: depth(c.at) }))
        .filter((o) => o.z + o.c.depth > near && o.z < FX.far)
        .sort((a, b) => b.z - a.z);
      let hi: number = FX.far;
      for (const o of over) {
        buildings(Math.max(near, o.z + o.c.depth), hi);
        crossing(o.c, o.z);
        hi = Math.max(near, o.z);
      }
      buildings(near, hi);
    }

    // Bokeh drifting and breathing in front of everything far away.
    const bk = ease(FX.bokehIn[0], FX.bokehIn[1], t);
    g.globalCompositeOperation = 'lighter';
    for (const b of bokeh) {
      b.x += b.drift * dt * speed;
      if (b.x < -0.1) b.x += 1.2;
      if (b.x > 1.1) b.x -= 1.2;
      const a = bk * b.alpha * (0.7 + 0.3 * Math.sin(t * 0.9 + b.phase));
      if (a < 0.01) continue;
      const r = b.r * (warping ? 1 + (speed - 1) * 0.08 : 1);
      g.globalAlpha = a;
      g.drawImage(sprites[b.sprite], b.x * W - r, b.y * horizon - r, r * 2, r * 2);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    // Blade signs: a neon panel standing out from the wall, a glow round it and dark letters across it.
    if (st > 0) {
      for (let side = -1; side <= 1; side += 2) {
        for (const b of sides[side < 0 ? 0 : 1].buildings) {
          if (b.sign < 0) continue;
          const z = depth(b.z) + b.len * b.signAt;
          if (z < Math.max(0.8, near) || z > FX.far) continue;
          const xa = X(side * (FX.wall - 0.5), z);
          const xb = X(side * FX.wall, z);
          const ya = Y(b.signY + 1.5, z);
          const yb = Y(b.signY, z);
          const fade = st * (1 - ease(FX.hazeFrom, FX.far, z) * 0.6);
          const r = (1.4 * F) / z;
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = 0.5 * fade;
          g.drawImage(sprites[b.sign], (xa + xb) / 2 - r, (ya + yb) / 2 - r, r * 2, r * 2);
          g.globalCompositeOperation = 'source-over';
          g.globalAlpha = fade;
          g.fillStyle = NEON[b.sign];
          g.fillRect(Math.min(xa, xb), ya, Math.abs(xb - xa), yb - ya);
          g.fillStyle = 'rgba(25,24,26,0.55)';
          const w = Math.abs(xb - xa);
          for (let k = 0; k < 4; k++) g.fillRect(Math.min(xa, xb) + w * 0.25, ya + (yb - ya) * (0.12 + k * 0.21), w * 0.5, (yb - ya) * 0.1);
          g.globalAlpha = 1;
        }
      }
    }

    // A dark plate behind the title so the tagline reads over the street.
    {
      const cx = title.left + title.width / 2;
      const cy = title.top + title.height / 2;
      const r = Math.max(title.width, title.height) * 0.75;
      const plate = g.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
      plate.addColorStop(0, `rgba(${BG},0.82)`);
      plate.addColorStop(1, `rgba(${BG},0)`);
      g.fillStyle = plate;
      g.fillRect(cx - r, cy - r, r * 2, r * 2);
    }

    // The road: the sidewalks a shade lighter, curbs and the center line drawing out from the far end.
    if (rd > 0) {
      const zNear = FX.far - (FX.far - 1) * rd;
      g.fillStyle = `rgba(252,252,250,${0.03 * rd})`;
      g.beginPath();
      for (const side of [-1, 1]) {
        g.moveTo(X(side * 2, FX.far), Y(0, FX.far));
        g.lineTo(X(side * FX.wall, FX.far), Y(0, FX.far));
        g.lineTo(X(side * FX.wall, zNear), Y(0, zNear));
        g.lineTo(X(side * 2, zNear), Y(0, zNear));
        g.closePath();
      }
      g.fill();
      const line = (x: number, color: string, width: number) => {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath();
        g.moveTo(X(x, FX.far), Y(0, FX.far));
        g.lineTo(X(x, zNear), Y(0, zNear));
        g.stroke();
      };
      g.lineCap = 'round';
      for (const side of [-2, 2]) {
        line(side, `rgba(${ORANGE},0.14)`, 6);
        line(side, `rgba(${ORANGE},0.8)`, 1.5);
      }
      line(-0.06, `rgba(${YELLOW},0.7)`, 1.2);
      line(0.06, `rgba(${YELLOW},0.7)`, 1.2);
      // Dashes: their depth wraps as they rush in; the warp stretches them into streaks.
      const len = FX.dashLength * (warping ? 1 + (speed - 1) * 0.6 : 1);
      g.strokeStyle = 'rgba(252,252,250,0.7)';
      for (const x of [-1, 1]) {
        for (let k = 0; k < FX.far / FX.dashSpacing; k++) {
          const z = k * FX.dashSpacing - (travel % FX.dashSpacing) + 1;
          if (z < 1 || z > zNear + 0.01) continue;
          const z2 = Math.min(FX.far, z + len);
          g.lineWidth = Math.max(0.6, (F / z) * 0.012);
          g.beginPath();
          g.moveTo(X(x, z), Y(0, z));
          g.lineTo(X(x, z2), Y(0, z2));
          g.stroke();
        }
      }
    }

    // The route's cyan barriers across every closed gap, glowing on the wet sidewalk.
    if (st > 0) {
      for (let side = -1; side <= 1; side += 2) {
        for (const gp of sides[side < 0 ? 0 : 1].gaps) {
          if (!gp.closed) continue;
          const zs = depth(gp.z);
          const z0 = Math.max(near, zs);
          const z1 = Math.min(FX.far, zs + gp.len);
          if (z1 <= z0) continue;
          const fade = st * (1 - ease(FX.hazeFrom, FX.far, z0));
          g.globalAlpha = fade;
          g.fillStyle = `rgb(${CYAN})`;
          g.beginPath();
          wallQuad(g, side, z0, z1, 0.16, 0.3);
          g.fill();
          g.fillStyle = 'rgba(25,24,26,0.6)';
          g.beginPath();
          for (let z = z0 + 0.15; z < z1 - 0.1; z += 0.35) wallQuad(g, side, z, Math.min(z1, z + 0.15), 0.16, 0.3);
          g.fill();
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = 0.45 * fade;
          const xa = X(side * FX.wall, z0);
          const xb = X(side * FX.wall, z1);
          const ya = Y(0.8, (z0 + z1) / 2);
          const yb = Y(-0.2, (z0 + z1) / 2);
          g.drawImage(sprites[3], Math.min(xa, xb), ya, Math.abs(xb - xa), yb - ya);
          g.globalCompositeOperation = 'source-over';
          g.globalAlpha = 1;
        }
      }
    }

    // Street trees halfway between the lamps: dark crowns lit from under by the lamps.
    if (lp > 0) {
      for (let side = -1; side <= 1; side += 2) {
        for (let k = 0; k * FX.lampGap < FX.span; k++) {
          const at = k * FX.lampGap + (side > 0 ? 0 : FX.lampGap / 2);
          if (CROSSINGS.some((c) => at > c.at - FX.corner - 1 && at < c.at + c.depth + FX.corner + 1)) continue;
          const z = depth(at);
          if (z < Math.max(0.9, near) || z > FX.far) continue;
          const fade = lp * (1 - ease(FX.hazeFrom, FX.far, z));
          const x = X(side * FX.treeX, z);
          const y = Y(FX.treeY, z);
          const r = (FX.treeR * F) / z;
          g.globalAlpha = 0.92 * fade;
          g.fillStyle = 'rgb(10,13,12)';
          g.beginPath();
          g.ellipse(x, y, r * 0.75, r, 0, 0, Math.PI * 2);
          g.ellipse(x - side * r * 0.45, y + r * 0.3, r * 0.6, r * 0.7, 0, 0, Math.PI * 2);
          g.fill();
          g.fillRect(x - r * 0.05, y + r * 0.6, r * 0.1, Y(0, z) - y - r * 0.6);
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = 0.18 * fade;
          g.drawImage(sprites[5], x - r, y, r * 2, r);
          g.globalCompositeOperation = 'source-over';
          g.globalAlpha = 1;
        }
      }
    }

    // Streetlights: poles along both curbs, a warm pool on the road and a wash on the wall at each.
    if (lp > 0) {
      g.strokeStyle = `rgba(10,10,12,${0.9 * lp})`;
      g.lineCap = 'butt';
      for (let side = -1; side <= 1; side += 2) {
        for (let k = 0; k * FX.lampGap < FX.span; k++) {
          const z = depth(k * FX.lampGap + (side > 0 ? FX.lampGap / 2 : 0));
          if (z < Math.max(0.7, near) || z > FX.far) continue;
          const fade = lp * (1 - ease(FX.hazeFrom, FX.far, z));
          const px = side * FX.lampX;
          const hx = side * (FX.lampX - FX.lampReach);
          g.lineWidth = Math.max(1, (F / z) * 0.06);
          g.beginPath();
          g.moveTo(X(px, z), Y(0, z));
          g.lineTo(X(px, z), Y(FX.lampH, z));
          g.lineTo(X(hx, z), Y(FX.lampH + 0.1, z));
          g.stroke();
          g.globalCompositeOperation = 'lighter';
          // The pool on the road under the lamp.
          const pw = (2.8 * F) / z;
          const ph = Math.max(2, Y(0, Math.max(0.5, z - 1.8)) - Y(0, z + 1.8));
          g.globalAlpha = 0.42 * fade;
          g.drawImage(sprites[5], X(hx, z) - pw / 2, Y(0, z) - ph / 2, pw, ph);
          // The wash on the wall behind it.
          const wa = X(side * FX.wall, Math.max(0.6, z - 2.2));
          const wb = X(side * FX.wall, z + 2.2);
          g.globalAlpha = 0.22 * fade;
          g.drawImage(sprites[5], Math.min(wa, wb), Y(FX.lampH + 0.6, z), Math.abs(wb - wa), Y(0, z) - Y(FX.lampH + 0.6, z));
          // The lamp itself (its glow capped, so the nearest one never floods the frame) and its smear down the wet road.
          const r = Math.min(W * 0.05, Math.max(2, (0.5 * F) / z));
          g.globalAlpha = 0.85 * fade;
          g.drawImage(sprites[4], X(hx, z) - r, Y(FX.lampH, z) - r, r * 2, r * 2);
          g.globalAlpha = 0.16 * fade;
          g.drawImage(sprites[5], X(hx, z) - r * 0.35, Y(0, z), r * 0.7, r * 2.6);
          g.globalAlpha = 1;
          g.globalCompositeOperation = 'source-over';
        }
      }
    }

    // Racers, a pack at a time: taillights bursting past from behind and pulling away (some on nitrous), or headlights rushing at us.
    // A new pack waits until the last one has cleared the near end of the street (pulling away) or the far end (oncoming).
    if (t > nextPack && racers.every((c) => (c.dir > 0 ? c.z > 18 : c.z < 30))) {
      spawnPack();
      nextPack = t + between(FX.packGap);
    }
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    for (let i = racers.length - 1; i >= 0; i--) {
      const c = racers[i];
      if (c.burn > 0) c.burn -= dt;
      else if (c.dir > 0 && c.z > 2 && Math.random() < FX.nitroChance * dt) {
        c.burn = between(FX.nitroBurn);
        c.stage = Math.floor(Math.random() * 3);
      }
      c.z += c.dir * (c.speed + Math.sin(t * 0.9 + c.phase) * 1.2 + (c.burn > 0 ? 7 : 0)) * dt * speed;
      if (c.dir < 0 ? c.z < 0.55 : c.z > FX.far) {
        racers.splice(i, 1);
        continue;
      }
      if (c.z < 0.9 || c.z > FX.far) continue;
      const x = c.x + Math.sin(t * 1.3 + c.phase) * 0.12;
      const trail = c.speed * 0.09 * (warping ? speed * 0.6 : 1);
      const head = c.dir < 0 ? HEAD : RED;
      const fade = Math.min(1, (FX.far - c.z) / 12, (c.z - 0.9) / 0.5) * rd;
      const s = F / c.z;
      for (const off of [-0.17, 0.17]) {
        const ax = X(x + off, c.z);
        const ay = Y(0, c.z);
        const z2 = c.z + (c.dir < 0 ? trail : -Math.min(trail, c.z - 0.6));
        const bx = X(x + off, z2);
        const by = Y(0, z2);
        const w = Math.max(1, s * (c.dir < 0 ? 0.03 : 0.022));
        const grad = g.createLinearGradient(ax, ay, bx, by);
        grad.addColorStop(0, `rgba(${head},${0.95 * fade})`);
        grad.addColorStop(1, `rgba(${head},0)`);
        g.strokeStyle = grad;
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke();
        // Bloom at the lamp itself.
        const r = Math.max(3, s * (c.dir < 0 ? 0.11 : 0.07));
        g.globalAlpha = 0.6 * fade;
        g.drawImage(sprites[c.dir < 0 ? 4 : 1], ax - r, ay - r, r * 2, r * 2);
        g.globalAlpha = 1;
        // The light's reflection smeared down the wet road.
        g.strokeStyle = `rgba(${head},${0.18 * fade})`;
        g.lineWidth = w * 0.7;
        g.beginPath();
        g.moveTo(ax, ay + w);
        g.lineTo(ax, ay + w + s * 0.12);
        g.stroke();
      }
      // Nitrous: a flame between the taillights and a trail streaming back at us in the stage's color.
      if (c.burn > 0) {
        const ax = X(x, c.z);
        const ay = Y(0.02, c.z);
        const z2 = Math.max(0.6, c.z - trail * 2.2);
        const bx = X(x, z2);
        const by = Y(0.02, z2);
        const a = Math.min(1, c.burn * 4) * fade;
        const grad = g.createLinearGradient(ax, ay, bx, by);
        grad.addColorStop(0, `rgba(${NITRO_RGB[c.stage]},${0.9 * a})`);
        grad.addColorStop(1, `rgba(${NITRO_RGB[c.stage]},0)`);
        g.strokeStyle = grad;
        g.lineWidth = Math.max(1.5, s * 0.05);
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke();
        const r = Math.max(4, s * 0.16) * (0.85 + 0.15 * Math.sin(t * 40 + c.phase));
        g.globalAlpha = 0.8 * a;
        g.drawImage(sprites[NITRO_SPRITE[c.stage]], ax - r, ay - r, r * 2, r * 2);
        g.globalAlpha = 1;
      }
    }
    g.globalCompositeOperation = 'source-over';

    // Rain across everything.
    const rn = ease(FX.rainIn[0], FX.rainIn[1], t) * 0.16;
    if (rn > 0) {
      g.strokeStyle = `rgba(193,192,192,${rn})`;
      g.lineWidth = 1;
      g.beginPath();
      for (const d of rain) {
        d.y += d.v * dt * (warping ? speed * 0.5 : 1);
        if (d.y > 1.05) {
          d.y -= 1.1;
          d.x = Math.random() * 1.2 - 0.1;
        }
        const x = d.x * W - d.y * H * 0.18;
        const y = d.y * H;
        g.moveTo(x, y);
        g.lineTo(x - d.len * 0.18, y + d.len);
      }
      g.stroke();
    }

    // Nitrous: the frame's edges burn in, climbing cyan, purple, then red, as in a race's warp (render/post.ts).
    if (warping) {
      const k = (t - warpAt) / FX.warpStage;
      const stage = Math.min(2, Math.floor(k));
      const a = Math.min(1, k * 1.5);
      const r = Math.hypot(W, H) / 2;
      const edge = g.createRadialGradient(W / 2, H / 2, r * 0.45, W / 2, H / 2, r);
      edge.addColorStop(0, `rgba(${NITRO_RGB[stage]},0)`);
      edge.addColorStop(1, `rgba(${NITRO_RGB[stage]},${0.32 * a})`);
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = edge;
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'source-over';
    }
  };
  raf = requestAnimationFrame(frame);

  return {
    warp() {
      warping = true;
      warpAt = (performance.now() - t0) / 1000;
    },
    stop() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    },
  };
}
