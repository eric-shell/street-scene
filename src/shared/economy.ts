/**
 * What garage parts cost: a price in points (the ledger, shared/points.ts) for every catalog part, and how many
 * finished races (shared/stats.ts) unlock buying it, by slot. One `as const` table, so balancing is one edit
 * here and docs/economy.md says why the numbers are what they are.
 *
 * Scale: a race's points come from the nitrous callouts (a full stage is 1,000; a decent race pays about three
 * thousand), so the cheapest wheel is about two races of points and the dearest body kit ten to fifteen. Inside a
 * slot the price spreads with how much part there is, read off the catalog entry rather than set by hand (its
 * triangles against the slot's budget, a multi-piece wheel's bolted lip and barrel on top), so a new part is
 * priced the moment it is catalogued and two catalogs give the same prices. Every price is rounded to 50.
 *
 * Parts are bought, and so are the body features (fog lights, shaved markers ...): one price for all of them
 * (`ECONOMY.features`), above every bumper and fender part. Paint, calipers, wheel trims, stance, tires, tint, underglow, pops and the setup sliders
 * are the garage's free hand from race 0; so are stock (a car's own wheel, its stock body pieces, no spoiler).
 * With FEATURES.economy off everything is free, unlocked and owned, and the garage shows no prices: the game plays
 * as it did before the economy.
 */
import catalogJson from '../assets/partsCatalog.json';
import manifestJson from '../assets/carManifest.json';
import { FEATURES } from './features';
import { SLOT_LABELS, TRI_BUDGETS, type PartEntry, type PartSlot, type PartsCatalog } from './parts';
import type { BodyFeature } from './carBuild';
import { racesForUnlocks, type StatsSave } from './stats';

/** Per slot: the price at no triangles (points), how far the triangle budget spreads it (x base at the full budget) and the races that unlock it. */
export const ECONOMY = {
  slots: {
    // Wheels are the first thing to buy: the cheapest after two races, the dearest multi-piece after three.
    wheels: { base: 5000, spread: 0.4, unlock: 1 },
    // The small trim first: mirrors with the wheels, then exhausts, splitters and canards with the skirts.
    mirrors: { base: 3000, spread: 0.3, unlock: 1 },
    exhaust: { base: 5000, spread: 0.3, unlock: 3 },
    splitter: { base: 6000, spread: 0.3, unlock: 3 },
    canards: { base: 5500, spread: 0.3, unlock: 3 },
    // Skirts and bumpers: the first body pieces, a few races in.
    sideSkirts: { base: 6000, spread: 0.3, unlock: 3 },
    frontBumper: { base: 8000, spread: 0.3, unlock: 3 },
    rearBumper: { base: 7000, spread: 0.3, unlock: 3 },
    // The aero and the panels: spoilers, hoods and roofs (wings, scoops), a few more races on.
    diffuser: { base: 7000, spread: 0.3, unlock: 6 },
    fenders: { base: 9000, spread: 0.3, unlock: 6 },
    hood: { base: 10000, spread: 0.3, unlock: 6 },
    roof: { base: 9000, spread: 0.3, unlock: 6 },
    spoiler: { base: 11000, spread: 0.3, unlock: 6 },
    // A whole body kit is the big buy: ten races to unlock, ten to fifteen races of points.
    body: { base: 32000, spread: 0.4, unlock: 10 },
  },
  /**
   * Every body feature (BODY_FEATURES) costs this (points) and unlocks after this many races. One price: a
   * feature is a switch on a part the car already has, so it is priced above every bumper and fender part
   * (about five races of points), not by triangles.
   */
  features: { price: 15000, unlock: 6 },
  /** A multi-piece wheel (a bolted lip and barrel round its face) costs this much more than a one-piece of the same size. */
  multiPiece: 1.25,
  /** Every price is a multiple of this (points). */
  round: 50,
  /** What is never bought, from race 0 (documentation; the garage simply never prices these tabs). */
  free: ['paint', 'calipers', 'wheel trims', 'stance', 'tires', 'tint', 'underglow', 'pops and bangs', 'setup'],
} as const satisfies {
  slots: Record<PartSlot, { base: number; spread: number; unlock: number }>;
  features: { price: number; unlock: number };
  multiPiece: number;
  round: number;
  free: readonly string[];
};

const CATALOG = catalogJson as unknown as PartsCatalog;
const STOCK_WHEELS = new Map((manifestJson as unknown as { cars: { id: string; defaultWheel: string }[] }).cars.map((c) => [c.id, c.defaultWheel]));

/** A catalog part by id (undefined for an id the catalog lacks, a dev preview's included). */
export const catalogPart = (id: string): PartEntry | undefined => CATALOG.parts.find((p) => p.id === id);

/** The wheel a car ships on (free on that car: it is its stock wheel). */
export const stockWheel = (carId: string): string | undefined => STOCK_WHEELS.get(carId);

/** Whether a part is what the car ships with: free and owned on it whatever the ledger says. */
export const isStock = (carId: string, partId: string): boolean => stockWheel(carId) === partId;

/** A part's price in points (0: free). On `carId`'s own stock wheel, 0. */
export function priceOf(part: PartEntry, carId?: string): number {
  if (!FEATURES.economy || (carId && isStock(carId, part.id))) return 0;
  const s = ECONOMY.slots[part.slot];
  const fill = Math.min(1, Math.max(0, part.tris / TRI_BUDGETS[part.slot]));
  const multi = part.slot === 'wheels' && part.construction === 'multi' ? ECONOMY.multiPiece : 1;
  return Math.round((s.base * (1 + s.spread * fill) * multi) / ECONOMY.round) * ECONOMY.round;
}

/** Races finished that unlock buying a part (0 with the economy off). */
export const unlockRaces = (part: PartEntry): number => (FEATURES.economy ? ECONOMY.slots[part.slot].unlock : 0);

/** Races still to finish before a part can be bought (0: unlocked). */
export const racesToUnlock = (part: PartEntry, stats: StatsSave): number => Math.max(0, unlockRaces(part) - racesForUnlocks(stats));

/** Whether the races finished unlock buying a part. */
export const isUnlocked = (part: PartEntry, stats: StatsSave): boolean => racesToUnlock(part, stats) === 0;

/** Something the garage sells, part or feature: what the buy dialog and `buyItem` need, whichever it is. */
export interface Buyable {
  /** Its ledger id (a part's catalog id, or `feature.<name>`). */
  id: string;
  /** Its name for a dialog ("Euro front bumper", "Fog lights"). */
  name: string;
  /** Price (points; 0: free). */
  price: number;
  /** Races finished that unlock buying it (0: unlocked from the start). */
  unlock: number;
}

/** A part as something to buy for `carId`; the name reads "Yari wheels" or "Euro front bumper". */
export function partBuyable(part: PartEntry, carId?: string): Buyable {
  const name = part.slot === 'wheels' ? `${part.displayName} wheels` : `${part.displayName} ${SLOT_LABELS[part.slot].toLowerCase()}`;
  return { id: part.id, name, price: priceOf(part, carId), unlock: unlockRaces(part) };
}

/** A body feature's ledger id, stored beside the part ids in `purchases.v1`. */
export const featureId = (f: BodyFeature): string => `feature.${f}`;

/** A feature's price in points (0: free with the economy off). One price for every feature. */
export const featurePrice = (): number => (FEATURES.economy ? ECONOMY.features.price : 0);

/** Races finished that unlock buying a feature (0 with the economy off). */
export const featureUnlockRaces = (): number => (FEATURES.economy ? ECONOMY.features.unlock : 0);

/** Races still to finish before a feature can be bought (0: unlocked). */
export const featureRacesToUnlock = (stats: StatsSave): number => Math.max(0, featureUnlockRaces() - racesForUnlocks(stats));

/** A feature as something to buy; `label` is its name (carBuild.ts FEATURE_LABELS). */
export const featureBuyable = (f: BodyFeature, label: string): Buyable => ({ id: featureId(f), name: label, price: featurePrice(), unlock: featureUnlockRaces() });
