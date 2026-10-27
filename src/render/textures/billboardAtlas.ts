/**
 * The rooftop billboard atlas (buildings/roofs.ts): fake-brand ads, 4:1 cells, drawn per seed. Each cell is a
 * brand from a large pool in a palette from a larger one, laid out by one of four templates (headline and
 * tag, a logo blob, a phone number, a split board), so two cities never share their boards. The canvas is
 * 1024 x 1024 (16 cells of 512 x 128, the size a cell always was) and builds in a few milliseconds; the last
 * two seeds are kept so the menu city and a race reuse it.
 */
import type * as THREE from 'three';
import { Rng, deriveSeed } from '../../sim/prng';
import { canvas, canvasTex, fitFont } from './canvasKit';

export const BILLBOARD_COLS = 2;
export const BILLBOARD_ROWS = 8;

interface Brand {
  text: string;
  sub: string;
}

/** Fake brands in the game's world: names at most about 13 characters, a tag line, no real companies. */
const BRANDS: readonly Brand[] = [
  { text: 'NITRO COLA', sub: 'TASTE THE BOOST' }, { text: 'MIDNIGHT FM', sub: '104.7  ALL NIGHT' },
  { text: 'HYPERION', sub: 'PERFORMANCE TIRES' }, { text: 'VOLT', sub: 'ENERGY DRINK' },
  { text: 'SUNSET MOTEL', sub: 'VACANCY  POOL  TV' }, { text: 'APEX', sub: 'TUNING  DYNO  WRAPS' },
  { text: 'CHROME DINER', sub: 'OPEN 24 HOURS' }, { text: 'PALM BEACH', sub: 'FLY TONIGHT' },
  { text: 'LUCKY STAR', sub: 'CASINO & LOUNGE' }, { text: 'ORBIT', sub: 'THE NEW PHONE' },
  { text: 'BAIL BONDS', sub: 'WE NEVER CLOSE' }, { text: 'SUDS & DUDS', sub: 'LAUNDRY  24 HOURS' },
  { text: 'NOODLE BAR', sub: 'SLURP RESPONSIBLY' }, { text: 'DUMPLING HQ', sub: 'STEAMED TILL DAWN' },
  { text: 'PAWN KING', sub: 'WE BUY ANYTHING' }, { text: 'TIRE BARN', sub: 'FOUR FOR THREE' },
  { text: 'BASS DEPOT', sub: 'CAR AUDIO  SUBS' }, { text: 'SPINE TIME', sub: 'CHIROPRACTIC' },
  { text: 'CASH N GO', sub: 'CHECKS CASHED' }, { text: 'PET PALACE', sub: 'FOOD  TOYS  FISH' },
  { text: 'TAQUERIA LUNA', sub: 'TACOS AL PASTOR' }, { text: 'RX 24', sub: 'PHARMACY NEVER SLEEPS' },
  { text: 'KARAOKE BOX', sub: 'PRIVATE ROOMS' }, { text: 'VINYL VAULT', sub: 'BUY  SELL  SPIN' },
  { text: 'INK & IRON', sub: 'TATTOO  WALK INS' }, { text: 'DONUT HOLE', sub: 'FRESH AT 3 AM' },
  { text: 'JET FUEL', sub: 'COFFEE  STRONG' }, { text: 'GRIDLOCK', sub: 'TRAFFIC UPDATES' },
  { text: 'CITY CAB', sub: 'RIDE NOW' }, { text: 'DREAMLAND', sub: 'MATTRESS OUTLET' },
  { text: 'ELECTRA', sub: 'FAST CHARGE' }, { text: 'BIG SLICE', sub: 'PIZZA BY THE YARD' },
  { text: 'LOTTO MAX', sub: 'FEELING LUCKY' }, { text: 'SKYLINE', sub: 'LUXURY LOFTS' },
  { text: 'IRONWORKS', sub: 'GYM  OPEN 24' }, { text: 'WAVELENGTH', sub: 'RADIO FOR INSOMNIACS' },
  { text: 'SMOKE SHOW', sub: 'BARBECUE' }, { text: 'FLASHBULB', sub: 'PHOTO BOOTH' },
  { text: 'OIL & GAS', sub: 'FILL UP  MOVE ON' }, { text: 'HOT SAKE', sub: 'SUSHI TILL LATE' },
  { text: 'RETREAD ROY', sub: 'TIRES AND TALL TALES' }, { text: 'GOLDEN LOTUS', sub: 'DIM SUM DAILY' },
  { text: 'FAST BAIL', sub: 'CALL BEFORE YOU WALK' }, { text: 'CRACKERJACK', sub: 'PAWN  LOANS' },
  { text: 'MOON PIE', sub: 'DESSERT DINER' }, { text: 'NIGHT SHIFT', sub: 'STAFFING' },
  { text: 'GLOW', sub: 'NEON REPAIR' }, { text: 'STATIC', sub: 'TV  RADIO  REPAIR' },
];

interface Palette {
  bg: [string, string];
  fg: string;
  accent: string;
}

const PALETTES: readonly Palette[] = [
  { bg: ['#b3001b', '#ff3d3d'], fg: '#fff', accent: '#ffe14d' },
  { bg: ['#1a0b3d', '#5a1fa8'], fg: '#ff4fd8', accent: '#22e6ff' },
  { bg: ['#0b0b0f', '#30323c'], fg: '#ffd400', accent: '#ffffff' },
  { bg: ['#003b2f', '#00b894'], fg: '#eaff00', accent: '#ffffff' },
  { bg: ['#ff7a18', '#af002d'], fg: '#fff3d6', accent: '#ffe14d' },
  { bg: ['#04243f', '#0a6bd6'], fg: '#ffffff', accent: '#19e6ff' },
  { bg: ['#e8e8ee', '#9aa0ad'], fg: '#c4002b', accent: '#111111' },
  { bg: ['#00c6cf', '#ff6fb5'], fg: '#ffffff', accent: '#fff6a8' },
  { bg: ['#2a0000', '#7a0010'], fg: '#ffcf3d', accent: '#ff3b6b' },
  { bg: ['#000000', '#1b1b2a'], fg: '#ffffff', accent: '#a66bff' },
  { bg: ['#2b0a3d', '#d6246e'], fg: '#fff0f5', accent: '#ffd23f' },
  { bg: ['#0f2e1b', '#4f9d2d'], fg: '#fffbe0', accent: '#ff6b35' },
  { bg: ['#141414', '#e63946'], fg: '#ffffff', accent: '#f1fa8c' },
  { bg: ['#fff1c9', '#f2a541'], fg: '#2d1b69', accent: '#d7263d' },
  { bg: ['#0b1d3a', '#1d3f72'], fg: '#ffcf33', accent: '#ff5a5f' },
  { bg: ['#f5f5f0', '#c9d6df'], fg: '#0a2540', accent: '#e63946' },
];

type Ctx = CanvasRenderingContext2D;
type Draw = (g: Ctx, x: number, y: number, ad: Brand, p: Palette, rng: Rng, phone: string) => void;

const CW = 512;
const CH = 128;
const HEAD = (px: number) => `900 ${px}px Impact, "Arial Black", sans-serif`;
const TAG = (px: number) => `700 ${px}px "Arial Black", sans-serif`;

function ground(g: Ctx, x: number, y: number, p: Palette): void {
  const grd = g.createLinearGradient(x, y, x + CW, y + CH);
  grd.addColorStop(0, p.bg[0]);
  grd.addColorStop(1, p.bg[1]);
  g.fillStyle = grd;
  g.fillRect(x, y, CW, CH);
}

/** Headline and tag with a bold shape on the right for the eye at distance: a disc, a sweep or a stripe. */
const headlineTag: Draw = (g, x, y, ad, p, rng) => {
  ground(g, x, y, p);
  g.save();
  g.beginPath();
  g.rect(x, y, CW, CH);
  g.clip();
  g.fillStyle = p.accent;
  g.globalAlpha = 0.85;
  const shape = rng.int(0, 2);
  if (shape === 0) {
    g.beginPath();
    g.arc(x + CW - 70, y + CH / 2, 48, 0, Math.PI * 2);
    g.fill();
  } else if (shape === 1) {
    g.beginPath();
    g.moveTo(x + CW - 170, y + CH);
    g.lineTo(x + CW - 90, y);
    g.lineTo(x + CW - 60, y);
    g.lineTo(x + CW - 140, y + CH);
    g.fill();
  } else {
    g.fillRect(x, y + CH - 18, CW, 8);
  }
  g.restore();
  g.globalAlpha = 1;
  g.fillStyle = p.fg;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  fitFont(g, ad.text, CW - 150, 64, HEAD, 24, 3);
  g.fillText(ad.text, x + 22, y + 78);
  fitFont(g, ad.sub, CW - 150, 22, TAG, 12, 1);
  g.globalAlpha = 0.9;
  g.fillText(ad.sub, x + 24, y + 108);
  g.globalAlpha = 1;
};

/** A round logo blob with the brand's initial on the left, the name big beside it, the tag under. */
const logoBlob: Draw = (g, x, y, ad, p) => {
  ground(g, x, y, p);
  g.fillStyle = p.accent;
  g.beginPath();
  g.arc(x + 64, y + CH / 2, 46, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = p.bg[0];
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = HEAD(68);
  g.fillText(ad.text[0], x + 64, y + CH / 2 + 4);
  g.fillStyle = p.fg;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  fitFont(g, ad.text, CW - 150, 58, HEAD, 22, 3);
  g.fillText(ad.text, x + 126, y + 70);
  fitFont(g, ad.sub, CW - 150, 20, TAG, 11, 1);
  g.fillText(ad.sub, x + 128, y + 104);
};

/** The name across the top, a phone number set huge underneath. */
const phoneNumber: Draw = (g, x, y, ad, p, _rng, phone) => {
  ground(g, x, y, p);
  g.fillStyle = p.accent;
  g.fillRect(x, y + 56, CW, 4);
  g.fillStyle = p.fg;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  fitFont(g, ad.text, CW - 40, 44, HEAD, 20, 3);
  g.fillText(ad.text, x + CW / 2, y + 46);
  g.fillStyle = p.accent;
  fitFont(g, phone, CW - 40, 62, HEAD, 28, 3);
  g.fillText(phone, x + CW / 2, y + 114);
};

/** Two flat tones split on a slant: the name on the dark half, the tag on the light one. */
const splitBoard: Draw = (g, x, y, ad, p) => {
  g.fillStyle = p.bg[0];
  g.fillRect(x, y, CW, CH);
  g.fillStyle = p.accent;
  g.beginPath();
  g.moveTo(x + CW * 0.58, y);
  g.lineTo(x + CW, y);
  g.lineTo(x + CW, y + CH);
  g.lineTo(x + CW * 0.46, y + CH);
  g.fill();
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillStyle = p.fg;
  fitFont(g, ad.text, CW * 0.5, 54, HEAD, 20, 3);
  g.fillText(ad.text, x + 20, y + CH / 2 + 2);
  g.fillStyle = p.bg[0];
  g.textAlign = 'center';
  fitFont(g, ad.sub, CW * 0.38, 20, TAG, 10, 1);
  g.fillText(ad.sub, x + CW * 0.8, y + CH / 2 + 2, CW * 0.38);
};

const TEMPLATES: readonly Draw[] = [headlineTag, logoBlob, phoneNumber, splitBoard];

function makeBillboards(seed: number): THREE.CanvasTexture {
  const rng = new Rng(deriveSeed(seed, 'roofAds'));
  const [c, g] = canvas(CW * BILLBOARD_COLS, CH * BILLBOARD_ROWS);
  const brands = rng.shuffle(BRANDS.slice());
  const palettes = rng.shuffle(PALETTES.slice());
  for (let k = 0; k < BILLBOARD_COLS * BILLBOARD_ROWS; k++) {
    const x = (k % BILLBOARD_COLS) * CW;
    const y = Math.floor(k / BILLBOARD_COLS) * CH;
    const template = TEMPLATES[rng.int(0, TEMPLATES.length - 1)];
    const phone = `555-${String(rng.int(0, 9999)).padStart(4, '0')}`;
    g.save();
    g.beginPath();
    g.rect(x, y, CW, CH);
    g.clip();
    template(g, x, y, brands[k % brands.length], palettes[k % palettes.length], rng, phone);
    g.restore();
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 6;
    g.strokeRect(x + 3, y + 3, CW - 6, CH - 6);
  }
  const t = canvasTex(c, { repeat: false });
  return t;
}

const cache: { seed: number; tex: THREE.CanvasTexture }[] = [];

/** The seed's billboard atlas, drawn on first use. Like the shared facade atlas, nobody disposes it. */
export function billboardAtlas(seed: number): THREE.CanvasTexture {
  const hit = cache.find((e) => e.seed === seed);
  if (hit) return hit.tex;
  const tex = makeBillboards(seed);
  cache.push({ seed, tex });
  if (cache.length > 2) cache.shift();
  return tex;
}
