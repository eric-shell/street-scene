/**
 * Splash motion graphics: one 2D canvas behind the title. A night road runs
 * from under the title to a vanishing point on the horizon, its lane dashes
 * rushing at the viewer; headlights streak past on the oncoming lanes and
 * taillights pull away on the others, each with a smear of reflection on the
 * wet asphalt; a skyline of lit windows sits on the horizon with out of focus
 * neon bokeh drifting above it, and fine rain falls across everything. When
 * the title flies onto the menu, warp() floors it: everything speeds up and
 * stretches toward the viewer while the splash fades.
 *
 * Cheap by design (a few dozen strokes per frame, sprites pre-rendered, no
 * shadow blur) because the city's first frames render underneath at the same
 * time; it only runs while the splash is up. Reduced motion never starts it.
 */

import { PALETTE, rgb } from './palette';

export interface SplashFx {
  /** Floor it: speed everything up for the flight onto the menu. */
  warp(): void;
  stop(): void;
}

/** Timeline (s from start), speeds and counts. */
const FX = {
  /** Reveals: skyline, road lines drawing out from the horizon, bokeh, rain. */
  skylineIn: [0.15, 1.1],
  roadIn: [0.1, 0.9],
  bokehIn: [0.25, 1.6],
  rainIn: [0, 0.8],
  /** First car lights, and the gap between spawns (s). */
  carsFrom: 0.4,
  carGap: [0.1, 0.35],
  /** Skyline height (fraction of the space above the horizon) and the sway of the vanishing point (fraction of width, rad/s). */
  skyline: 0.24,
  sway: 0.012,
  swayRate: 0.7,
  /** Road: lane dash speed (units/s), dash spacing and length, far plane. */
  dashSpeed: 16,
  dashSpacing: 4,
  dashLength: 1.6,
  far: 70,
  /** Warp: speed multiplier reached and how fast (1/s). */
  warpMax: 7,
  warpRate: 5,
  bokeh: 26,
  rain: 90,
  cars: 9,
} as const;

/** Sign and bokeh colors: signs use the first three; taillights are [1], headlights [4]. */
const NEON = [PALETTE.orange, PALETTE.red, PALETTE.yellow, PALETTE.cyan, '#fff4d6'];
/** "r,g,b" triples for the gradients built per frame. */
const ORANGE = rgb('orange');
const YELLOW = rgb('yellow');
const RED = rgb('red');
const BG = rgb('bg0');
const ease = (a: number, b: number, t: number) => {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
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

export interface SplashFxLayout {
  /** Horizon height (CSS px from the top). */
  horizon(): number;
  /** Where the title block is, so a dark plate keeps it readable over the skyline. */
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
  let skyline: HTMLCanvasElement | null = null;
  let title = new DOMRect();
  let windows: { x: number; y: number; w: number; h: number; on: boolean }[] = [];

  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    horizon = layout.horizon();
    title = layout.title();
    buildSkyline();
  };

  /** Building silhouettes on the horizon with a grid of windows, some lit, and the odd neon sign. */
  function buildSkyline(): void {
    const sh = Math.max(36, horizon * FX.skyline);
    const c = document.createElement('canvas');
    c.width = Math.round(W * dpr);
    c.height = Math.round(sh * dpr);
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    windows = [];
    let x = -10;
    while (x < W + 10) {
      const bw = 18 + Math.random() * 46;
      // Taller toward the middle, like a downtown behind the road.
      const mid = 1 - Math.abs(x + bw / 2 - W / 2) / (W / 2);
      const bh = sh * (0.25 + Math.random() * 0.45 + mid * 0.3);
      const shade = Math.random() * 7;
      g.fillStyle = `rgb(${22 + shade}, ${20 + shade}, ${23 + shade})`;
      g.fillRect(x, sh - bh, bw, bh);
      for (let wy = sh - bh + 5; wy < sh - 4; wy += 6) {
        for (let wx = x + 3; wx < x + bw - 4; wx += 5) {
          windows.push({ x: wx, y: wy, w: 2.2, h: 3, on: Math.random() < 0.16 });
        }
      }
      if (Math.random() < 0.18) {
        g.fillStyle = NEON[Math.floor(Math.random() * 3)];
        g.globalAlpha = 0.85;
        g.fillRect(x + bw * 0.2, sh - bh + 6, bw * 0.6, 3);
        g.globalAlpha = 1;
      }
      x += bw + Math.random() * 4;
    }
    for (const w of windows) drawWindow(g, w);
    skyline = c;
  }
  function drawWindow(g: CanvasRenderingContext2D, w: { x: number; y: number; w: number; h: number; on: boolean }): void {
    g.fillStyle = w.on ? (Math.random() < 0.8 ? PALETTE.yellow : '#e8e4d8') : '#1c1a1d';
    g.fillRect(w.x, w.y, w.w, w.h);
  }

  resize();
  window.addEventListener('resize', resize);

  const bokeh = Array.from({ length: FX.bokeh }, () => ({
    x: Math.random(),
    y: Math.random() * 0.9,
    r: 8 + Math.random() ** 2 * 54,
    sprite: Math.floor(Math.random() * sprites.length),
    phase: Math.random() * 6.28,
    drift: (Math.random() - 0.5) * 0.012,
    alpha: 0.12 + Math.random() * 0.3,
  }));
  const rain = Array.from({ length: FX.rain }, () => ({ x: Math.random() * 1.2 - 0.1, y: Math.random(), len: 8 + Math.random() * 16, v: 0.9 + Math.random() * 0.6 }));
  const cars: Car[] = [];
  let nextCar = FX.carsFrom;

  // Road projection: road units to screen. The near plane z = 1 puts the road edges (x = +-2) near the screen sides.
  let vpx = 0;
  const proj = (x: number, z: number) => {
    const F = 0.36 * W;
    const h0 = (H - horizon) / F;
    return { x: vpx + (x * F) / z, y: horizon + (h0 * F) / z, s: F / z };
  };

  const t0 = performance.now();
  let last = t0;
  let travel = 0;
  let speed = 1;
  let warping = false;
  let raf = 0;

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const t = (now - t0) / 1000;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (warping) speed += (FX.warpMax - speed) * (1 - Math.exp(-dt * FX.warpRate));
    travel += dt * FX.dashSpeed * speed;
    // The road sways a touch, like the view from a moving car.
    vpx = W / 2 + Math.sin(t * FX.swayRate) * W * FX.sway;
    const g = ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    // Bokeh above the horizon, drifting and breathing.
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

    // Skyline, with a few windows switching each frame.
    if (skyline) {
      const sk = ease(FX.skylineIn[0], FX.skylineIn[1], t);
      if (sk > 0) {
        const sg = skyline.getContext('2d')!;
        sg.setTransform(dpr, 0, 0, dpr, 0, 0);
        for (let k = 0; k < 3 && windows.length; k++) {
          const w = windows[Math.floor(Math.random() * windows.length)];
          w.on = Math.random() < 0.3;
          drawWindow(sg, w);
        }
        g.globalAlpha = sk;
        const sh = skyline.height / dpr;
        g.drawImage(skyline, 0, horizon - sh, W, sh);
        g.globalAlpha = 1;
      }
    }
    // A dark plate behind the title so the tagline reads over the windows.
    {
      const cx = title.left + title.width / 2;
      const cy = title.top + title.height / 2;
      const r = Math.max(title.width, title.height) * 0.75;
      const plate = g.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
      plate.addColorStop(0, `rgba(${BG},0.8)`);
      plate.addColorStop(1, `rgba(${BG},0)`);
      g.fillStyle = plate;
      g.fillRect(cx - r, cy - r, r * 2, r * 2);
    }

    // Glow on the horizon line and the title's reflection pooling on the wet road.
    const rd = ease(FX.roadIn[0], FX.roadIn[1], t);
    if (rd > 0) {
      const hg = g.createLinearGradient(0, horizon - 30, 0, horizon + 40);
      hg.addColorStop(0, `rgba(${ORANGE},0)`);
      hg.addColorStop(0.45, `rgba(${ORANGE},${0.16 * rd})`);
      hg.addColorStop(1, `rgba(${RED},0)`);
      g.fillStyle = hg;
      g.fillRect(0, horizon - 30, W, 70);
      g.globalCompositeOperation = 'lighter';
      const pool = g.createRadialGradient(W / 2, horizon + (H - horizon) * 0.18, 0, W / 2, horizon + (H - horizon) * 0.18, W * 0.32);
      pool.addColorStop(0, `rgba(${YELLOW},${0.08 * rd})`);
      pool.addColorStop(0.5, `rgba(${ORANGE},${0.05 * rd})`);
      pool.addColorStop(1, `rgba(${ORANGE},0)`);
      g.fillStyle = pool;
      g.fillRect(0, horizon, W, H - horizon);
      g.globalCompositeOperation = 'source-over';
    }

    // Road: edges and the center line draw out from the horizon toward the viewer, lane dashes stream at it.
    if (rd > 0) {
      const zNear = FX.far - (FX.far - 1) * rd;
      const line = (x: number, color: string, width: number) => {
        const a = proj(x, FX.far);
        const b = proj(x, zNear);
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
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
          const a = proj(x, z);
          const b = proj(x, z2);
          g.lineWidth = Math.max(0.6, a.s * 0.012);
          g.beginPath();
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.stroke();
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
        const a = proj(c.x + off, c.z);
        const b = proj(c.x + off, c.z + (c.dir < 0 ? trail : -Math.min(trail, c.z - 0.6)));
        const w = Math.max(1, a.s * (c.dir < 0 ? 0.03 : 0.022));
        const grad = g.createLinearGradient(a.x, a.y, b.x, b.y);
        grad.addColorStop(0, `rgba(${head},${0.95 * fade})`);
        grad.addColorStop(1, `rgba(${head},0)`);
        g.strokeStyle = grad;
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
        // Bloom at the lamp itself.
        const r = Math.max(3, a.s * (c.dir < 0 ? 0.11 : 0.07));
        g.globalAlpha = 0.6 * fade;
        g.drawImage(sprites[c.dir < 0 ? 4 : 1], a.x - r, a.y - r, r * 2, r * 2);
        g.globalAlpha = 1;
        // The light's reflection smeared down the wet road.
        g.strokeStyle = `rgba(${head},${0.18 * fade})`;
        g.lineWidth = w * 0.7;
        g.beginPath();
        g.moveTo(a.x, a.y + w);
        g.lineTo(a.x, a.y + w + a.s * 0.12);
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
