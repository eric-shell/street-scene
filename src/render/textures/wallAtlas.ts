/**
 * The wall atlas (wallDressing.ts): posters, flyers, the event banners and a
 * grime gradient for walls. Procedural and seeded, drawn once per seed and
 * cached by the polish builder. Graffiti used to live here too (pieces,
 * throw-ups, tags, stencils) and was cut: sprayed paint never read well
 * against the drawn facades, so the walls now carry only paper and dirt.
 */
import type * as THREE from 'three';
import { Rng } from '../../sim/prng';
import { hexRgba } from '../color';
import { canvas, canvasTex, drawInCell, type AtlasCell } from './canvasKit';

export const WALL_ATLAS = { w: 1024, h: 448 } as const;

/** Wall atlas cells by kind; `n` copies of each kind sit side by side from (x, y). */
const WALL_CELLS = {
  poster: { x: 0, y: 0, w: 256, h: 192, n: 4 },
  banner: { x: 0, y: 192, w: 384, h: 128, n: 2 },
  grime: { x: 768, y: 192, w: 256, h: 128, n: 1 },
  flyers: { x: 0, y: 320, w: 128, h: 128, n: 2 },
} as const;
export type WallKind = keyof typeof WALL_CELLS;

export function wallCell(kind: WallKind, i: number): AtlasCell {
  const c = WALL_CELLS[kind];
  return { x: c.x + (i % c.n) * c.w, y: c.y, w: c.w, h: c.h };
}

/** Aged paper, light to dark: posters and flyers that have hung out in the weather a while. */
const PAPER_TONES = ['#d4ccb8', '#c9bda0', '#bdb5a8', '#d9d3c6', '#3a3236'];
/** Banner pools: the left cloth names the night, the right one the series; a seed draws one of each. */
const BANNER_LEFT = ['STREET SCENE · AFTER DARK', 'NIGHT MARKET · OPEN LATE', 'DRIFT CLUB · TONIGHT', 'ALL NIGHT · ALL STREETS', 'LAST CALL · 4AM', 'CITY LIGHTS · LIVE', 'NO SLEEP · NO LIMITS', 'MIDNIGHT RUN · GO'];
const BANNER_RIGHT = ['ROUND 3 · NIGHT SERIES', 'FINALS · SAT NIGHT', 'SEASON OPENER · FREE', 'TURBO CUP · ROUND 2', 'STREET KINGS · LIVE', 'UNDERPASS OPEN · GO', 'WINTER SERIES · 5', 'SPRINT WEEK · TODAY'];
const POSTER_LINES = [
  ['DRIFT NIGHT', 'SAT 11PM', 'PIER 9'],
  ['LIVE', 'KAIJU KARAOKE', 'EVERY FRI'],
  ['STREET SCENE', 'AFTER DARK', 'ROUND 3'],
  ['LOST CAT', 'ANSWERS TO', 'NITRO'],
  ['TATTOO', 'WALK INS', 'OPEN LATE'],
  ['DJ ORBIT', 'ROXY', 'DOORS 10'],
  ['BUY SELL', 'TRADE', 'VOLT MOTORS'],
  ['NO SLEEP', 'TIL', 'SUNRISE'],
  ['LOST DOG', 'BIG AND DUMB', 'PLEASE CALL'],
  ['ROOM FOR RENT', 'NO PETS', 'NO QUESTIONS'],
  ['SKA NIGHT', 'FREE BEFORE 9', 'THE BLUE MOON'],
  ['KARAOKE', 'EVERY TUES', 'KAIJU KARAOKE'],
  ['BAIL BONDS', 'ANY HOUR', 'FAST BAIL'],
  ['CASH 4 CARS', 'ANY CONDITION', 'CALL TONY'],
  ['VINYL SALE', 'ALL RECORDS', 'HALF OFF'],
  ['GUITAR LESSONS', 'CHEAP', 'LOUD'],
  ['FREE COUCH', 'YOU CARRY IT', 'BY THE BIN'],
  ['BAND WANTS', 'DRUMMER', 'MUST HAVE VAN'],
  ['NIGHT MARKET', 'FRI SAT', 'BRING CASH'],
  ['STREET RACE', 'IS A BAD IDEA', 'SEE YOU THERE'],
  ['YARD SALE', 'EVERYTHING GOES', 'SUN 7AM'],
  ['PSYCHIC', 'YOU KNOW WHY', 'YOU CAME'],
  ['DUMPLINGS', 'AT 3AM', 'THE GOOD KIND'],
  ['TOW ZONE', 'NO PARKING', 'MEAN IT'],
  ['COMEDY NIGHT', 'FIVE BUCKS', 'TWO DRINKS'],
  ['ROLLER DERBY', 'SAT NIGHT', 'BRING A HELMET'],
  ['WANTED', 'BASS PLAYER', 'APPLY WITHIN'],
  ['POETRY SLAM', 'WED 9PM', 'ROXY'],
  ['TACO TUESDAY', 'IS EVERY DAY', 'TURBO TACO'],
  ['MISSING', 'ONE SHOE', 'SIZE 11'],
  ['NEON REPAIR', 'WHILE U WAIT', 'ASK INSIDE'],
  ['LATE FEE', 'WAIVED', 'TONIGHT ONLY'],
  ['LAUNDRY', 'WASH N FOLD', 'LOW PRICES'],
  ['AUTO PARTS', 'USED', 'HONEST'],
  ['WINTER COATS', 'DROP OFF', 'HERE'],
  ['MEET UP', 'PIER 9', 'MIDNIGHT'],
  ['DETECTIVE', 'NO CASE', 'TOO SMALL'],
  ['LOUD MUSIC', 'AHEAD', 'YOU WERE WARNED'],
];

/**
 * Posters, flyers, banners and a grime gradient for walls, drawn the way they
 * end up on a real wall: posters and flyers on aged paper with torn edges,
 * stains and faded print, the banners as printed cloth, the grime as a
 * streaked gradient. RGBA, alpha outside the art. Seeded, so a seed's walls
 * always read the same.
 */
export function makeWallAtlas(seed: number): THREE.Texture {
  const rng = new Rng(seed ^ 0x6ff1);
  const [c, ctx] = canvas(WALL_ATLAS.w, WALL_ATLAS.h);
  ctx.clearRect(0, 0, WALL_ATLAS.w, WALL_ATLAS.h);
  const inCell = (cell: AtlasCell, draw: (w: number, h: number) => void) => drawInCell(ctx, cell, draw);

  // ---------- Paper: posters and flyers, torn, stained, faded ----------
  /** A sheet of paper with torn edges, filled and clipped: `draw` runs inside it. */
  const sheet = (x: number, y: number, w: number, h: number, tone: string, tilt: number, draw: () => void) => {
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(tilt);
    ctx.beginPath();
    const notch = Math.min(w, h) * 0.045;
    const edge = (x0: number, y0: number, x1: number, y1: number, n: number) => {
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const nx = -(y1 - y0);
        const ny = x1 - x0;
        const l = Math.hypot(nx, ny) || 1;
        const d = k === n ? 0 : rng.range(-notch, notch * 0.4);
        ctx.lineTo(x0 + (x1 - x0) * t + (nx / l) * d, y0 + (y1 - y0) * t + (ny / l) * d);
      }
    };
    ctx.moveTo(-w / 2, -h / 2);
    edge(-w / 2, -h / 2, w / 2, -h / 2, 9);
    edge(w / 2, -h / 2, w / 2, h / 2, 7);
    edge(w / 2, h / 2, -w / 2, h / 2, 9);
    edge(-w / 2, h / 2, -w / 2, -h / 2, 7);
    ctx.closePath();
    ctx.fillStyle = tone;
    ctx.fill();
    ctx.clip();
    ctx.translate(-w / 2, -h / 2);
    draw();
    // Weather: rain streaks, a stain or two, a crease, a shadow along the bottom where it peels.
    for (let k = 0; k < 10; k++) {
      ctx.fillStyle = `rgba(60,45,30,${rng.range(0.03, 0.09)})`;
      ctx.fillRect(rng.range(0, w), 0, rng.range(1, 3), h);
    }
    for (let k = 0; k < rng.int(1, 2); k++) {
      const sx = rng.range(0, w);
      const sy = rng.range(h * 0.5, h);
      const sr = rng.range(w * 0.12, w * 0.3);
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
      g.addColorStop(0, 'rgba(80,55,25,0.22)');
      g.addColorStop(0.8, 'rgba(80,55,25,0.1)');
      g.addColorStop(1, 'rgba(80,55,25,0)');
      ctx.fillStyle = g;
      ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
    }
    const cy = rng.range(h * 0.3, h * 0.7);
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.fillRect(0, cy, w, 1.5);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, cy + 1.5, w, 1.5);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, h - 4, w, 4);
    ctx.restore();
  };
  /** Rip a corner or an edge chunk out of whatever is under it. */
  const tear = (x: number, y: number, w: number, h: number) => {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 1; k <= 5; k++) ctx.lineTo(x + (w * k) / 5, y + h * rng.range(0.2, 1));
    ctx.lineTo(x + w, y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  for (let i = 0; i < WALL_CELLS.poster.n; i++) {
    inCell(wallCell('poster', i), (w, h) => {
      const lines = POSTER_LINES[rng.int(0, POSTER_LINES.length - 1)];
      const tone = rng.pick(PAPER_TONES);
      const dark = tone === '#3a3236';
      const inkText = dark ? 'rgba(205,200,190,0.8)' : rng.chance(0.3) ? 'rgba(90,25,25,0.85)' : 'rgba(25,24,28,0.82)';
      sheet(6, 6, w - 12, h - 12, tone, rng.range(-0.03, 0.03), () => {
        const pw = w - 12;
        const ph = h - 12;
        // A band of dull print colour and a halftone field for the gig poster look, both faded.
        ctx.fillStyle = hexRgba(rng.pick(['#7a4621', '#6a1d1d', '#2f452c', '#8e9196', '#1d2a46']), 0.6);
        ctx.fillRect(0, ph * 0.55, pw, ph * 0.22);
        ctx.fillStyle = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
        for (let yy = 8; yy < ph * 0.5; yy += 8) for (let xx = 8; xx < pw - 8; xx += 8) ctx.fillRect(xx, yy, 3, 3);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = inkText;
        ctx.font = `900 ${ph * 0.2}px Impact, "Arial Black", sans-serif`;
        ctx.fillText(lines[0], pw / 2, ph * 0.3, pw - 18);
        ctx.font = `700 ${ph * 0.11}px Arial, sans-serif`;
        ctx.fillStyle = dark ? 'rgba(20,18,22,0.85)' : 'rgba(235,230,220,0.85)';
        ctx.fillText(lines[1], pw / 2, ph * 0.66, pw - 18);
        ctx.fillStyle = inkText;
        ctx.font = `700 ${ph * 0.09}px Arial, sans-serif`;
        ctx.fillText(lines[2], pw / 2, ph * 0.86, pw - 18);
      });
      // A corner gone, a chunk off one edge.
      tear(w - 44, h - 6 - rng.range(14, 34), 44, 40);
      if (rng.chance(0.6)) tear(rng.range(0, w * 0.5), 2, rng.range(20, 50), rng.range(8, 18));
    });
  }
  for (let i = 0; i < WALL_CELLS.flyers.n; i++) {
    inCell(wallCell('flyers', i), (w, h) => {
      for (let k = 0; k < 6; k++) {
        const lines = POSTER_LINES[rng.int(0, POSTER_LINES.length - 1)];
        const fw = w * 0.46;
        const fh = h * 0.46;
        const fx = rng.range(0, w - fw);
        const fy = rng.range(0, h - fh);
        const tone = rng.pick(PAPER_TONES.slice(0, 4));
        sheet(fx, fy, fw, fh, tone, rng.range(-0.16, 0.16), () => {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          lines.forEach((line, j) => {
            const big = j === 0;
            let size = big ? fh * 0.24 : fh * 0.13;
            const font = () => `${big ? 900 : 700} ${size}px ${big ? 'Impact, "Arial Black"' : 'Arial'}, sans-serif`;
            ctx.font = font();
            while (ctx.measureText(line).width > fw - 8 && size > 5) {
              size -= 1;
              ctx.font = font();
            }
            ctx.fillStyle = big && rng.chance(0.4) ? 'rgba(90,25,25,0.8)' : 'rgba(25,24,28,0.78)';
            ctx.fillText(line, fw / 2, fh * 0.28 + j * fh * 0.26);
          });
          // Staples.
          ctx.fillStyle = 'rgba(40,40,44,0.8)';
          ctx.fillRect(3, 3, 4, 2);
          ctx.fillRect(fw - 7, 3, 4, 2);
        });
        if (rng.chance(0.4)) tear(fx + rng.range(0, fw * 0.5), fy + fh - rng.range(6, 16), fw * 0.5, 16);
      }
    });
  }
  const BANNER_TEXT = [rng.pick(BANNER_LEFT), rng.pick(BANNER_RIGHT)];
  for (let i = 0; i < WALL_CELLS.banner.n; i++) {
    inCell(wallCell('banner', i), (w, h) => {
      ctx.fillStyle = i ? '#1a1030' : '#2a0e1c';
      ctx.fillRect(0, 8, w, h - 16);
      ctx.fillStyle = i ? '#22e6ff' : '#ff2bd6';
      ctx.fillRect(0, 8, w, 6);
      ctx.fillRect(0, h - 14, w, 6);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.font = `900 ${h * 0.42}px Impact, "Arial Black", sans-serif`;
      ctx.fillText(BANNER_TEXT[i], w / 2, h / 2, w - 30);
    });
  }
  inCell(wallCell('grime', 0), (w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(12,10,8,0)');
    g.addColorStop(0.55, 'rgba(12,10,8,0.35)');
    g.addColorStop(1, 'rgba(10,8,6,0.8)');
    ctx.fillStyle = g;
    for (let x = 0; x < w; x += 3) {
      ctx.globalAlpha = rng.range(0.5, 1);
      ctx.fillRect(x, rng.range(-8, 8), 3, h);
    }
    ctx.globalAlpha = 1;
  });
  const t = canvasTex(c, { repeat: false });
  t.anisotropy = 8;
  return t;
}
