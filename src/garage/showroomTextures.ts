/**
 * Canvas textures for the garage (garage/showroom.ts): stained concrete, grimy
 * block walls, the roof deck, the roller door, worn paint lines, oil stains,
 * diamond plate, the pegboard, drawer fronts, aged posters, the jobs board,
 * work orders, the tuners' parts boxes, the beer sign, the nameplates, the
 * banners, bay numbers, exit signs, plates, clock and calendar, the light
 * washes, and the dyno screen redrawn as it runs.
 * Each is drawn once per visit (a few milliseconds in all) from a fixed hash,
 * so the room looks the same every time. Render only.
 */
import * as THREE from 'three';
import { PALETTE } from '../ui/kit/palette';
import { canvas, drawTexture, fitFont } from '../render/textures/canvasKit';

/** A small deterministic hash noise in 0..1 for texture speckle and flicker. */
export function noise(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** An irregular blot: overlapping soft discs round (x, y), for oil, water and grime. */
function blot(g: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string, alpha: number, seed: number): void {
  for (let k = 0; k < 7; k++) {
    const a = noise(seed + k * 1.7) * Math.PI * 2;
    const d = noise(seed + k * 3.1) * r * 0.6;
    const rr = r * (0.35 + noise(seed + k * 5.3) * 0.5);
    const cx = x + Math.cos(a) * d;
    const cy = y + Math.sin(a) * d;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
    grad.addColorStop(0, `rgba(${rgb},${alpha})`);
    grad.addColorStop(0.6, `rgba(${rgb},${alpha * 0.6})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, rr, 0, Math.PI * 2);
    g.fill();
  }
}

/** A hairline crack: a jittered walk from (x, y). */
function crack(g: CanvasRenderingContext2D, x: number, y: number, len: number, seed: number): void {
  g.beginPath();
  g.moveTo(x, y);
  let a = noise(seed) * Math.PI * 2;
  for (let i = 0; i < len; i++) {
    a += (noise(seed + i * 0.91) - 0.5) * 0.9;
    x += Math.cos(a) * 6;
    y += Math.sin(a) * 6;
    g.lineTo(x, y);
  }
  g.stroke();
}

/**
 * Shop concrete, 8 m square at 128 px/m times `res`: mottled grey, speckle,
 * saw-cut joints every 4 m, hairline cracks, patched repairs, tire scuffs and
 * oil stains, laid out on a 1024 grid and scaled, then fine aggregate at the
 * full resolution. The roughness makes oil and wet patches glossier, so the
 * lights pick them out as dull puddles; the bump is a 2 m tile of aggregate
 * and pits for the material to repeat finer than the color.
 */
export function concreteTextures(res = 1): { color: THREE.CanvasTexture; rough: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const S = 1024;
  const stains: [number, number, number][] = [];
  for (let i = 0; i < 11; i++) stains.push([noise(i * 9.1) * S, noise(i * 4.7 + 2) * S, 30 + noise(i * 2.3) * 70]);
  const color = drawTexture(S * res, S * res, (g) => {
    g.scale(res, res);
    g.fillStyle = '#4a4946';
    g.fillRect(0, 0, S, S);
    // Low frequency mottling: big soft patches lighter and darker.
    for (let i = 0; i < 60; i++) {
      const light = noise(i * 1.9) > 0.5;
      blot(g, noise(i * 3.3) * S, noise(i * 7.1) * S, 80 + noise(i) * 160, light ? '120,118,112' : '20,20,22', 0.1, i * 13);
    }
    for (let i = 0; i < 26000; i++) {
      const n = noise(i * 1.31);
      g.fillStyle = n > 0.66 ? 'rgba(255,255,255,0.06)' : n > 0.33 ? 'rgba(0,0,0,0.13)' : 'rgba(110,100,90,0.08)';
      g.fillRect(noise(i * 2.7) * S, noise(i * 5.3) * S, 1.6, 1.6);
    }
    // A patched repair: a squarer, smoother rectangle of newer concrete.
    g.fillStyle = 'rgba(96,94,90,0.55)';
    g.fillRect(610, 180, 190, 120);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 2;
    g.strokeRect(610, 180, 190, 120);
    // Hairline cracks.
    g.strokeStyle = 'rgba(10,10,10,0.5)';
    g.lineWidth = 1.2;
    for (let i = 0; i < 9; i++) crack(g, noise(i * 6.6) * S, noise(i * 8.8) * S, 18 + Math.floor(noise(i * 2.2) * 30), i * 31);
    // Tire scuffs: long faint dark arcs where cars were pushed and turned.
    g.lineCap = 'round';
    for (let i = 0; i < 14; i++) {
      const cx = noise(i * 5.5) * S;
      const cy = noise(i * 3.9) * S;
      const r = 200 + noise(i * 1.1) * 500;
      const a0 = noise(i * 2.9) * Math.PI * 2;
      g.strokeStyle = `rgba(8,8,8,${0.06 + noise(i * 7.7) * 0.08})`;
      g.lineWidth = 10 + noise(i) * 8;
      g.beginPath();
      g.arc(cx, cy, r, a0, a0 + 0.3 + noise(i * 4.4) * 0.5);
      g.stroke();
    }
    // Oil stains: dark cores with a brown halo.
    stains.forEach(([x, y, r], i) => {
      blot(g, x, y, r * 1.5, '60,45,30', 0.1, i * 41);
      blot(g, x, y, r, '14,12,10', 0.3, i * 17);
    });
    // Saw-cut joints every 4 m.
    g.fillStyle = 'rgba(0,0,0,0.6)';
    for (const p of [0, 512]) {
      g.fillRect(p, 0, 3, S);
      g.fillRect(0, p, S, 3);
    }
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (const p of [3, 515]) {
      g.fillRect(p, 0, 1, S);
      g.fillRect(0, p, S, 1);
    }
    // Fine aggregate at the full resolution: single pixel grains, light and dark.
    g.setTransform(1, 0, 0, 1, 0, 0);
    const F = S * res;
    for (let i = 0; i < 60000 * res * res; i++) {
      const n = noise(i * 0.73 + 5);
      g.fillStyle = n > 0.7 ? 'rgba(200,196,188,0.09)' : n > 0.35 ? 'rgba(0,0,0,0.12)' : 'rgba(120,104,88,0.07)';
      g.fillRect(noise(i * 1.93) * F, noise(i * 3.17) * F, 1, 1);
    }
  });
  const bump = drawTexture(
    512,
    512,
    (g) => {
      g.fillStyle = '#808080';
      g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 9000; i++) {
        const n = noise(i * 2.11 + 1);
        g.fillStyle = n > 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
        const r = 0.6 + noise(i * 4.3) * 1.4;
        g.fillRect(noise(i * 1.37) * 512, noise(i * 2.71) * 512, r, r);
      }
      // Pits: small dark holes where air was trapped in the pour.
      g.fillStyle = 'rgba(0,0,0,0.7)';
      for (let i = 0; i < 140; i++) {
        g.beginPath();
        g.arc(noise(i * 6.1) * 512, noise(i * 9.7) * 512, 1 + noise(i * 3.3) * 2.2, 0, Math.PI * 2);
        g.fill();
      }
    },
    { srgb: false },
  );
  const rough = drawTexture(
    256 * res,
    256 * res,
    (g) => {
      g.scale(res, res);
      // Green channel is roughness: bare concrete is matt, the stains are slick.
      g.fillStyle = 'rgb(0,225,0)';
      g.fillRect(0, 0, 256, 256);
      stains.forEach(([x, y, r], i) => blot(g, x / 4, y / 4, r / 4, '0,95,0', 0.7, i * 17));
      for (let i = 0; i < 6; i++) blot(g, noise(i * 12.1) * 256, noise(i * 6.3) * 256, 20 + noise(i) * 26, '0,110,0', 0.5, i * 71);
    },
    { srgb: false },
  );
  return { color, rough, bump };
}

/**
 * The block wall, 6.4 m wide and the room's full height (so the grime can
 * follow it): painted block, a darker scuffed band to waist height under a
 * worn safety stripe, soot under the roof, rust and water streaks running down,
 * flaking paint and dirt kicked up along the floor.
 */
export function wallTexture(height: number, band: number): THREE.CanvasTexture {
  const W = 1024;
  const H = 960;
  const pxm = H / height;
  const bandPx = H - band * pxm;
  return drawTexture(W, H, (g) => {
    g.fillStyle = '#2b2a2c';
    g.fillRect(0, 0, W, H);
    // Blocks 0.4 x 0.2 m in running bond.
    const bw = W / 16;
    const bh = 0.2 * pxm;
    for (let row = 0; row * bh < H; row++) {
      const off = row & 1 ? bw / 2 : 0;
      const y = H - (row + 1) * bh;
      const low = y + bh > bandPx;
      for (let col = -1; col < 17; col++) {
        const v = Math.floor(noise(row * 31 + col) * 10);
        g.fillStyle = low ? `rgb(${30 + v},${37 + v},${38 + v})` : `rgb(${58 + v},${57 + v},${55 + v})`;
        g.fillRect(col * bw + off + 2, y + 2, bw - 4, bh - 4);
        g.fillStyle = 'rgba(255,255,255,0.03)';
        g.fillRect(col * bw + off + 2, y + 2, bw - 4, 2);
      }
    }
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = noise(i) > 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.12)';
      g.fillRect(noise(i * 3.1) * W, noise(i * 7.7) * H, 2, 2);
    }
    // Flaking paint on the upper wall: lighter bare block showing through.
    for (let i = 0; i < 14; i++) blot(g, noise(i * 4.1) * W, noise(i * 2.9) * bandPx * 0.9, 18 + noise(i) * 30, '92,88,80', 0.25, i * 23);
    // The safety stripe over the band, worn through in places.
    g.fillStyle = '#b8932f';
    g.fillRect(0, bandPx - 14, W, 12);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = 'rgba(40,38,36,0.75)';
      g.fillRect(noise(i * 6.1) * W, bandPx - 14 + noise(i * 2.2) * 8, 4 + noise(i * 9.9) * 26, 3 + noise(i) * 6);
    }
    // Scuffs and knocks on the band: trolleys, bumpers, boots.
    g.lineCap = 'round';
    for (let i = 0; i < 30; i++) {
      g.strokeStyle = noise(i * 5.1) > 0.5 ? 'rgba(0,0,0,0.3)' : 'rgba(150,150,150,0.12)';
      g.lineWidth = 2 + noise(i) * 4;
      const x = noise(i * 7.3) * W;
      const y = bandPx + 20 + noise(i * 3.7) * (H - bandPx - 40);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 20 + noise(i * 1.3) * 60, y + (noise(i * 8.1) - 0.5) * 10);
      g.stroke();
    }
    // Soot and nicotine under the roof.
    const soot = g.createLinearGradient(0, 0, 0, H * 0.35);
    soot.addColorStop(0, 'rgba(8,7,6,0.75)');
    soot.addColorStop(1, 'rgba(8,7,6,0)');
    g.fillStyle = soot;
    g.fillRect(0, 0, W, H * 0.35);
    // Streaks running down from the roof: water, rust from the purlins.
    for (let i = 0; i < 26; i++) {
      const x = noise(i * 11.3) * W;
      const len = H * (0.2 + noise(i * 2.7) * 0.6);
      const rust = noise(i * 5.9) > 0.6;
      const grad = g.createLinearGradient(0, 0, 0, len);
      const c = rust ? '96,52,24' : '12,11,10';
      grad.addColorStop(0, `rgba(${c},${rust ? 0.5 : 0.45})`);
      grad.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = grad;
      g.fillRect(x, 0, 3 + noise(i) * 9, len);
    }
    // Dirt kicked up along the floor.
    const dirt = g.createLinearGradient(0, H - 0.5 * pxm, 0, H);
    dirt.addColorStop(0, 'rgba(14,12,10,0)');
    dirt.addColorStop(1, 'rgba(14,12,10,0.7)');
    g.fillStyle = dirt;
    g.fillRect(0, H - 0.5 * pxm, W, 0.5 * pxm);
  });
}

/** The roof deck seen from below: corrugated steel, dark with a few rust blooms. 2 m square. */
export function deckTexture(): THREE.CanvasTexture {
  return drawTexture(256, 256, (g) => {
    for (let x = 0; x < 256; x += 16) {
      const grad = g.createLinearGradient(x, 0, x + 16, 0);
      grad.addColorStop(0, '#1d1d20');
      grad.addColorStop(0.5, '#2c2c30');
      grad.addColorStop(1, '#151517');
      g.fillStyle = grad;
      g.fillRect(x, 0, 16, 256);
    }
    for (let i = 0; i < 5; i++) blot(g, noise(i * 3.3) * 256, noise(i * 9.7) * 256, 14 + noise(i) * 20, '70,40,20', 0.35, i * 5);
  });
}

/** A roller door: dented slats, rust weeping from the bottom rail, grime and the hazard band. */
export function doorTexture(): THREE.CanvasTexture {
  return drawTexture(256, 512, (g) => {
    for (let y = 0; y < 512; y += 12) {
      const grad = g.createLinearGradient(0, y, 0, y + 12);
      grad.addColorStop(0, '#4b5058');
      grad.addColorStop(0.45, '#33373e');
      grad.addColorStop(0.55, '#25282d');
      grad.addColorStop(1, '#3e434b');
      g.fillStyle = grad;
      g.fillRect(0, y, 256, 12);
    }
    // Dents: a dark smudge with a lit lip.
    for (let i = 0; i < 5; i++) {
      const x = 30 + noise(i * 4.4) * 200;
      const y = 300 + noise(i * 2.1) * 170;
      blot(g, x, y, 16, '0,0,0', 0.35, i * 9);
    }
    for (let i = 0; i < 18; i++) {
      const x = noise(i * 7.7) * 256;
      const len = 60 + noise(i * 3.1) * 200;
      const grad = g.createLinearGradient(0, 488 - len, 0, 488);
      grad.addColorStop(0, 'rgba(110,58,24,0)');
      grad.addColorStop(1, 'rgba(110,58,24,0.55)');
      g.fillStyle = grad;
      g.fillRect(x, 488 - len, 2 + noise(i) * 5, len);
    }
    const grime = g.createLinearGradient(0, 380, 0, 488);
    grime.addColorStop(0, 'rgba(10,9,8,0)');
    grime.addColorStop(1, 'rgba(10,9,8,0.55)');
    g.fillStyle = grime;
    g.fillRect(0, 380, 256, 108);
    g.fillStyle = '#18191c';
    g.fillRect(0, 488, 256, 24);
    for (let x = -24; x < 256; x += 24) {
      g.fillStyle = '#a8862e';
      g.beginPath();
      g.moveTo(x, 512);
      g.lineTo(x + 12, 496);
      g.lineTo(x + 24, 496);
      g.lineTo(x + 12, 512);
      g.fill();
    }
  });
}

/** A worn yellow floor line along u (alpha where the paint is gone), 4 m per repeat. */
export function lineTexture(): THREE.CanvasTexture {
  const t = drawTexture(512, 32, (g) => {
    g.fillStyle = '#c9a23a';
    g.fillRect(0, 2, 512, 28);
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 90; i++) blot(g, noise(i * 3.7) * 512, noise(i * 1.9) * 32, 4 + noise(i) * 14, '0,0,0', 0.8, i * 7);
    g.globalCompositeOperation = 'source-over';
  });
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** An oil stain decal: dark, irregular, its edge soaked into the concrete. */
export function stainTexture(): THREE.CanvasTexture {
  // A decal: clamped, never repeating.
  return drawTexture(
    256,
    256,
    (g) => {
      blot(g, 128, 128, 120, '46,34,22', 0.28, 3);
      blot(g, 120, 134, 70, '12,10,9', 0.45, 11);
      // Splashes and drips round the main puddle, so it never reads as a disc.
      for (let i = 0; i < 9; i++) blot(g, 128 + (noise(i * 2.1) - 0.5) * 190, 128 + (noise(i * 4.3) - 0.5) * 190, 6 + noise(i) * 20, '12,10,9', 0.4, i * 29);
    },
    { repeat: false },
  );
}

/**
 * The turntable's diamond plate, `size` px across the 6 m disc (the cap's
 * UVs): lugs about 3.5 cm apart in alternating pairs, drawn as one tile and
 * laid as a pattern, then the wear of cars turning on it: polished rings where
 * the tires sit, rotational scratches, tire paths, oil drips under the engine
 * and grime toward the rim. Three maps that line up: color, a bump of the
 * raised lugs, and roughness (worn lugs and scratches shine, grime is matt).
 */
export function plateTextures(size: number): { color: THREE.CanvasTexture; bump: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const S = size;
  const p = Math.max(6, Math.round(S / 170));
  const len = p * 0.36;
  /** One 2x2 tile of lugs, each drawn by `lug` centered and turned. */
  const tile = (base: string, lug: (g: CanvasRenderingContext2D) => void) => {
    const [c, g] = canvas(2 * p, 2 * p);
    g.fillStyle = base;
    g.fillRect(0, 0, 2 * p, 2 * p);
    g.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const cx = (i % 2) * p + p / 2;
      const cy = Math.floor(i / 2) * p + p / 2;
      g.save();
      g.translate(cx, cy);
      g.rotate((i === 0 || i === 3 ? 1 : -1) * (Math.PI / 4));
      lug(g);
      g.restore();
    }
    return c;
  };
  const line = (g: CanvasRenderingContext2D, style: string, width: number, dy = 0) => {
    g.strokeStyle = style;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(-len, dy);
    g.lineTo(len, dy);
    g.stroke();
  };
  const fill = (g: CanvasRenderingContext2D, t: HTMLCanvasElement) => {
    g.fillStyle = g.createPattern(t, 'repeat')!;
    g.fillRect(0, 0, S, S);
  };
  const c = S / 2;
  const px = S / 6;
  // Where the wear goes, shared by the three maps.
  const rings = [1.25, 1.55].map((r) => r * px);
  const scratches = Array.from({ length: 700 }, (_, i) => [(0.2 + noise(i * 1.7) * 2.7) * px, noise(i * 2.9) * Math.PI * 2, 0.05 + noise(i * 4.1) * 0.35] as const);
  const paths = Array.from({ length: 6 }, (_, i) => noise(i * 3.3) * Math.PI);
  const wear = (g: CanvasRenderingContext2D, ring: string, scratch: string, path: string) => {
    g.lineCap = 'round';
    for (const r of rings) {
      g.strokeStyle = ring;
      g.lineWidth = 0.28 * px;
      g.beginPath();
      g.arc(c, c, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.strokeStyle = scratch;
    g.lineWidth = Math.max(1, S / 2048);
    for (const [r, a, l] of scratches) {
      g.beginPath();
      g.arc(c, c, r, a, a + l);
      g.stroke();
    }
    paths.forEach((a, i) => {
      g.strokeStyle = path;
      g.lineWidth = (0.2 + noise(i) * 0.1) * px;
      g.beginPath();
      g.moveTo(c - Math.cos(a) * c, c - Math.sin(a) * c);
      g.lineTo(c + Math.cos(a) * c, c + Math.sin(a) * c);
      g.stroke();
    });
  };
  const grime = (g: CanvasRenderingContext2D, rgb: string, alpha: number) => {
    const rim = g.createRadialGradient(c, c, c * 0.72, c, c, c);
    rim.addColorStop(0, `rgba(${rgb},0)`);
    rim.addColorStop(1, `rgba(${rgb},${alpha})`);
    g.fillStyle = rim;
    g.fillRect(0, 0, S, S);
  };
  const color = drawTexture(S, S, (g) => {
    fill(
      g,
      tile('#5d5e63', (t) => {
        line(t, 'rgba(0,0,0,0.5)', p * 0.24, p * 0.05);
        line(t, '#9a9ba2', p * 0.2);
        line(t, '#c9cbd2', p * 0.06, -p * 0.05);
      }),
    );
    wear(g, 'rgba(255,255,255,0.06)', 'rgba(220,222,230,0.1)', 'rgba(10,10,10,0.16)');
    for (let i = 0; i < 5; i++) blot(g, c + (noise(i * 7.7) - 0.5) * px * 1.2, c + (noise(i * 5.3) - 0.5) * px * 0.6, (0.08 + noise(i) * 0.12) * px, '18,14,10', 0.35, i * 19);
    grime(g, '12,11,10', 0.6);
  });
  const bump = drawTexture(
    S,
    S,
    (g) => {
      fill(
        g,
        tile('#000', (t) => {
          line(t, '#404040', p * 0.3);
          line(t, '#a0a0a0', p * 0.2);
          line(t, '#fff', p * 0.1);
        }),
      );
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.lineWidth = Math.max(1, S / 2048);
      for (const [r, a, l] of scratches) {
        g.beginPath();
        g.arc(c, c, r, a, a + l);
        g.stroke();
      }
    },
    { srgb: false },
  );
  const rough = drawTexture(
    S,
    S,
    (g) => {
      // Green channel is roughness.
      fill(
        g,
        tile('rgb(0,150,0)', (t) => line(t, 'rgb(0,95,0)', p * 0.2)),
      );
      wear(g, 'rgba(0,40,0,0.35)', 'rgba(0,40,0,0.5)', 'rgba(0,230,0,0.25)');
      for (let i = 0; i < 5; i++) blot(g, c + (noise(i * 7.7) - 0.5) * px * 1.2, c + (noise(i * 5.3) - 0.5) * px * 0.6, (0.08 + noise(i) * 0.12) * px, '0,30,0', 0.6, i * 19);
      grime(g, '0,235,0', 0.7);
    },
    { srgb: false },
  );
  return { color, bump, rough };
}

/**
 * The hazard ring round the turntable, one chevron per tile (48 round the
 * ring, about 600 px/m): yellow and black floor paint with brush streaks,
 * tire-dark wear down the middle where cars roll across, ragged edges and
 * chips back to the concrete. Inner edge at the top (v 0), outer at the bottom.
 */
export function hazardTexture(): THREE.CanvasTexture {
  return drawTexture(256, 128, (g) => {
    g.fillStyle = '#141316';
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#b08a2e';
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(128, 0);
    g.lineTo(256, 128);
    g.lineTo(128, 128);
    g.fill();
    g.beginPath();
    g.moveTo(-128, 0);
    g.lineTo(0, 0);
    g.lineTo(128, 128);
    g.lineTo(0, 128);
    g.fill();
    // Brush streaks along the ring.
    for (let i = 0; i < 420; i++) {
      g.fillStyle = noise(i * 1.3) > 0.5 ? 'rgba(255,240,200,0.06)' : 'rgba(0,0,0,0.08)';
      g.fillRect(noise(i * 2.1) * 256, noise(i * 3.7) * 128, 14 + noise(i * 5.1) * 40, 1);
    }
    // Tire wear: a dark band where the wheels cross, heaviest in the middle.
    const band = g.createLinearGradient(0, 0, 0, 128);
    band.addColorStop(0, 'rgba(10,10,10,0)');
    band.addColorStop(0.5, 'rgba(10,10,10,0.32)');
    band.addColorStop(1, 'rgba(10,10,10,0)');
    g.fillStyle = band;
    g.fillRect(0, 0, 256, 128);
    // Chips back to bare concrete, more along the edges.
    for (let i = 0; i < 70; i++) {
      const edge = i < 40;
      const x = noise(i * 5.5) * 256;
      const y = edge ? (noise(i * 2.2) > 0.5 ? noise(i * 8.1) * 10 : 128 - noise(i * 8.1) * 10) : noise(i * 2.2) * 128;
      const r = 1.5 + noise(i * 9.3) * (edge ? 6 : 4);
      g.fillStyle = 'rgba(78,76,72,0.92)';
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const rr = r * (0.5 + noise(i * 13 + k) * 0.7);
        g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.7);
      }
      g.fill();
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x - r * 0.4, y + r * 0.3, r * 0.8, 1);
    }
  });
}

/** Pegboard crowded with tools: spanners, screwdrivers, sockets, pliers, a hammer, a saw and an air line. */
export function pegboardTexture(): THREE.CanvasTexture {
  return drawTexture(768, 384, (g) => {
    g.fillStyle = '#3a3226';
    g.fillRect(0, 0, 768, 384);
    g.fillStyle = '#16120d';
    for (let y = 8; y < 384; y += 16) for (let x = 8; x < 768; x += 16) g.fillRect(x, y, 4, 4);
    // Outlines painted round each tool's place, the shadow-board way.
    const outline = (x: number, y: number, w: number, h: number) => {
      g.strokeStyle = 'rgba(230,220,200,0.35)';
      g.lineWidth = 2;
      g.strokeRect(x - 3, y - 3, w + 6, h + 6);
    };
    g.fillStyle = '#9ba0a8';
    for (let i = 0; i < 9; i++) {
      const x = 24 + i * 26;
      const len = 80 + i * 10;
      g.fillRect(x, 40, 8, len);
      g.beginPath();
      g.arc(x + 4, 40, 11, 0, Math.PI * 2);
      g.arc(x + 4, 40 + len, 9, 0, Math.PI * 2);
      g.fill();
    }
    // Screwdrivers: colored handles, steel shafts.
    const handles = ['#c23a2a', '#d9a826', '#2a6fc2', '#1d1d1d', '#c23a2a', '#3c9a46'];
    handles.forEach((c, i) => {
      const x = 280 + i * 22;
      g.fillStyle = c;
      g.fillRect(x, 40, 12, 46);
      g.fillStyle = '#b8bcc4';
      g.fillRect(x + 4, 86, 4, 60 + (i % 3) * 14);
    });
    // A socket rail.
    outline(270, 200, 150, 30);
    g.fillStyle = '#3c3f46';
    g.fillRect(270, 210, 150, 8);
    for (let i = 0; i < 9; i++) {
      g.fillStyle = '#b2b6be';
      g.fillRect(274 + i * 16, 196 + (i % 3), 12, 18 + i);
    }
    // Pliers, a hammer, a hacksaw.
    g.fillStyle = PALETTE.orange;
    g.fillRect(450, 60, 10, 90);
    g.fillRect(470, 60, 10, 90);
    g.fillStyle = '#9ba0a8';
    g.fillRect(452, 150, 26, 36);
    g.fillStyle = '#5a3a24';
    g.fillRect(520, 60, 14, 120);
    g.fillStyle = '#9ba0a8';
    g.fillRect(500, 46, 54, 24);
    outline(570, 260, 170, 50);
    g.strokeStyle = '#8a8e96';
    g.lineWidth = 6;
    g.strokeRect(580, 268, 120, 34);
    g.fillStyle = '#2a6fc2';
    g.fillRect(700, 266, 34, 38);
    // A coiled air line and a missing tool's empty outline.
    g.strokeStyle = '#d9b44a';
    g.lineWidth = 6;
    for (let r = 20; r < 52; r += 8) {
      g.beginPath();
      g.arc(640, 120, r, 0, Math.PI * 2);
      g.stroke();
    }
    outline(40, 240, 160, 40);
    // Grime: hand marks round the busiest spots, dust along the top.
    for (let i = 0; i < 16; i++) blot(g, noise(i * 6.1) * 768, 100 + noise(i * 3.3) * 280, 20 + noise(i) * 30, '0,0,0', 0.18, i * 19);
  });
}

/** A tool chest's drawer fronts in a body color: seams, chrome pulls, scratches and a sticker or two. */
export function drawerTexture(body: string): THREE.CanvasTexture {
  return drawTexture(256, 192, (g) => {
    g.fillStyle = body;
    g.fillRect(0, 0, 256, 192);
    const rows = [0, 20, 40, 60, 84, 112, 148, 192];
    for (let i = 0; i < rows.length - 1; i++) {
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(0, rows[i + 1] - 2, 256, 2);
      g.fillStyle = '#d9dde5';
      g.fillRect(24, rows[i] + 5, 208, 3);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(24, rows[i] + 8, 208, 1);
    }
    for (let i = 0; i < 30; i++) {
      g.strokeStyle = 'rgba(255,255,255,0.12)';
      g.lineWidth = 1;
      const x = noise(i * 3.9) * 256;
      const y = noise(i * 7.1) * 192;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 6 + noise(i) * 20, y + (noise(i * 2.3) - 0.5) * 6);
      g.stroke();
    }
    g.fillStyle = PALETTE.yellow;
    g.fillRect(180, 120, 46, 20);
    g.fillStyle = '#111';
    g.fillRect(186, 126, 34, 8);
    g.fillStyle = PALETTE.cyan;
    g.beginPath();
    g.arc(60, 160, 12, 0, Math.PI * 2);
    g.fill();
  });
}

/** A poster for one of the game's fictional tuners, aged: faded, creased, taped at the corners, one corner torn. */
export function posterTexture(name: string, line: string, accent: string, variant: number): THREE.CanvasTexture {
  return drawTexture(256, 360, (g) => {
    g.fillStyle = '#1b1a1f';
    g.fillRect(0, 0, 256, 360);
    g.fillStyle = accent;
    if (variant === 0) {
      g.beginPath();
      g.moveTo(30, 150);
      g.lineTo(226, 120);
      g.lineTo(226, 140);
      g.lineTo(30, 172);
      g.fill();
      g.fillRect(80, 160, 10, 60);
      g.fillRect(170, 146, 10, 60);
    } else if (variant === 1) {
      for (let i = 0; i < 9; i++) g.fillRect(20 + i * 6, 70 + i * 18, 216 - i * 18, 7);
    } else {
      g.lineWidth = 14;
      g.strokeStyle = accent;
      g.beginPath();
      g.arc(128, 150, 80, 0, Math.PI * 2);
      g.stroke();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        g.beginPath();
        g.moveTo(128, 150);
        g.lineTo(128 + Math.cos(a) * 76, 150 + Math.sin(a) * 76);
        g.stroke();
      }
    }
    g.fillStyle = '#f2efe8';
    g.font = 'italic 900 40px "Google Sans Flex", system-ui, sans-serif';
    g.fillText(name, 20, 290);
    g.fillStyle = accent;
    g.font = '700 17px "Google Sans Flex", system-ui, sans-serif';
    g.fillText(line, 22, 318);
    g.fillRect(22, 330, 60, 4);
    // Age: a yellow cast, fold creases, scuffs.
    g.fillStyle = 'rgba(150,120,60,0.16)';
    g.fillRect(0, 0, 256, 360);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(0, 179, 256, 2);
    g.fillRect(127, 0, 2, 360);
    for (let i = 0; i < 8; i++) blot(g, noise(i * 4.9 + variant) * 256, noise(i * 8.3 + variant) * 360, 14 + noise(i) * 24, '20,16,10', 0.22, i * 7 + variant);
    // Tape at three corners; the fourth is torn off.
    g.fillStyle = 'rgba(220,210,170,0.75)';
    g.fillRect(-6, 6, 40, 14);
    g.fillRect(222, 6, 40, 14);
    g.fillRect(-6, 336, 40, 14);
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.moveTo(256, 300);
    g.lineTo(256, 360);
    g.lineTo(196, 360);
    g.lineTo(220, 344);
    g.lineTo(232, 326);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  });
}

/** Marker on a whiteboard, the shop's hand. */
const HAND = '"Marker Felt", "Segoe Print", "Comic Sans MS", cursive';

/** The jobs board: tonight's work by bay in marker, ticks and a crossed-out line, a parts reminder in red, a sketch, old ghosting. */
export function whiteboardTexture(): THREE.CanvasTexture {
  return drawTexture(512, 288, (g) => {
    g.fillStyle = '#e4e6e3';
    g.fillRect(0, 0, 512, 288);
    // Ghosts of wiped jobs and a grimy edge.
    g.fillStyle = 'rgba(70,80,110,0.09)';
    for (let i = 0; i < 9; i++) g.fillRect(30 + noise(i * 3.1) * 300, 40 + noise(i * 5.7) * 200, 60 + noise(i) * 120, 10);
    g.strokeStyle = '#8d9096';
    g.lineWidth = 12;
    g.strokeRect(0, 0, 512, 288);
    g.fillStyle = '#1c2a6b';
    g.font = `700 30px ${HAND}`;
    g.fillText('TONIGHT', 24, 44);
    g.fillRect(24, 52, 132, 3);
    g.font = `22px ${HAND}`;
    const jobs: [string, string, boolean][] = [
      ['BAY 1', 'cat-back + tune', true],
      ['BAY 2', 'pads, rotors, hubs', false],
      ['BAY 3', 'oil + diff fluid', true],
      ['BAY 4', 'coilovers -> align', false],
      ['FLOOR', 'motor out, reseal', false],
    ];
    jobs.forEach(([bay, job, done], i) => {
      const y = 90 + i * 36;
      g.fillStyle = '#1c2a6b';
      g.fillText(bay, 24, y);
      g.fillStyle = '#20232a';
      g.fillText(job, 110, y);
      if (done) {
        g.strokeStyle = '#2a8c3e';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(300, y - 8);
        g.lineTo(308, y);
        g.lineTo(324, y - 18);
        g.stroke();
      }
    });
    g.strokeStyle = '#20232a';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(108, 154);
    g.lineTo(270, 148);
    g.stroke();
    g.fillStyle = '#b3242c';
    g.font = `700 24px ${HAND}`;
    g.fillText('PARTS DUE FRI!', 330, 236);
    g.fillText('KIBA x4', 360, 266);
    // A quick sketch of a wing and its uprights.
    g.strokeStyle = '#1c2a6b';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(350, 120);
    g.quadraticCurveTo(420, 96, 490, 112);
    g.lineTo(486, 128);
    g.quadraticCurveTo(420, 114, 352, 136);
    g.closePath();
    g.moveTo(390, 126);
    g.lineTo(386, 180);
    g.moveTo(452, 116);
    g.lineTo(456, 176);
    g.stroke();
    g.font = `18px ${HAND}`;
    g.fillStyle = '#1c2a6b';
    g.fillText('1650 wide?', 380, 82);
  });
}

/** A work order on a clipboard: the printed header and boxes, the job written in, a greasy thumbprint. */
export function workOrderTexture(): THREE.CanvasTexture {
  return drawTexture(128, 176, (g) => {
    g.fillStyle = '#ebe7dc';
    g.fillRect(0, 0, 128, 176);
    g.fillStyle = '#26282d';
    g.font = '700 13px "Google Sans Flex", system-ui, sans-serif';
    g.fillText('WORK ORDER', 10, 20);
    g.fillStyle = PALETTE.orange;
    g.fillRect(10, 26, 108, 3);
    g.strokeStyle = 'rgba(40,40,46,0.45)';
    g.lineWidth = 1;
    for (let y = 44; y < 160; y += 14) {
      g.beginPath();
      g.moveTo(10, y);
      g.lineTo(118, y);
      g.stroke();
    }
    g.fillStyle = '#1c2a6b';
    g.font = `12px ${HAND}`;
    ['front pads', 'rotors x2', 'bleed - DOT4', 'torque 108'].forEach((t, i) => g.fillText(t, 12, 41 + i * 14 * 2));
    blot(g, 96, 140, 10, '40,30,20', 0.35, 3);
  });
}

/** A tuner's parts box: cardboard printed with the brand and its line, the this-way-up arrows and a shipping label. */
export function partsBoxTexture(name: string, line: string, accent: string): THREE.CanvasTexture {
  return drawTexture(256, 256, (g) => {
    g.fillStyle = '#86663f';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 6; i++) blot(g, noise(i * 6.1 + name.length) * 256, noise(i * 2.7) * 256, 20 + noise(i) * 30, '60,40,20', 0.18, i);
    g.fillStyle = '#16151a';
    g.fillRect(0, 96, 256, 64);
    g.fillStyle = accent;
    g.fillRect(0, 156, 256, 4);
    g.fillStyle = '#f2efe8';
    fitFont(g, name, 230, 44, (px) => `italic 900 ${px}px "Google Sans Flex", system-ui, sans-serif`);
    g.fillText(name, 14, 142);
    g.fillStyle = '#16151a';
    g.font = '700 16px "Google Sans Flex", system-ui, sans-serif';
    g.fillText(line, 14, 186);
    g.fillStyle = '#ebe7dc';
    g.fillRect(150, 200, 92, 44);
    g.fillStyle = '#26282d';
    for (let i = 0; i < 4; i++) g.fillRect(156, 208 + i * 9, 40 + noise(i + name.length) * 40, 3);
    g.strokeStyle = '#16151a';
    g.lineWidth = 4;
    for (const x of [24, 60]) {
      g.beginPath();
      g.moveTo(x, 70);
      g.lineTo(x, 24);
      g.moveTo(x - 10, 36);
      g.lineTo(x, 24);
      g.lineTo(x + 10, 36);
      g.stroke();
    }
  });
}

/**
 * The flagship cabs' nameplates, one row each in an atlas: a black plate with
 * the series name lit in its accent. The material pushes it past the bloom.
 */
export function badgeTexture(badges: readonly { name: string; line: string; color: string }[]): THREE.CanvasTexture {
  return drawTexture(
    512,
    96 * badges.length,
    (g) => {
      badges.forEach(({ name, line, color }, i) => {
        const y = i * 96;
        g.fillStyle = '#0b0b0e';
        g.fillRect(0, y, 512, 96);
        g.strokeStyle = '#9aa0aa';
        g.lineWidth = 4;
        g.strokeRect(4, y + 4, 504, 88);
        g.fillStyle = color;
        g.textAlign = 'center';
        fitFont(g, name, 440, 54, (px) => `italic 900 ${px}px "Google Sans Flex", system-ui, sans-serif`);
        g.fillText(name, 256, y + 58);
        g.font = '700 18px "Google Sans Flex", system-ui, sans-serif';
        g.fillText(line, 256, y + 82);
      });
    },
    { repeat: false },
  );
}

/** The beer sign's face: two lines of light on black, drawn white so the material's color tints and pushes it past the bloom. */
export function beerSignTexture(): THREE.CanvasTexture {
  return drawTexture(
    256,
    128,
    (g) => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, 256, 128);
      g.strokeStyle = '#fff';
      g.lineWidth = 4;
      g.strokeRect(8, 8, 240, 112);
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      fitFont(g, 'COLD BEER', 220, 48, (px) => `italic 800 ${px}px ${HAND}`);
      g.fillText('COLD BEER', 128, 62);
      g.font = `600 22px "Google Sans Flex", system-ui, sans-serif`;
      g.fillText('AFTER HOURS', 128, 100);
    },
    { repeat: false },
  );
}

/** Light washing down a wall from a strip over it: white at the top edge fading to nothing, soft at the sides. */
export function washTexture(): THREE.CanvasTexture {
  return drawTexture(
    64,
    128,
    (g) => {
      const v = g.createLinearGradient(0, 0, 0, 128);
      v.addColorStop(0, 'rgba(255,255,255,1)');
      v.addColorStop(0.25, 'rgba(255,255,255,0.45)');
      v.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = v;
      g.fillRect(0, 0, 64, 128);
      g.globalCompositeOperation = 'destination-in';
      const h = g.createLinearGradient(0, 0, 64, 0);
      h.addColorStop(0, 'rgba(0,0,0,0)');
      h.addColorStop(0.15, 'rgba(0,0,0,1)');
      h.addColorStop(0.85, 'rgba(0,0,0,1)');
      h.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = h;
      g.fillRect(0, 0, 64, 128);
    },
    { repeat: false },
  );
}

/** An exit sign's face: the word and an arrow, lit green on dark glass. */
export function exitTexture(): THREE.CanvasTexture {
  return drawTexture(
    256,
    96,
    (g) => {
      g.fillStyle = '#071209';
      g.fillRect(0, 0, 256, 96);
      g.fillStyle = '#3cff7a';
      g.textAlign = 'center';
      g.font = '800 58px "Google Sans Flex", system-ui, sans-serif';
      g.fillText('EXIT', 112, 70);
      g.beginPath();
      g.moveTo(206, 30);
      g.lineTo(236, 48);
      g.lineTo(206, 66);
      g.lineTo(206, 56);
      g.lineTo(190, 56);
      g.lineTo(190, 40);
      g.lineTo(206, 40);
      g.fill();
    },
    { repeat: false },
  );
}

/** The bay numbers 1 to 4 in a row of cells, painted big in worn yellow on the floor. */
export function bayNumbersTexture(): THREE.CanvasTexture {
  return drawTexture(
    512,
    128,
    (g) => {
      g.textAlign = 'center';
      g.font = '900 118px "Google Sans Flex", system-ui, sans-serif';
      for (let i = 0; i < 4; i++) {
        g.fillStyle = '#c9a227';
        g.fillText(String(i + 1), i * 128 + 64, 112);
      }
      // Worn through where the tires run over it.
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 500; i++) {
        g.fillStyle = `rgba(0,0,0,${0.3 + noise(i * 1.7) * 0.6})`;
        g.fillRect(noise(i * 2.3) * 512, noise(i * 3.1) * 128, 2 + noise(i) * 8, 1 + noise(i * 5.9) * 4);
      }
      g.globalCompositeOperation = 'source-over';
    },
    { repeat: false },
  );
}

/** The tuners' cloth banners, one per 512 x 192 row: brand, line, a stripe in its color, the weave and the grommets. */
export function bannerTexture(banners: readonly { name: string; line: string; color: string }[]): THREE.CanvasTexture {
  return drawTexture(
    512,
    192 * banners.length,
    (g) => {
      banners.forEach(({ name, line, color }, i) => {
        const y = i * 192;
        g.fillStyle = '#121115';
        g.fillRect(0, y, 512, 192);
        g.fillStyle = color;
        g.fillRect(0, y + 132, 512, 10);
        g.beginPath();
        g.moveTo(0, y + 18);
        g.lineTo(120, y + 18);
        g.lineTo(90, y + 30);
        g.lineTo(0, y + 30);
        g.fill();
        g.fillStyle = '#f2efe8';
        fitFont(g, name, 470, 92, (px) => `italic 900 ${px}px "Google Sans Flex", system-ui, sans-serif`);
        g.fillText(name, 22, y + 118);
        g.fillStyle = color;
        g.font = '700 26px "Google Sans Flex", system-ui, sans-serif';
        g.fillText(line, 24, y + 176);
        g.fillStyle = 'rgba(255,255,255,0.035)';
        for (let x = 0; x < 512; x += 3) g.fillRect(x, y, 1, 192);
        for (let k = 0; k < 192; k += 3) g.fillRect(0, y + k, 512, 1);
        g.fillStyle = '#9aa0aa';
        for (const gx of [12, 500]) {
          g.beginPath();
          g.arc(gx, y + 10, 5, 0, Math.PI * 2);
          g.fill();
        }
      });
    },
    { repeat: false },
  );
}

/** Old number plates nailed up in a row: six fictional plates, faded, one rusted. */
export function platesTexture(): THREE.CanvasTexture {
  const plates: [string, string, string, string][] = [
    ['NGHT RN', 'NIGHT CITY', '#e9e4d6', '#1c2a6b'],
    ['SCN 01', 'HARBOR DIST.', '#f2c230', '#16151a'],
    ['DRFT 4U', 'MIDTOWN', '#dfe6ee', '#b3242c'],
    ['BOOST', 'RIVERSIDE', '#16151a', '#e9e4d6'],
    ['2JZ', 'OLD TOWN', '#e9e4d6', '#0e7a5a'],
    ['LATE NT', 'NIGHT CITY', '#c9ced8', '#16151a'],
  ];
  return drawTexture(
    768,
    128,
    (g) => {
      plates.forEach(([text, line, bg, ink], i) => {
        const x = i * 128;
        g.fillStyle = bg;
        g.fillRect(x + 4, 24, 120, 64);
        g.strokeStyle = ink;
        g.lineWidth = 3;
        g.strokeRect(x + 8, 28, 112, 56);
        g.fillStyle = ink;
        g.textAlign = 'center';
        fitFont(g, text, 100, 30, (px) => `800 ${px}px "Google Sans Flex", system-ui, sans-serif`);
        g.fillText(text, x + 64, 70);
        g.font = '700 9px "Google Sans Flex", system-ui, sans-serif';
        g.fillText(line, x + 64, 40);
        for (let k = 0; k < 4; k++) blot(g, x + 10 + noise(i * 9 + k) * 108, 30 + noise(i * 5 + k) * 52, 6 + noise(k) * 8, i === 3 ? '120,60,20' : '60,50,40', i === 3 ? 0.4 : 0.15, i * 11 + k);
      });
    },
    { repeat: false },
  );
}

/** The shop clock's face: numerals, ticks and the hands stopped at a quarter to three, the night long. */
export function clockTexture(): THREE.CanvasTexture {
  return drawTexture(
    256,
    256,
    (g) => {
      g.fillStyle = '#e9e7e0';
      g.beginPath();
      g.arc(128, 128, 124, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#16151a';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = '700 26px "Google Sans Flex", system-ui, sans-serif';
      for (let i = 1; i <= 12; i++) {
        const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
        g.fillText(String(i), 128 + Math.cos(a) * 96, 128 + Math.sin(a) * 96);
      }
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * Math.PI * 2;
        const l = i % 5 ? 6 : 12;
        g.fillRect(128 + Math.cos(a) * (118 - l) - 1, 128 + Math.sin(a) * (118 - l) - 1, 2 + Math.cos(a) * 0, 2);
      }
      const hand = (a: number, len: number, w: number, c: string) => {
        g.strokeStyle = c;
        g.lineWidth = w;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(128, 128);
        g.lineTo(128 + Math.cos(a - Math.PI / 2) * len, 128 + Math.sin(a - Math.PI / 2) * len);
        g.stroke();
      };
      hand(((2 + 45 / 60) / 12) * Math.PI * 2, 60, 8, '#16151a');
      hand((45 / 60) * Math.PI * 2, 92, 5, '#16151a');
      hand((20 / 60) * Math.PI * 2, 98, 2, '#b3242c');
    },
    { repeat: false },
  );
}

/** A parts supplier's wall calendar: a car photo up top (a silhouette under a sunset), the month's grid below. */
export function calendarTexture(): THREE.CanvasTexture {
  return drawTexture(256, 360, (g) => {
    g.fillStyle = '#ebe7dc';
    g.fillRect(0, 0, 256, 360);
    const sky = g.createLinearGradient(0, 0, 0, 160);
    sky.addColorStop(0, '#2a1640');
    sky.addColorStop(1, '#ff7a3c');
    g.fillStyle = sky;
    g.fillRect(10, 10, 236, 150);
    g.fillStyle = '#0d0d10';
    g.beginPath();
    g.moveTo(30, 140);
    g.lineTo(60, 112);
    g.lineTo(120, 100);
    g.lineTo(170, 104);
    g.lineTo(220, 122);
    g.lineTo(228, 140);
    g.fill();
    for (const wx of [72, 190]) {
      g.beginPath();
      g.arc(wx, 140, 14, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#26282d';
    g.font = '800 26px "Google Sans Flex", system-ui, sans-serif';
    g.fillText('OCTOBER', 14, 192);
    g.fillStyle = PALETTE.orange;
    g.font = '700 12px "Google Sans Flex", system-ui, sans-serif';
    g.fillText('KUROGANE AERO WORKS', 140, 192);
    g.strokeStyle = 'rgba(40,40,46,0.5)';
    g.lineWidth = 1;
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 7; c++) {
        g.strokeRect(12 + c * 33, 204 + r * 30, 33, 30);
        const day = r * 7 + c - 2;
        if (day > 0 && day <= 31) {
          g.fillStyle = '#26282d';
          g.font = '10px "Google Sans Flex", system-ui, sans-serif';
          g.fillText(String(day), 15 + c * 33, 215 + r * 30);
        }
      }
    // Today circled in marker, a meet on the weekend.
    g.strokeStyle = '#b3242c';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(12 + 4 * 33 + 16, 204 + 3 * 30 + 15, 14, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#1c2a6b';
    g.font = `12px ${HAND}`;
    g.fillText('meet!', 12 + 6 * 33 + 2, 204 + 3 * 30 + 26);
  });
}

/**
 * The dyno screen on the wall: a run drawn as it happens on a small canvas,
 * power and torque climbing with the revs, the peak held for a few seconds,
 * then the next pull. `draw(t)` repaints for time t (s); the showroom calls it
 * a few times a second, so the upload is a 256 x 144 texture now and then.
 */
export function dynoScreen(): { texture: THREE.CanvasTexture; draw: (t: number) => void } {
  const [c, g] = canvas(256, 144);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const power = (x: number) => Math.min(1, x * 1.25) * (1 - 0.25 * Math.max(0, x - 0.8) / 0.2) * (0.9 + 0.1 * x);
  const torque = (x: number) => 0.55 + 0.35 * Math.sin(Math.min(1, x) * Math.PI * 0.8) - 0.12 * x;
  const draw = (t: number) => {
    const run = t % 9;
    const p = Math.min(1, run / 6);
    g.fillStyle = '#05080c';
    g.fillRect(0, 0, 256, 144);
    g.strokeStyle = 'rgba(120,220,232,0.15)';
    g.lineWidth = 1;
    for (let x = 24; x < 250; x += 28) {
      g.beginPath();
      g.moveTo(x, 22);
      g.lineTo(x, 128);
      g.stroke();
    }
    for (let y = 22; y <= 128; y += 21) {
      g.beginPath();
      g.moveTo(24, y);
      g.lineTo(248, y);
      g.stroke();
    }
    const curve = (f: (x: number) => number, color: string) => {
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath();
      for (let i = 0; i <= 60 * p; i++) {
        const x = i / 60;
        const px = 24 + x * 224;
        const py = 128 - f(x) * 100;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
    };
    curve(power, PALETTE.orange);
    curve(torque, PALETTE.cyan);
    g.fillStyle = '#e9e7e0';
    g.font = '700 11px "Google Sans Flex", system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText('DYNO CELL  ·  PULL 3', 6, 14);
    g.textAlign = 'right';
    g.fillStyle = PALETTE.orange;
    g.font = '800 14px "Google Sans Flex", system-ui, sans-serif';
    g.fillText(`${Math.round(power(p) * 412)} WHP`, 250, 14);
    g.fillStyle = PALETTE.cyan;
    g.font = '700 10px "Google Sans Flex", system-ui, sans-serif';
    g.fillText(`${Math.round(1500 + p * 6000)} RPM`, 250, 140);
    texture.needsUpdate = true;
  };
  draw(0);
  return { texture, draw };
}

/** A soft round glow (white, alpha falling off), for light spilling on the wall round a sign or a lamp. */
export function glowTexture(): THREE.CanvasTexture {
  return drawTexture(
    128,
    128,
    (g) => {
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.35, 'rgba(255,255,255,0.4)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    },
    { repeat: false },
  );
}

/** The contact shadow: a soft rounded rectangle, darkest under the car's middle. */
export function shadowTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 256;
  return drawTexture(
    w,
    h,
    (g) => {
      const img = g.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const px = Math.abs((x + 0.5) / w - 0.5) * 2;
          const py = Math.abs((y + 0.5) / h - 0.5) * 2;
          const qx = Math.max(px - 0.6, 0);
          const qy = Math.max(py - 0.72, 0);
          const d = Math.hypot(qx / 0.4, qy / 0.28);
          const a = Math.max(0, 1 - d) ** 1.8 * (0.75 + 0.25 * (1 - py));
          const i = (y * w + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
          img.data[i + 3] = Math.round(a * 255);
        }
      }
      g.putImageData(img, 0, 0);
    },
    { srgb: false, repeat: false },
  );
}
