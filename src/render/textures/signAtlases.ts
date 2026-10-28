/**
 * Sign atlases: the podiums' neon name signs (cityMeshes) and the hanging blade signs (wallDressing), white
 * glyphs on dark panels so each sign tints its own with vertex colors. The name pools are large and a seed
 * draws its own share of them for the atlas's fixed cells (cityMood.pickSubset), so the canvases keep their
 * size and build time while no two cities carry the same signs. A Miami home swaps some of those cells for
 * hotel names (cityIdentity.ts `hotels`), so a fifth of its podium neon reads as the strip's hotels.
 */
import type * as THREE from 'three';
import { canvas, canvasTex, fitFont } from './canvasKit';
import { pickSubset } from './cityMood';
import { cityIdentity } from '../cityIdentity';

/** The neon signs on the podiums (cityMeshes): the pool a seed draws SIGN_SLOTS names from. At most 16 characters so a 512 px cell stays readable. */
export const SIGN_NAMES = [
  'NEON NOODLE', 'KAIJU KARAOKE', 'MIDNIGHT TUNE', 'ZERO AUTO', 'LUCKY 7', 'SAKURA BAR',
  'TURBO TACO', 'CYBER CAFE', 'VOLT MOTORS', 'NIGHT OWL', 'RAMEN 24H', 'HOTEL ORBIT',
  'STARLITE', 'DRIFT CLUB', 'PIXEL ARCADE', 'BLUE LOTUS', 'GOLDEN DRAGON', 'APEX GARAGE',
  'CHROME DINER', 'OKAMI SUSHI', 'HYPER MART', 'LASER BOWL', 'ROXY', 'MOTEL 99',
  'SUDS & DUDS', 'WASH N FOLD 24H', 'BODEGA ESTRELLA', 'TATTOO PARLOR', 'INK & IRON', 'VINYL VAULT',
  'SPIN CYCLE RECORDS', 'DUMPLING HOUSE', 'NOODLE BAR 9', 'PAWN KING', 'BAIL BONDS 24H', 'FAST BAIL',
  'SLEEPY PALMS MOTEL', 'VACANCY', 'BASS DEPOT', 'CAR AUDIO PLUS', 'TIRE BARN', 'RETREAD ROY',
  'SING-A-LONG', 'KARAOKE BOX', 'RX 24 HOUR', 'NIGHT PHARMACY', 'TAQUERIA LUNA', 'EL GATO NEGRO',
  'PET PALACE', 'PAWS & CLAWS', 'SPINE TIME CHIRO', 'CRACK & ADJUST', 'CHECKS CASHED', 'CASH N GO',
  'LIQUOR & LOTTO', 'DONUT HOLE', 'SLICE OF HEAVEN', 'GREASE SPOON', 'ALL NIGHT DINER', 'COFFEE & PIE',
  'BARBER 1 CHAIR', 'FADE CITY', 'NAILS NAILS NAILS', 'PSYCHIC READINGS', 'FORTUNES 5 USD', 'CIGARS',
  'GUITAR GRAVEYARD', 'HI-FI HEAVEN', 'ARCADE ZONE', 'BILLIARDS', 'BOWL-O-RAMA', 'SKATE SHOP',
  'BIKE DOCTOR', 'JUNK & JEWELS', 'WIGS WIGS WIGS', 'LOCKSMITH 24H', 'TOWING 24H', 'AUTO GLASS',
  'SMOG CHECK', 'OIL CHANGE', 'BODY SHOP', 'HOT SAKE', 'TIKI TORCH', 'THE LAST CALL',
  'ROUTE 66 BAR', 'BLUE MOON LOUNGE', 'COCKTAILS', 'GYRO KING', 'FALAFEL HUT', 'PHO REAL',
  'HOT POT HOUSE', 'BANH MI BROS', 'CURRY IN A HURRY', 'JERK SHACK', 'WINGS & THINGS', 'BURGER JOINT',
  'FRY GUYS', 'ICE CREAM', 'LAUNDRY LOUNGE', 'DRY CLEAN 1 HR', 'TAILOR', 'SHOE REPAIR',
  'COPY CENTER', 'PHONE FIXED FAST', 'VIDEO RENTAL', 'COMIC CAVE', 'CAT CAFE', 'OPEN LATE',
];
/** The deco hotels a Miami home names on its podium signs (at most 16 characters). */
export const HOTEL_SIGN_NAMES = [
  'HOTEL FLAMINGO', 'THE CARDOZA', 'HOTEL BREAKWATER', 'OCEAN HOTEL', 'HOTEL SOLEIL', 'THE PELICAN',
  'CARLYLE HOTEL', 'HOTEL AZUL', 'THE COLONY', 'HOTEL LEONARD', 'THE ESSEX', 'PARK CENTRAL',
];
export const SIGN_ATLAS_COLS = 4;
export const SIGN_ATLAS_ROWS = 6;
/** Cells in the sign atlas: how many of the pool's names a city carries. */
export const SIGN_SLOTS = SIGN_ATLAS_COLS * SIGN_ATLAS_ROWS;

/** Rows of the sign atlas with `extra` neighbourhood shop names (hoodBrands.ts) after the seed's SIGN_SLOTS pool names. */
export function signAtlasRows(extra: number): number {
  return SIGN_ATLAS_ROWS + Math.ceil(extra / SIGN_ATLAS_COLS);
}

/**
 * White neon text on dark panels; tinted per sign with vertex colors. The seed picks which pool names fill the
 * first SIGN_SLOTS cells; `extra` (the neighbourhoods' own shops, textures/hoodBrands.ts) fill the cells after.
 */
export function makeSignAtlas(seed: number, extra: readonly string[] = []): THREE.Texture {
  const cw = 512;
  const chh = 128;
  const [c, ctx] = canvas(cw * SIGN_ATLAS_COLS, chh * signAtlasRows(extra.length));
  const names = pickSubset(SIGN_NAMES, SIGN_SLOTS, seed, 'signNames');
  const hotels = cityIdentity(seed).signature.hotels;
  if (hotels) names.splice(0, hotels.signs, ...pickSubset(HOTEL_SIGN_NAMES, hotels.signs, seed, 'hotelSigns'));
  [...names, ...extra].forEach((name, i) => {
    const x = (i % SIGN_ATLAS_COLS) * cw;
    const y = Math.floor(i / SIGN_ATLAS_COLS) * chh;
    ctx.fillStyle = '#0b0b10';
    ctx.fillRect(x, y, cw, chh);
    ctx.strokeStyle = '#fff';
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 14;
    ctx.lineWidth = 5;
    ctx.strokeRect(x + 10, y + 10, cw - 20, chh - 20);
    fitFont(ctx, name, cw - 60, 70, (px) => `bold ${px}px "Arial Black", Impact, sans-serif`, 20, 4);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowBlur = 22;
    ctx.fillText(name, x + cw / 2, y + chh / 2 + 4);
    ctx.shadowBlur = 0;
  });
  return canvasTex(c, { repeat: false });
}

/** Hanging blade signs: the pool a seed draws BLADE_SLOTS words from. Short (at most 7 letters) so the 170 px cell keeps them big. */
export const BLADE_SIGN_TEXTS = [
  'BAR', 'HOTEL', 'PIZZA', 'TATTOO', '24H', 'LIQUOR', 'RAMEN', 'LIVE', 'DINER', 'LAUNDRY', 'PAWN', 'TEA',
  'MOTEL', 'BAIL', 'TACOS', 'DELI', 'VINYL', 'RECORDS', 'NOODLES', 'DIM SUM', 'KARAOKE', 'PHARMACY', 'CHECKS', 'CASH',
  'PETS', 'CHIRO', 'TIRES', 'AUDIO', 'REPAIR', 'BODEGA', 'COFFEE', 'DONUTS', 'WINGS', 'BURGERS', 'SUSHI', 'CURRY',
  'PHO', 'GYROS', 'COCKTAIL', 'LOUNGE', 'ARCADE', 'POOL', 'BOWLING', 'BARBER', 'NAILS', 'WIGS', 'PSYCHIC', 'LOCKS',
  'TOWING', 'GLASS', 'SMOG', 'TAILOR', 'COPIES', 'COMICS', 'BOOKS', 'SKATE', 'BIKES', 'OPEN', 'VACANCY', 'ROOMS',
];
export const BLADE_SIGN_COLS = 6;
export const BLADE_SIGN_ROWS = 2;
/** Cells in the blade atlas. */
export const BLADE_SLOTS = BLADE_SIGN_COLS * BLADE_SIGN_ROWS;

/** Hanging blade signs: white glyphs on a dark panel, tinted per sign by vertex colours. The seed picks the words. */
export function makeBladeSignAtlas(seed: number): THREE.Texture {
  const cw = 170;
  const ch = 128;
  const [c, ctx] = canvas(cw * BLADE_SIGN_COLS, ch * BLADE_SIGN_ROWS);
  pickSubset(BLADE_SIGN_TEXTS, BLADE_SLOTS, seed, 'bladeTexts').forEach((text, i) => {
    const x = (i % BLADE_SIGN_COLS) * cw;
    const y = Math.floor(i / BLADE_SIGN_COLS) * ch;
    ctx.fillStyle = '#0b0b10';
    ctx.fillRect(x + 4, y + 4, cw - 8, ch - 8);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 10, y + 10, cw - 20, ch - 20);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, text, cw - 36, 56, (px) => `900 ${px}px Impact, "Arial Black", sans-serif`, 18, 3);
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x + cw / 2, y + ch / 2 + 2);
    ctx.shadowBlur = 0;
  });
  return canvasTex(c, { repeat: false });
}
