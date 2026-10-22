/**
 * Splash motion graphics: one 2D canvas behind the title, a drive down a city
 * street at night in one-point perspective. Buildings line both sides, their
 * lit windows streaming past, neon blade signs hanging off them; streetlights
 * march along the curbs, each pooling warm light on the wet road and washing
 * the wall behind it as it sweeps by; lane dashes rush in, headlights streak
 * past on the oncoming lanes and taillights pull away on the others, each
 * smeared on the asphalt; the far end of the street glows with the city, neon
 * bokeh drifts across the view and fine rain falls over everything. When the
 * title flies onto the menu, warp() floors it: everything speeds up and the
 * windows stretch into streaks of light while the splash fades.
 *
 * Cheap by design (window rows batched into a few paths per frame, glows
 * pre-rendered as sprites, no shadow blur), because the city's first frames
 * render underneath at the same time; it only runs while the splash is up.
 * Reduced motion never starts it.
 */

import { PALETTE, rgb } from '../kit/palette';

export interface SplashFx {
  /** Floor it: speed everything up for the flight onto the menu. */
  warp(): void;
  stop(): void;
}

/** Timeline (s from start), speeds, the street's dimensions (road units: the curbs are at ±2) and counts. */
const FX = {
  /** Reveals: the road drawing out from the vanishing point, then the buildings, the streetlights, bokeh and rain. */
  roadIn: [0.1, 0.9],
  streetIn: [0.15, 1.25],
  lampsIn: [0.35, 1.3],
  bokehIn: [0.25, 1.6],
  rainIn: [0, 0.8],
  /** First car lights, and the gap between spawns (s). */
  carsFrom: 0.4,
  carGap: [0.1, 0.35],
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
  /** Building lengths and heights, and the chance of a blade sign. */
  length: [4, 11],
  height: [3.2, 10],
  signs: 0.4,
  /** Streetlights: spacing, pole line, height and how far the arm reaches over the road. */
  lampGap: 9,
  lampX: 2.35,
  lampH: 2.6,
  lampReach: 0.65,
  /** Windows fade into the haze from here to the far plane. */
  hazeFrom: 26,
  /** Warp: speed multiplier reached and how fast (1/s). */
  warpMax: 7,
  warpRate: 5,
  bokeh: 20,
  rain: 90,
  cars: 9,
} as const;

/** Sign and bokeh colors: signs use the first four; taillights are [1], headlights [4], streetlights [5]. */
const NEON = [PALETTE.orange, PALETTE.red, PALETTE.yellow, PALETTE.cyan, '#fff4d6', '#ffb45e'];
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
const BG = rgb('bg0');
const ease = (a: number, b: number, t: number) => {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};
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

interface Car {
  /** Lane center (road units, - left), depth (units), +1 pulling away (taillights) or -1 oncoming (headlights). */
  x: number;
  z: number;
  dir: number;
  speed: number;
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

/** One side of the street: buildings end to end over the repeating span, an alley gap here and there. */
function street(): Building[] {
  const out: Building[] = [];
  let z = 0;
  while (z < FX.span - 2) {
    const len = Math.min(FX.length[0] + Math.random() * (FX.length[1] - FX.length[0]), FX.span - z);
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
    out.push({
      z,
      len,
      h,
      fill: `rgb(${Math.round(tone[0] + shade)},${Math.round(tone[1] + shade)},${Math.round(tone[2] + shade)})`,
      sign: Math.random() < FX.signs ? Math.floor(Math.random() * 4) : -1,
      signY: 1.1 + Math.random() * 1.3,
      signAt: 0.2 + Math.random() * 0.6,
      windows,
    });
    z += len + (Math.random() < 0.25 ? 0.6 + Math.random() : 0.05);
  }
  return out;
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
  const cars: Car[] = [];
  let nextCar = FX.carsFrom;

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
    // How far the street has drawn out toward the viewer as it reveals.
    const reach = FX.far - (FX.far - 1) * st;
    const near = Math.max(0.35, reach);

    // The city glowing at the far end of the street, and a haze along the horizon.
    {
      const glow = g.createRadialGradient(vpx, horizon, 0, vpx, horizon, W * 0.42);
      glow.addColorStop(0, `rgba(${ORANGE},${0.2 * rd})`);
      glow.addColorStop(0.35, `rgba(${RED},${0.07 * rd})`);
      glow.addColorStop(1, `rgba(${RED},0)`);
      g.fillStyle = glow;
      g.fillRect(0, 0, W, H);
    }

    // Buildings: facades on both building lines, storey bands, lit windows and the cornice.
    if (st > 0) {
      const stretch = warping ? 1 + (speed - 1) * 0.55 : 1;
      for (let side = -1; side <= 1; side += 2) {
        const list = sides[side < 0 ? 0 : 1];
        // Facades.
        for (const b of list) {
          const z0 = Math.max(near, mod(b.z - travel, FX.span) - 4);
          const z1 = Math.min(FX.far, mod(b.z - travel, FX.span) - 4 + b.len);
          if (z1 <= z0) continue;
          g.fillStyle = b.fill;
          g.globalAlpha = st;
          g.beginPath();
          wallQuad(g, side, z0, z1, 0, b.h);
          g.fill();
        }
        // Storey bands: a darker strip where each row of windows sits.
        g.fillStyle = 'rgba(0,0,0,0.28)';
        g.beginPath();
        for (const b of list) {
          const zs = mod(b.z - travel, FX.span) - 4;
          const z0 = Math.max(near, zs + 0.15);
          const z1 = Math.min(FX.far, zs + b.len - 0.15);
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
              const zs = mod(b.z - travel, FX.span) - 4;
              if (zs + b.len < near || zs > FX.far) continue;
              const w = b.windows[c];
              for (let i = 0; i < w.length; i += 3) {
                const wz = zs + 0.25 + w[i] * FX.bay;
                const a = Math.max(near, wz);
                const e = Math.min(FX.far, wz + 0.42 * stretch);
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
          const zs = mod(b.z - travel, FX.span) - 4;
          const z0 = Math.max(near, zs);
          const z1 = Math.min(FX.far, zs + b.len);
          if (z1 <= z0) continue;
          g.moveTo(X(side * FX.wall, z0), Y(b.h, z0));
          g.lineTo(X(side * FX.wall, z1), Y(b.h, z1));
        }
        g.stroke();
        g.globalAlpha = 1;
      }
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
        for (const b of sides[side < 0 ? 0 : 1]) {
          if (b.sign < 0) continue;
          const z = mod(b.z - travel, FX.span) - 4 + b.len * b.signAt;
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

    // Streetlights: poles along both curbs, a warm pool on the road and a wash on the wall at each.
    if (lp > 0) {
      g.strokeStyle = `rgba(10,10,12,${0.9 * lp})`;
      g.lineCap = 'butt';
      for (let side = -1; side <= 1; side += 2) {
        for (let k = 0; k * FX.lampGap < FX.span; k++) {
          const z = mod(k * FX.lampGap + (side > 0 ? FX.lampGap / 2 : 0) - travel, FX.span) - 4;
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

    // Cars: headlights rushing past on the left lanes, taillights pulling away on the right.
    if (t > nextCar && cars.length < FX.cars) {
      const dir = Math.random() < 0.55 ? -1 : 1;
      const lane = dir < 0 ? -1.5 + Math.round(Math.random()) : 0.5 + Math.round(Math.random());
      cars.push({ x: lane + (Math.random() - 0.5) * 0.2, z: dir < 0 ? FX.far : 1.2, dir, speed: (dir < 0 ? 30 : 12) + Math.random() * 12 });
      nextCar = t + FX.carGap[0] + Math.random() * (FX.carGap[1] - FX.carGap[0]);
    }
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    for (let i = cars.length - 1; i >= 0; i--) {
      const c = cars[i];
      c.z += c.dir * c.speed * dt * speed;
      if (c.z < 0.55 || c.z > FX.far) {
        cars.splice(i, 1);
        continue;
      }
      const trail = c.speed * 0.09 * (warping ? speed * 0.6 : 1);
      const head = c.dir < 0 ? '255,250,235' : RED;
      const fade = Math.min(1, (FX.far - c.z) / 12) * rd;
      for (const off of [-0.17, 0.17]) {
        const ax = X(c.x + off, c.z);
        const ay = Y(0, c.z);
        const z2 = c.z + (c.dir < 0 ? trail : -Math.min(trail, c.z - 0.6));
        const bx = X(c.x + off, z2);
        const by = Y(0, z2);
        const s = F / c.z;
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
  };
  raf = requestAnimationFrame(frame);

  return {
    warp() {
      warping = true;
    },
    stop() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    },
  };
}
