/**
 * The graffiti atlas (wallDressing.ts): pieces, throw-ups, tags, stencils, posters, flyers, banners and a
 * grime gradient for walls. Procedural and seeded, drawn once per seed and cached by the polish builder.
 */
import type * as THREE from 'three';
import { Rng } from '../../sim/prng';
import { hexRgba } from '../color';
import { canvas, canvasTex, drawInCell, type AtlasCell } from './canvasKit';

export const GRAFFITI_ATLAS = { w: 1024, h: 896 } as const;

/** Graffiti atlas cells by kind; `n` copies of each kind sit side by side from (x, y). */
export const GRAFFITI_CELLS = {
  mural: { x: 0, y: 0, w: 512, h: 256, n: 2 },
  throwup: { x: 0, y: 256, w: 256, h: 128, n: 4 },
  tag: { x: 0, y: 384, w: 128, h: 64, n: 8 },
  stencil: { x: 0, y: 448, w: 128, h: 128, n: 6 },
  flyers: { x: 768, y: 448, w: 128, h: 128, n: 2 },
  poster: { x: 0, y: 576, w: 256, h: 192, n: 4 },
  banner: { x: 0, y: 768, w: 384, h: 128, n: 2 },
  grime: { x: 768, y: 768, w: 256, h: 128, n: 1 },
} as const;
export type GraffitiKind = keyof typeof GRAFFITI_CELLS;

export function graffitiCell(kind: GraffitiKind, i: number): AtlasCell {
  const c = GRAFFITI_CELLS[kind];
  return { x: c.x + (i % c.n) * c.w, y: c.y, w: c.w, h: c.h };
}

const GRAFFITI_WORDS = ['NIGHT', 'RUN', 'DRIFT', 'VOLT', 'KAIJU', 'ZERO', 'APEX', 'SONIC', 'NEON', 'LUCKY', 'ORBIT', 'ROXY', 'HYPER', 'OKAMI', 'TURBO', 'SAKURA', 'NOIR', 'FLUX'];
/**
 * Spray can inks, weighted: what is actually on a city wall is mostly black
 * and chrome, with the odd dark red, oxblood, navy, dull green or rust and a
 * rare dirty white. Nothing saturated: paint on a wall at night is lit by
 * the street like the wall, not by itself.
 */
const GRAFFITI_INKS: readonly [string, number][] = [
  ['#131316', 5],
  ['#8e9196', 4],
  ['#6a1d1d', 2],
  ['#46141f', 2],
  ['#1d2a46', 2],
  ['#2f452c', 1.5],
  ['#7a4621', 1.5],
  ['#cfc9bb', 0.8],
];
/** Aged paper, light to dark: posters and flyers that have hung out in the weather a while. */
const PAPER_TONES = ['#d4ccb8', '#c9bda0', '#bdb5a8', '#d9d3c6', '#3a3236'];
const POSTER_LINES = [
  ['DRIFT NIGHT', 'SAT 11PM', 'PIER 9'],
  ['LIVE', 'KAIJU KARAOKE', 'EVERY FRI'],
  ['STREET SCENE', 'AFTER DARK', 'ROUND 3'],
  ['LOST CAT', 'ANSWERS TO', 'NITRO'],
  ['TATTOO', 'WALK INS', 'OPEN LATE'],
  ['DJ ORBIT', 'ROXY', 'DOORS 10'],
  ['BUY SELL', 'TRADE', 'VOLT MOTORS'],
  ['NO SLEEP', 'TIL', 'SUNRISE'],
];

/**
 * Graffiti, posters, flyers, banners and a grime gradient for walls, drawn
 * the way they end up on a real wall: pieces, throw-ups and tags in dark,
 * desaturated spray paint with soft overspray haze, fuzzy uneven edges,
 * drips and spatter, hand lettered letter by letter so sizes and baselines
 * wander; older ghosted tags and buffed-over patches under them, some tags
 * crossed out; stencils with the halo spray leaves round the card; posters
 * and flyers on aged paper with torn edges, stains and faded print. RGBA,
 * alpha outside the art. Seeded, so a seed's walls always read the same.
 */
export function makeGraffitiAtlas(seed: number): THREE.Texture {
  const rng = new Rng(seed ^ 0x6ff1);
  const [c, ctx] = canvas(GRAFFITI_ATLAS.w, GRAFFITI_ATLAS.h);
  ctx.clearRect(0, 0, GRAFFITI_ATLAS.w, GRAFFITI_ATLAS.h);
  const inCell = (cell: AtlasCell, draw: (w: number, h: number) => void) => drawInCell(ctx, cell, draw);
  const inkTotal = GRAFFITI_INKS.reduce((s, [, w]) => s + w, 0);
  const pickInk = (): string => {
    let r = rng.next() * inkTotal;
    for (const [ink, w] of GRAFFITI_INKS) {
      r -= w;
      if (r <= 0) return ink;
    }
    return GRAFFITI_INKS[0][0];
  };
  /** A second ink that reads against the first: black under anything light, chrome or dirty white under anything dark. */
  const contrast = (ink: string) => (ink === '#8e9196' || ink === '#cfc9bb' ? '#131316' : rng.chance(0.6) ? '#8e9196' : '#cfc9bb');
  const noShadow = () => {
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'rgba(0,0,0,0)';
  };
  const heavy = (px: number) => `900 ${px}px "Arial Black", Impact, sans-serif`;
  const script = (px: number) => `italic 700 ${px}px "Marker Felt", "Brush Script MT", "Snell Roundhand", "Comic Sans MS", cursive`;

  /** Overspray spatter: fine dots of the ink around a box, denser near it. */
  const spatter = (x: number, y: number, w: number, h: number, ink: string, n: number) => {
    for (let i = 0; i < n; i++) {
      const px = x + rng.range(-w * 0.15, w * 1.15);
      const py = y + rng.range(-h * 0.3, h * 1.3);
      ctx.fillStyle = hexRgba(ink, rng.range(0.1, 0.4));
      ctx.beginPath();
      ctx.arc(px, py, rng.range(0.4, 1.8), 0, Math.PI * 2);
      ctx.fill();
    }
  };
  /** Runs from the bottom of a stroke: a thin line of the ink and a drop at its end. */
  const drips = (x: number, y: number, w: number, ink: string, n: number, maxLen = 36) => {
    for (let i = 0; i < n; i++) {
      const dx = x + rng.range(0, w);
      const len = rng.range(5, maxLen);
      const lw = rng.range(1.5, 3);
      ctx.strokeStyle = hexRgba(ink, rng.range(0.6, 0.9));
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(dx, y);
      ctx.lineTo(dx + rng.range(-1.5, 1.5), y + len);
      ctx.stroke();
      ctx.fillStyle = hexRgba(ink, 0.85);
      ctx.beginPath();
      ctx.arc(dx, y + len, lw * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  /** A grey roller patch where someone painted an old tag out: never quite the wall's own colour. */
  const buff = (w: number, h: number) => {
    const bw = rng.range(w * 0.3, w * 0.7);
    const bh = rng.range(h * 0.35, h * 0.8);
    ctx.save();
    ctx.translate(rng.range(0, w - bw) + bw / 2, rng.range(0, h - bh) + bh / 2);
    ctx.rotate(rng.range(-0.03, 0.03));
    const g = rng.int(78, 98);
    ctx.fillStyle = `rgba(${g},${g + 2},${g + 6},${rng.range(0.5, 0.7)})`;
    ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
    // Roller tracks.
    for (let k = 0; k < 4; k++) {
      ctx.fillStyle = `rgba(${k % 2 ? 255 : 0},${k % 2 ? 255 : 0},${k % 2 ? 255 : 0},0.05)`;
      ctx.fillRect(-bw / 2, -bh / 2 + rng.range(0, bh), bw, rng.range(3, 9));
    }
    ctx.restore();
  };

  interface Letter {
    ch: string;
    x: number;
    y: number;
    size: number;
    rot: number;
  }
  /** Lay a word out letter by letter, each with its own size, tilt and baseline, so nothing lines up like type. */
  const layout = (word: string, size: number, font: (px: number) => string, spread: number, gap: number): { letters: Letter[]; width: number } => {
    const letters: Letter[] = [];
    let x = 0;
    for (const ch of word) {
      const s = size * rng.range(0.82, 1.18);
      ctx.font = font(s);
      const w = ctx.measureText(ch).width;
      letters.push({ ch, x: x + w / 2, y: rng.range(-spread, spread) * size, size: s, rot: rng.range(-0.14, 0.14) });
      x += w * gap * rng.range(0.92, 1.06);
    }
    return { letters, width: x };
  };
  const eachLetter = (L: Letter[], font: (px: number) => string, dx: number, dy: number, draw: (l: Letter) => void) => {
    for (const l of L) {
      ctx.save();
      ctx.translate(l.x + dx, l.y + dy);
      ctx.rotate(l.rot);
      ctx.font = font(l.size);
      draw(l);
      ctx.restore();
    }
  };
  /**
   * A sprayed word centred on (cx, cy), scaled to fit maxW: a hazy underlayer (the can's overspray),
   * the fill laid down in a few jittered passes so its edges stay soft and uneven, an optional block
   * shadow behind it and a thin broken outline, then drips from the letters' feet.
   */
  const sprayWord = (cx: number, cy: number, word: string, size: number, maxW: number, o: { ink: string; outline?: string; block?: string; haze: number; drip: number; alpha?: number }) => {
    const { letters, width } = layout(word, size, heavy, 0.07, 0.96);
    const k = Math.min(1, maxW / width);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.transform(1, rng.range(-0.06, 0.06), rng.range(-0.22, 0.22), 1, 0, 0);
    ctx.scale(k, k);
    ctx.translate(-width / 2, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const alpha = o.alpha ?? 1;
    // Overspray haze: the word blurred under itself.
    ctx.shadowColor = hexRgba(o.ink, 0.55 * alpha);
    ctx.shadowBlur = size * o.haze;
    ctx.fillStyle = hexRgba(o.ink, 0.22 * alpha);
    eachLetter(letters, heavy, 0, 0, (l) => ctx.fillText(l.ch, 0, 0));
    noShadow();
    if (o.block) {
      ctx.fillStyle = hexRgba(o.block, 0.8 * alpha);
      eachLetter(letters, heavy, size * 0.07, size * 0.09, (l) => ctx.fillText(l.ch, 0, 0));
    }
    // The fill: jittered passes blur the edge, a last one gives it body.
    for (let pass = 0; pass < 3; pass++) {
      ctx.fillStyle = hexRgba(o.ink, (pass === 2 ? 0.85 : 0.4) * alpha);
      const j = pass === 2 ? 0 : size * 0.035;
      eachLetter(letters, heavy, rng.range(-j, j), rng.range(-j, j), (l) => ctx.fillText(l.ch, 0, 0));
    }
    if (o.outline) {
      // A hand line: uneven dashes where the can skipped, two passes a hair apart so it wavers.
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = hexRgba(o.outline, 0.5 * alpha);
        ctx.lineWidth = Math.max(1.2, size * rng.range(0.035, 0.055));
        ctx.setLineDash([rng.range(20, 70), rng.range(1, 4), rng.range(8, 30), rng.range(1, 5), rng.range(30, 90), rng.range(2, 6)]);
        ctx.lineDashOffset = rng.range(0, 60);
        eachLetter(letters, heavy, rng.range(-1.5, 1.5), rng.range(-1.5, 1.5), (l) => ctx.strokeText(l.ch, 0, 0));
      }
      ctx.setLineDash([]);
    }
    if (o.drip > 0) for (const l of letters) if (rng.chance(o.drip)) drips(l.x - l.size * 0.25, l.y + l.size * 0.3, l.size * 0.5, o.ink, 1, size * 0.9);
    ctx.restore();
    return { width: width * k, height: size };
  };
  /** A marker or thin-cap tag: one hand written stroke of varying weight, with a flourish under it. */
  const tagWord = (cx: number, cy: number, word: string, size: number, maxW: number, ink: string, alpha: number, blur = 0) => {
    const { letters, width } = layout(word, size, script, 0.1, 0.84);
    const k = Math.min(1, maxW / width);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.transform(1, rng.range(-0.12, 0.12), rng.range(-0.45, 0.05), 1, 0, 0);
    ctx.scale(k, k);
    ctx.translate(-width / 2, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (blur > 0) {
      ctx.shadowColor = hexRgba(ink, 0.6 * alpha);
      ctx.shadowBlur = blur;
    }
    ctx.strokeStyle = hexRgba(ink, alpha);
    eachLetter(letters, script, 0, 0, (l) => {
      ctx.lineWidth = rng.range(1.6, 3.6) * (l.size / size);
      ctx.strokeText(l.ch, 0, 0);
      // Marker drag: a second, lighter pass a hair off.
      ctx.lineWidth *= 0.6;
      ctx.strokeStyle = hexRgba(ink, alpha * 0.5);
      ctx.strokeText(l.ch, rng.range(-1.2, 1.2), rng.range(-1, 1));
      ctx.strokeStyle = hexRgba(ink, alpha);
    });
    // The flourish: an underline swoop, an arrow, or a star.
    ctx.lineWidth = rng.range(1.8, 3);
    const f = rng.next();
    ctx.beginPath();
    if (f < 0.5) {
      ctx.moveTo(width * 0.1, size * 0.42);
      ctx.quadraticCurveTo(width * 0.55, size * 0.62, width * rng.range(0.85, 1.1), size * rng.range(0.25, 0.45));
    } else if (f < 0.75) {
      ctx.moveTo(width * 0.95, size * 0.1);
      ctx.lineTo(width * 1.12, size * 0.1);
      ctx.moveTo(width * 1.05, size * 0.02);
      ctx.lineTo(width * 1.13, size * 0.1);
      ctx.lineTo(width * 1.05, size * 0.18);
    } else {
      const sx = width * 1.08;
      const sy = -size * 0.28;
      for (let i = 0; i < 5; i++) {
        const a = (i * 4 * Math.PI) / 5 - Math.PI / 2;
        if (i === 0) ctx.moveTo(sx + Math.cos(a) * size * 0.14, sy + Math.sin(a) * size * 0.14);
        else ctx.lineTo(sx + Math.cos(a) * size * 0.14, sy + Math.sin(a) * size * 0.14);
      }
      ctx.closePath();
    }
    ctx.stroke();
    noShadow();
    ctx.restore();
    return width * k;
  };
  /** Older tags under the new work, faded almost to the wall. */
  const ghosts = (w: number, h: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const word = rng.pick(GRAFFITI_WORDS).toLowerCase();
      const ink = rng.chance(0.6) ? '#131316' : rng.chance(0.5) ? '#8e9196' : '#46141f';
      tagWord(rng.range(w * 0.25, w * 0.75), rng.range(h * 0.2, h * 0.8), word, h * rng.range(0.3, 0.5), w * 0.9, ink, rng.range(0.1, 0.22), 2.5);
    }
  };
  /** A line through a tag: somebody else's opinion of it. */
  const crossOut = (x: number, y: number, w: number, h: number) => {
    const ink = rng.chance(0.7) ? '#131316' : '#6a1d1d';
    ctx.strokeStyle = hexRgba(ink, 0.8);
    ctx.lineWidth = rng.range(2.5, 5);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y + rng.range(-h * 0.2, h * 0.2));
    ctx.lineTo(x + w, y + rng.range(-h * 0.2, h * 0.2));
    if (rng.chance(0.5)) {
      ctx.moveTo(x, y + rng.range(-h * 0.3, h * 0.3));
      ctx.lineTo(x + w, y + rng.range(-h * 0.3, h * 0.3));
    }
    ctx.stroke();
  };

  // ---------- Murals: a full piece, layered over what was there before ----------
  for (let i = 0; i < GRAFFITI_CELLS.mural.n; i++) {
    inCell(graffitiCell('mural', i), (w, h) => {
      if (rng.chance(0.7)) buff(w, h);
      ghosts(w, h, 2);
      // Background: a few hazy blocks of dark ink behind the letters.
      for (let k = 0; k < 3; k++) {
        const ink = pickInk();
        ctx.shadowColor = hexRgba(ink, 0.5);
        ctx.shadowBlur = 14;
        ctx.fillStyle = hexRgba(ink, rng.range(0.3, 0.5));
        ctx.beginPath();
        const bx = rng.range(w * 0.05, w * 0.6);
        const bz = rng.range(h * 0.1, h * 0.5);
        const bw = rng.range(w * 0.25, w * 0.5);
        const bh = rng.range(h * 0.3, h * 0.6);
        ctx.moveTo(bx + rng.range(-10, 10), bz + rng.range(-10, 10));
        ctx.lineTo(bx + bw + rng.range(-10, 10), bz + rng.range(-10, 10));
        ctx.lineTo(bx + bw + rng.range(-10, 10), bz + bh + rng.range(-10, 10));
        ctx.lineTo(bx + rng.range(-10, 10), bz + bh + rng.range(-10, 10));
        ctx.closePath();
        ctx.fill();
        noShadow();
      }
      const word = rng.pick(GRAFFITI_WORDS);
      const ink = pickInk();
      const size = Math.min(h * 0.58, (w * 1.5) / Math.max(4, word.length));
      const piece = sprayWord(w * 0.47, h * 0.47, word, size, w * 0.86, { ink, outline: contrast(ink), block: rng.chance(0.5) ? '#131316' : '#1d2a46', haze: 0.22, drip: 0.5 });
      spatter(w * 0.47 - piece.width / 2, h * 0.47 - size / 2, piece.width, size, ink, 40);
      // Character: a crude face in a corner, one colour and a black line.
      const fx = w * rng.range(0.82, 0.9);
      const fy = h * rng.range(0.66, 0.76);
      const fr = h * 0.15;
      const skin = rng.chance(0.5) ? '#8e9196' : '#cfc9bb';
      ctx.shadowColor = hexRgba(skin, 0.5);
      ctx.shadowBlur = 8;
      ctx.fillStyle = hexRgba(skin, 0.85);
      ctx.beginPath();
      ctx.arc(fx, fy, fr, 0, Math.PI * 2);
      ctx.fill();
      noShadow();
      ctx.strokeStyle = 'rgba(19,19,22,0.85)';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(fx + rng.range(-2, 2), fy + rng.range(-2, 2), fr * rng.range(0.96, 1.06), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(19,19,22,0.9)';
      ctx.fillRect(fx - fr * 0.45, fy - fr * 0.25, fr * 0.22, fr * 0.22);
      ctx.fillRect(fx + fr * 0.2, fy - fr * 0.3, fr * 0.22, fr * 0.22);
      ctx.beginPath();
      ctx.arc(fx, fy + fr * 0.2, fr * 0.45, rng.range(0.1, 0.5), Math.PI - rng.range(0.1, 0.5));
      ctx.stroke();
      // A tag signing the piece in a lower corner.
      tagWord(w * 0.16, h * 0.88, rng.pick(GRAFFITI_WORDS).toLowerCase(), h * 0.13, w * 0.3, rng.chance(0.5) ? '#131316' : ink, 0.85);
    });
  }

  // ---------- Throw-ups: quick fat letters, chrome and black or two dark inks ----------
  for (let i = 0; i < GRAFFITI_CELLS.throwup.n; i++) {
    inCell(graffitiCell('throwup', i), (w, h) => {
      if (rng.chance(0.4)) buff(w, h);
      ghosts(w, h, rng.int(0, 2));
      const word = rng.pick(GRAFFITI_WORDS);
      const classic = rng.chance(0.55);
      const ink = classic ? (rng.chance(0.7) ? '#8e9196' : '#cfc9bb') : pickInk();
      const size = Math.min(h * 0.68, (w * 1.45) / Math.max(4, word.length));
      const piece = sprayWord(w * 0.5, h * 0.48, word, size, w * 0.9, { ink, outline: classic || rng.chance(0.5) ? contrast(ink) : undefined, haze: 0.26, drip: 0.45 });
      spatter(w * 0.5 - piece.width / 2, h * 0.48 - size / 2, piece.width, size, ink, 25);
      if (rng.chance(0.3)) crossOut(w * 0.5 - piece.width / 2, h * 0.48, piece.width, size);
    });
  }

  // ---------- Tags: marker and thin cap handwriting, some crossed out ----------
  for (let i = 0; i < GRAFFITI_CELLS.tag.n; i++) {
    inCell(graffitiCell('tag', i), (w, h) => {
      if (rng.chance(0.4)) ghosts(w, h, 1);
      const word = rng.pick(GRAFFITI_WORDS).toLowerCase();
      const ink = pickInk();
      const sprayed = rng.chance(0.4);
      const width = tagWord(w * 0.48, h * 0.48, word, h * 0.62, w * 0.86, ink, rng.range(0.75, 0.95), sprayed ? 2.5 : 0);
      if (sprayed) {
        spatter(w * 0.48 - width / 2, h * 0.2, width, h * 0.6, ink, 14);
        drips(w * 0.48 - width * 0.3, h * 0.66, width * 0.6, ink, rng.int(1, 2), h * 0.3);
      }
      if (rng.chance(0.35)) tagWord(w * rng.range(0.6, 0.8), h * rng.range(0.15, 0.3), rng.pick(['xo', 'ok', '13', 'ck', 'rip', 'ns']), h * 0.3, w * 0.3, rng.chance(0.5) ? ink : pickInk(), 0.8);
      if (rng.chance(0.25)) crossOut(w * 0.48 - width / 2, h * 0.48, width, h * 0.6);
    });
  }
  const stencilShapes: ((w: number, h: number) => void)[] = [
    (w, h) => {
      // star
      ctx.beginPath();
      for (let k = 0; k < 10; k++) {
        const r = k % 2 ? w * 0.18 : w * 0.42;
        const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
        ctx.lineTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
    },
    (w, h) => {
      // crown
      ctx.beginPath();
      ctx.moveTo(w * 0.15, h * 0.75);
      ctx.lineTo(w * 0.15, h * 0.3);
      ctx.lineTo(w * 0.35, h * 0.5);
      ctx.lineTo(w * 0.5, h * 0.2);
      ctx.lineTo(w * 0.65, h * 0.5);
      ctx.lineTo(w * 0.85, h * 0.3);
      ctx.lineTo(w * 0.85, h * 0.75);
      ctx.closePath();
      ctx.fill();
    },
    (w, h) => {
      // arrow up
      ctx.beginPath();
      ctx.moveTo(w / 2, h * 0.15);
      ctx.lineTo(w * 0.85, h * 0.5);
      ctx.lineTo(w * 0.62, h * 0.5);
      ctx.lineTo(w * 0.62, h * 0.85);
      ctx.lineTo(w * 0.38, h * 0.85);
      ctx.lineTo(w * 0.38, h * 0.5);
      ctx.lineTo(w * 0.15, h * 0.5);
      ctx.closePath();
      ctx.fill();
    },
    (w, h) => {
      // skull: round head, jaw, eye holes cut out
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.42, w * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(w * 0.32, h * 0.55, w * 0.36, h * 0.25);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(w * 0.4, h * 0.42, w * 0.08, 0, Math.PI * 2);
      ctx.arc(w * 0.6, h * 0.42, w * 0.08, 0, Math.PI * 2);
      ctx.fill();
      for (let k = 0; k < 3; k++) ctx.fillRect(w * 0.38 + k * w * 0.1, h * 0.66, w * 0.04, h * 0.12);
      ctx.restore();
    },
    (w, h) => {
      // lightning bolt
      ctx.beginPath();
      ctx.moveTo(w * 0.6, h * 0.1);
      ctx.lineTo(w * 0.3, h * 0.55);
      ctx.lineTo(w * 0.5, h * 0.55);
      ctx.lineTo(w * 0.4, h * 0.9);
      ctx.lineTo(w * 0.72, h * 0.42);
      ctx.lineTo(w * 0.52, h * 0.42);
      ctx.closePath();
      ctx.fill();
    },
    (w, h) => {
      // eye
      ctx.beginPath();
      ctx.moveTo(w * 0.1, h / 2);
      ctx.quadraticCurveTo(w / 2, h * 0.1, w * 0.9, h / 2);
      ctx.quadraticCurveTo(w / 2, h * 0.9, w * 0.1, h / 2);
      ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w * 0.14, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
  ];
  // ---------- Stencils: a sharp card edge with the spray's halo outside it, thin where the can ran dry ----------
  for (let i = 0; i < GRAFFITI_CELLS.stencil.n; i++) {
    inCell(graffitiCell('stencil', i), (w, h) => {
      const ink = rng.chance(0.6) ? '#131316' : rng.chance(0.5) ? '#6a1d1d' : pickInk();
      const shape = stencilShapes[i % stencilShapes.length];
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(rng.range(-0.1, 0.1));
      ctx.translate(-w / 2, -h / 2);
      // Halo first: the shape blurred wide, then the card's own edge.
      ctx.shadowColor = hexRgba(ink, 0.55);
      ctx.shadowBlur = 9;
      ctx.fillStyle = hexRgba(ink, 0.3);
      shape(w, h);
      noShadow();
      ctx.fillStyle = hexRgba(ink, 0.82);
      shape(w, h);
      // Thin coverage: wipe a few faint bands across it.
      ctx.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < rng.int(2, 5); k++) {
        ctx.fillStyle = `rgba(0,0,0,${rng.range(0.1, 0.25)})`;
        ctx.fillRect(0, rng.range(0, h), w, rng.range(2, 7));
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
      spatter(w * 0.15, h * 0.15, w * 0.7, h * 0.7, ink, 18);
      if (rng.chance(0.3)) drips(w * 0.3, h * 0.78, w * 0.4, ink, 2, h * 0.2);
    });
  }

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
  for (let i = 0; i < GRAFFITI_CELLS.poster.n; i++) {
    inCell(graffitiCell('poster', i), (w, h) => {
      const lines = POSTER_LINES[(i * 2 + rng.int(0, 1)) % POSTER_LINES.length];
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
      // A corner gone, a chunk off one edge, sometimes a tag over it.
      tear(w - 44, h - 6 - rng.range(14, 34), 44, 40);
      if (rng.chance(0.6)) tear(rng.range(0, w * 0.5), 2, rng.range(20, 50), rng.range(8, 18));
      if (rng.chance(0.35)) tagWord(w * rng.range(0.35, 0.65), h * rng.range(0.4, 0.75), rng.pick(GRAFFITI_WORDS).toLowerCase(), h * 0.2, w * 0.6, rng.chance(0.6) ? '#131316' : '#8e9196', 0.85);
    });
  }
  for (let i = 0; i < GRAFFITI_CELLS.flyers.n; i++) {
    inCell(graffitiCell('flyers', i), (w, h) => {
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
  const BANNER_TEXT = ['STREET SCENE · AFTER DARK', 'ROUND 3 · NIGHT SERIES'];
  for (let i = 0; i < GRAFFITI_CELLS.banner.n; i++) {
    inCell(graffitiCell('banner', i), (w, h) => {
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
  inCell(graffitiCell('grime', 0), (w, h) => {
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
