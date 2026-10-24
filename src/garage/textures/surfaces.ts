/**
 * The room's surfaces as canvas textures (garage/showroom.ts): stained
 * concrete (color, roughness and bump), grimy block walls, the roof deck, the
 * roller door, worn paint lines, oil stains, diamond plate and the hazard
 * stripes. Each is drawn once per visit (a few milliseconds) from a fixed hash.
 * Render only.
 */
import * as THREE from 'three';
import { canvas, drawTexture } from '../../render/textures/canvasKit';
import { blot, crack, noise } from './brushes';

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
