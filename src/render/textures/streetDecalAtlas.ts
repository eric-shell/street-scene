/**
 * The road decal atlas (streetDecals.ts): iron covers, grates, tar and oil, cracks, rubber, paint stencils
 * and a soft puddle blob, with a half size roughness atlas in the same layout. Procedural and seeded, drawn
 * once per seed and cached by the polish builder.
 */
import type * as THREE from 'three';
import { Rng } from '../../sim/prng';
import { canvas, canvasTex, drawInCell, type AtlasCell } from './canvasKit';

export const DECAL_ATLAS_SIZE = 1024;

/**
 * Road decal atlas cells (px). Sizes in metres are decided by the placer;
 * the cells only fix the aspect. The roughness atlas shares this layout.
 */
export const DECAL_CELLS = {
  manholeA: { x: 0, y: 0, w: 128, h: 128 },
  manholeB: { x: 128, y: 0, w: 128, h: 128 },
  drain: { x: 256, y: 0, w: 128, h: 128 },
  tarA: { x: 384, y: 0, w: 256, h: 128 },
  tarB: { x: 640, y: 0, w: 256, h: 128 },
  oil: { x: 896, y: 0, w: 128, h: 128 },
  cracksA: { x: 0, y: 128, w: 256, h: 256 },
  cracksB: { x: 256, y: 128, w: 256, h: 256 },
  skid: { x: 512, y: 128, w: 128, h: 256 },
  rubber: { x: 640, y: 128, w: 128, h: 256 },
  wear: { x: 768, y: 128, w: 128, h: 256 },
  arrowStraight: { x: 896, y: 128, w: 128, h: 256 },
  arrowLeft: { x: 0, y: 384, w: 128, h: 256 },
  arrowRight: { x: 128, y: 384, w: 128, h: 256 },
  arrowStraightLeft: { x: 256, y: 384, w: 128, h: 256 },
  arrowStraightRight: { x: 384, y: 384, w: 128, h: 256 },
  bike: { x: 512, y: 384, w: 128, h: 128 },
  paint: { x: 640, y: 384, w: 128, h: 128 },
  rust: { x: 768, y: 384, w: 128, h: 128 },
  puddle: { x: 896, y: 384, w: 128, h: 128 },
  patch: { x: 512, y: 512, w: 256, h: 128 },
  gutter: { x: 768, y: 512, w: 256, h: 128 },
  noParking: { x: 0, y: 640, w: 384, h: 128 },
  loading: { x: 384, y: 640, w: 384, h: 128 },
  busStop: { x: 768, y: 640, w: 256, h: 128 },
  towAway: { x: 0, y: 768, w: 384, h: 128 },
  keepClear: { x: 384, y: 768, w: 384, h: 128 },
  fireLane: { x: 768, y: 768, w: 256, h: 128 },
  // The bottom 128 px row is spare.
} as const satisfies Record<string, AtlasCell>;
export type DecalKind = keyof typeof DECAL_CELLS;

/**
 * Colour atlas (RGBA) and a half size roughness atlas for every road decal:
 * iron covers, grates, tar and oil (glossy), cracks, rubber, paint stencils
 * and a soft puddle blob. White cells (paint, arrows, stencils, puddle) are
 * tinted per decal with vertex colours.
 */
export function makeStreetDecalAtlas(seed: number): { map: THREE.Texture; roughness: THREE.Texture } {
  const rng = new Rng(seed ^ 0xdeca1);
  const S = DECAL_ATLAS_SIZE;
  const [c, ctx] = canvas(S, S);
  const R = S / 2;
  const [rc, rctx] = canvas(R, R);
  ctx.clearRect(0, 0, S, S);
  // Roughness default: matte (unused cells are never sampled anyway).
  rctx.fillStyle = '#e6e6e6';
  rctx.fillRect(0, 0, R, R);
  const rough = (cell: AtlasCell, v: number) => {
    const g = Math.round(v * 255);
    rctx.fillStyle = `rgb(${g},${g},${g})`;
    rctx.fillRect(cell.x / 2, cell.y / 2, cell.w / 2, cell.h / 2);
  };
  /** Clip drawing to a cell and translate to its origin. */
  const inCell = (cell: AtlasCell, draw: (w: number, h: number) => void) => drawInCell(ctx, cell, draw);
  /** Speckle noise over a cell (dirt, wear). */
  const speckle = (cell: AtlasCell, n: number, alpha: number, color = '0,0,0') => {
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = `rgba(${color},${rng.range(alpha * 0.3, alpha).toFixed(2)})`;
      ctx.fillRect(cell.x + rng.range(0, cell.w), cell.y + rng.range(0, cell.h), rng.range(1, 3), rng.range(1, 3));
    }
  };
  const blob = (w: number, h: number, cx: number, cy: number, r: number, wobble: number) => {
    ctx.beginPath();
    const n = 24;
    const p1 = rng.range(0, 1);
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (1 + wobble * Math.sin(a * 3 + p1) * 0.5 + wobble * Math.sin(a * 7 + 1.3) * 0.3);
      const x = cx + Math.cos(a) * rr * (w / h >= 1 ? w / h : 1);
      const y = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };

  // Manhole covers: cast iron disc with a raised rim and a pattern.
  for (const [cell, pattern] of [
    [DECAL_CELLS.manholeA, 'rings'],
    [DECAL_CELLS.manholeB, 'grid'],
  ] as const) {
    inCell(cell, (w, h) => {
      const cx = w / 2;
      const cy = h / 2;
      const r = w * 0.46;
      ctx.fillStyle = '#4a4c53';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#787b85';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#1a1b1e';
      ctx.lineWidth = 2;
      if (pattern === 'rings') {
        for (let k = 1; k <= 4; k++) {
          ctx.beginPath();
          ctx.arc(cx, cy, (r - 10) * (k / 4.6), 0, Math.PI * 2);
          ctx.stroke();
        }
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8);
          ctx.lineTo(cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10));
          ctx.stroke();
        }
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r - 8, 0, Math.PI * 2);
        ctx.clip();
        for (let x = -w; x < w * 2; x += 9) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + h, h);
          ctx.moveTo(x, h);
          ctx.lineTo(x + h, 0);
          ctx.stroke();
        }
        ctx.restore();
      }
      // A dull highlight across the top edge, as if lit by the streetlights.
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(255,255,255,0.14)');
      g.addColorStop(0.5, 'rgba(255,255,255,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.25)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });
    rough(cell, 0.5);
  }
  // Storm drain: a slotted grate in a frame.
  inCell(DECAL_CELLS.drain, (w, h) => {
    ctx.fillStyle = '#2e3037';
    ctx.fillRect(4, 22, w - 8, h - 44);
    ctx.fillStyle = '#5e616b';
    ctx.fillRect(4, 22, w - 8, 5);
    ctx.fillRect(4, h - 27, w - 8, 5);
    ctx.fillStyle = '#0a0a0c';
    for (let x = 12; x < w - 12; x += 12) ctx.fillRect(x, 30, 6, h - 60);
  });
  rough(DECAL_CELLS.drain, 0.6);
  // Tar patches: near black, glossy, ragged edges, a few seams.
  for (const cell of [DECAL_CELLS.tarA, DECAL_CELLS.tarB]) {
    inCell(cell, (w, h) => {
      ctx.fillStyle = 'rgba(16,16,20,0.92)';
      blob(w, h, w / 2, h / 2, h * 0.42, 0.5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,40,46,0.6)';
      ctx.lineWidth = 2;
      for (let k = 0; k < 4; k++) {
        ctx.beginPath();
        ctx.moveTo(rng.range(0, w), rng.range(0, h));
        ctx.lineTo(rng.range(0, w), rng.range(0, h));
        ctx.stroke();
      }
    });
    speckle(cell, 160, 0.4, '70,70,80');
    rough(cell, 0.28);
  }
  // Oil stain: soft dark blob with a faint sheen ring.
  inCell(DECAL_CELLS.oil, (w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w * 0.48);
    g.addColorStop(0, 'rgba(8,8,12,0.85)');
    g.addColorStop(0.6, 'rgba(14,12,18,0.55)');
    g.addColorStop(0.82, 'rgba(60,40,70,0.25)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    blob(w, h, w / 2, h / 2, w * 0.46, 0.35);
    ctx.fill();
  });
  rough(DECAL_CELLS.oil, 0.12);
  // Cracks: a few random walks with branches, alpha only on the lines.
  for (const cell of [DECAL_CELLS.cracksA, DECAL_CELLS.cracksB]) {
    inCell(cell, (w, h) => {
      ctx.strokeStyle = 'rgba(6,6,8,0.75)';
      ctx.lineCap = 'round';
      const walk = (x: number, y: number, a: number, len: number, width: number, depth: number) => {
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let i = 0; i < len; i++) {
          a += rng.range(-0.6, 0.6);
          x += Math.cos(a) * 6;
          y += Math.sin(a) * 6;
          ctx.lineTo(x, y);
          if (depth < 2 && rng.chance(0.08)) walk(x, y, a + rng.pick([-1.2, 1.2]), Math.floor(len * 0.4), width * 0.6, depth + 1);
        }
        ctx.stroke();
      };
      walk(rng.range(10, w - 10), 4, Math.PI / 2 + rng.range(-0.5, 0.5), 38, 3, 0);
      walk(4, rng.range(10, h - 10), rng.range(-0.5, 0.5), 30, 2.2, 0);
    });
    rough(cell, 0.85);
  }
  // Skid: two soft rubber streaks a track width apart; rubber: one wide smear (corner rubbering).
  inCell(DECAL_CELLS.skid, (w, h) => {
    for (const x of [w * 0.28, w * 0.72]) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.2, 'rgba(0,0,0,0.88)');
      g.addColorStop(0.8, 'rgba(0,0,0,0.88)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      for (let y = 0; y < h; y += 3) ctx.fillRect(x - 9 + rng.range(-1.5, 1.5), y, 18 + rng.range(-3, 3), 3);
    }
  });
  speckle(DECAL_CELLS.skid, 200, 0.35, '20,20,24');
  rough(DECAL_CELLS.skid, 0.45);
  inCell(DECAL_CELLS.rubber, (w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w * 0.5);
    g.addColorStop(0, 'rgba(0,0,0,0.62)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.save();
    ctx.scale(1, h / w);
    ctx.fillRect(0, 0, w, w);
    ctx.restore();
  });
  speckle(DECAL_CELLS.rubber, 120, 0.3, '10,10,12');
  rough(DECAL_CELLS.rubber, 0.5);
  // Wear band: a soft vertical band (tinted asphalt by the placer) that dulls paint under wheel tracks.
  inCell(DECAL_CELLS.wear, (w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.8)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.8)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    for (let y = 0; y < h; y += 2) {
      ctx.globalAlpha = rng.range(0.5, 1);
      ctx.fillRect(0, y, w, 2);
    }
    ctx.globalAlpha = 1;
  });
  rough(DECAL_CELLS.wear, 0.9);
  // Lane arrows: white, slightly worn.
  const arrow = (cell: AtlasCell, kinds: ('s' | 'l' | 'r')[]) => {
    inCell(cell, (w, h) => {
      ctx.fillStyle = 'rgba(235,236,240,0.95)';
      const shaft = w * 0.18;
      ctx.fillRect(w / 2 - shaft / 2, h * 0.3, shaft, h * 0.62);
      if (kinds.includes('s')) {
        ctx.beginPath();
        ctx.moveTo(w / 2, h * 0.06);
        ctx.lineTo(w / 2 + w * 0.3, h * 0.36);
        ctx.lineTo(w / 2 - w * 0.3, h * 0.36);
        ctx.closePath();
        ctx.fill();
      } else ctx.fillRect(w / 2 - shaft / 2, h * 0.26, shaft, h * 0.1);
      for (const side of kinds.filter((k) => k !== 's')) {
        const dir = side === 'l' ? -1 : 1;
        const y = kinds.includes('s') ? h * 0.52 : h * 0.3;
        ctx.fillRect(dir > 0 ? w / 2 : w / 2 - w * 0.3, y, w * 0.3, shaft);
        ctx.beginPath();
        ctx.moveTo(w / 2 + dir * w * 0.46, y + shaft / 2);
        ctx.lineTo(w / 2 + dir * w * 0.26, y - h * 0.06);
        ctx.lineTo(w / 2 + dir * w * 0.26, y + shaft + h * 0.06);
        ctx.closePath();
        ctx.fill();
      }
    });
    speckle(cell, 90, 0.45, '30,30,34');
    rough(cell, 0.6);
  };
  arrow(DECAL_CELLS.arrowStraight, ['s']);
  arrow(DECAL_CELLS.arrowLeft, ['l']);
  arrow(DECAL_CELLS.arrowRight, ['r']);
  arrow(DECAL_CELLS.arrowStraightLeft, ['s', 'l']);
  arrow(DECAL_CELLS.arrowStraightRight, ['s', 'r']);
  // Bicycle stencil.
  inCell(DECAL_CELLS.bike, (w, h) => {
    ctx.strokeStyle = 'rgba(240,240,244,0.95)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    for (const cx of [w * 0.27, w * 0.73]) {
      ctx.beginPath();
      ctx.arc(cx, h * 0.68, w * 0.2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(w * 0.27, h * 0.68);
    ctx.lineTo(w * 0.45, h * 0.35);
    ctx.lineTo(w * 0.73, h * 0.68);
    ctx.lineTo(w * 0.6, h * 0.35);
    ctx.lineTo(w * 0.45, h * 0.35);
    ctx.moveTo(w * 0.6, h * 0.35);
    ctx.lineTo(w * 0.55, h * 0.2);
    ctx.lineTo(w * 0.68, h * 0.2);
    ctx.stroke();
  });
  rough(DECAL_CELLS.bike, 0.6);
  // Paint: mottled white, used tinted for curb zones, bike lanes and green boxes.
  inCell(DECAL_CELLS.paint, (w, h) => {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(0, 0, w, h);
  });
  speckle(DECAL_CELLS.paint, 400, 0.5, '40,40,44');
  rough(DECAL_CELLS.paint, 0.65);
  // Rust ring (around manholes) and the puddle blob.
  inCell(DECAL_CELLS.rust, (w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, w * 0.3, w / 2, h / 2, w * 0.5);
    g.addColorStop(0, 'rgba(90,50,20,0)');
    g.addColorStop(0.3, 'rgba(90,50,20,0.4)');
    g.addColorStop(1, 'rgba(60,30,10,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
  rough(DECAL_CELLS.rust, 0.95);
  inCell(DECAL_CELLS.puddle, (w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.85, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    blob(w, h, w / 2, h / 2, w * 0.48, 0.3);
    ctx.fill();
  });
  rough(DECAL_CELLS.puddle, 0.02);
  // Fresh patch: a lighter rectangle of new asphalt with a tar seam.
  inCell(DECAL_CELLS.patch, (w, h) => {
    ctx.fillStyle = 'rgba(44,46,54,0.85)';
    ctx.fillRect(6, 6, w - 12, h - 12);
    ctx.strokeStyle = 'rgba(10,10,12,0.9)';
    ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, w - 12, h - 12);
  });
  speckle(DECAL_CELLS.patch, 300, 0.35, '80,82,90');
  rough(DECAL_CELLS.patch, 0.75);
  // Gutter grime: a dark streak that fades across (laid along the curb).
  inCell(DECAL_CELLS.gutter, (w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(10,9,8,0.55)');
    g.addColorStop(0.5, 'rgba(10,9,8,0.2)');
    g.addColorStop(1, 'rgba(10,9,8,0)');
    ctx.fillStyle = g;
    for (let x = 0; x < w; x += 4) {
      ctx.globalAlpha = rng.range(0.4, 1);
      ctx.fillRect(x, 0, 4, h);
    }
    ctx.globalAlpha = 1;
  });
  speckle(DECAL_CELLS.gutter, 200, 0.4, '70,60,40');
  rough(DECAL_CELLS.gutter, 0.9);
  // Stencils: worn white block letters.
  const stencil = (cell: AtlasCell, text: string) => {
    inCell(cell, (w, h) => {
      ctx.fillStyle = 'rgba(232,232,236,0.9)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let size = h * 0.62;
      ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
      while (ctx.measureText(text).width > w - 24 && size > 20) {
        size -= 4;
        ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
      }
      ctx.fillText(text, w / 2, h / 2 + 2);
    });
    speckle(cell, 140, 0.5, '30,30,34');
    rough(cell, 0.6);
  };
  stencil(DECAL_CELLS.noParking, 'NO PARKING');
  stencil(DECAL_CELLS.loading, 'LOADING ZONE');
  stencil(DECAL_CELLS.busStop, 'BUS STOP');
  stencil(DECAL_CELLS.towAway, 'TOW AWAY ZONE');
  stencil(DECAL_CELLS.keepClear, 'KEEP CLEAR');
  stencil(DECAL_CELLS.fireLane, 'FIRE LANE');
  const map = canvasTex(c, { repeat: false });
  map.anisotropy = 8;
  const roughness = canvasTex(rc, { srgb: false, repeat: false });
  return { map, roughness };
}
