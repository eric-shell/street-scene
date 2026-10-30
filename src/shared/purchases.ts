/**
 * Which parts the player owns, per car model: `purchases.v1` is `{ [carId]: partId[] }`. A part bought for a car
 * belongs to that model, for every build of it in the garage however many slots hold one, and to no other model
 * (a wheel fits every car, but it is bought per car, as a set for that car). Synced by an account
 * (account/cloudSave.ts); ownership only grows, so two devices merge by union.
 *
 * The rule the garage, share codes, cloud saves and race starts all enforce (`enforceOwnership`): a build only
 * wears parts owned for its car, so a pasted code, a stale or tampered save, or a car switch can never equip
 * what was not bought. Stock (a car's own wheel, its stock body, no spoiler) is always owned.
 *
 * Grandfathering (`startLedger`): the first time the economy runs on a device with no `purchases.v1` saved, every
 * part the garage's builds wear is recorded as owned for its car, so nobody loses what they had before parts
 * cost points. From then on the ledger exists and only purchases add to it.
 *
 * Visual only: the sim never reads ownership (a build's performance half is free), and nothing here touches a
 * race. With FEATURES.economy off every part is owned and nothing is recorded.
 */
import { loadJson, loadText, saveJson } from './store';
import { FEATURES } from './features';
import { PART_SLOTS, SLOT_LABELS, type PartEntry, type PartSlot } from './parts';
import type { CarBuild, VisualBuild } from './carBuild';
import { catalogPart, isStock, isUnlocked, priceOf } from './economy';
import { spendPoints } from './points';
import { loadStats, type StatsSave } from './stats';

/** The store key (without the `nightrun.` prefix). */
export const PURCHASES_KEY = 'purchases.v1';

/** The saved document: the part ids owned, per car id. */
export type PurchasesSave = Record<string, string[]>;

const ID = /^[A-Za-z0-9_\-.]{1,64}$/;

/** A save from storage or another device, cleaned: ids deduplicated and sorted, anything malformed dropped. */
export function cleanPurchases(v: unknown): PurchasesSave {
  const out: PurchasesSave = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [car, list] of Object.entries(v as Record<string, unknown>)) {
    if (!ID.test(car) || !Array.isArray(list)) continue;
    const ids = [...new Set(list.filter((x): x is string => typeof x === 'string' && ID.test(x)))].sort();
    if (ids.length) out[car] = ids;
  }
  return out;
}

/** The saved purchases ({} when none). */
export function loadPurchases(): PurchasesSave {
  return cleanPurchases(loadJson<unknown>(PURCHASES_KEY, null));
}

/** Whether this device has started its ledger (grandfathered its garage, or bought something). */
export const hasLedger = (): boolean => loadText(PURCHASES_KEY) !== null;

/** Two saves merged: every part either owns, per car (cars and ids sorted, so equal sets compare equal as JSON). */
export function mergePurchases(a: unknown, b: unknown): PurchasesSave {
  const x = cleanPurchases(a);
  const y = cleanPurchases(b);
  const out: PurchasesSave = {};
  for (const car of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) out[car] = [...new Set([...(x[car] ?? []), ...(y[car] ?? [])])].sort();
  return out;
}

/** How many parts are owned, every car added up (stock not counted). */
export const ownedCount = (p: PurchasesSave = loadPurchases()): number => Object.values(p).reduce((n, ids) => n + ids.length, 0);

/** Whether `carId` may wear `partId`: stock, free, a dev preview, or bought for that car. */
export function owns(carId: string, partId: string, saved: PurchasesSave = loadPurchases()): boolean {
  if (!FEATURES.economy || isStock(carId, partId)) return true;
  // A part dropped in with the dev tools lives only in this session; it is never priced.
  if (partId.startsWith('dev_')) return FEATURES.devTools;
  const part = catalogPart(partId);
  if (part && priceOf(part, carId) === 0) return true;
  return saved[carId]?.includes(partId) ?? false;
}

/** A part a build wears: its slot, id and whether it is the rear axle's own wheel (`wheels.rearPart`). */
export interface WornPart {
  slot: PartSlot;
  id: string;
  rear: boolean;
  /** Its name for a dialog ("Yari wheels (rear)"). */
  name: string;
}

const partName = (slot: PartSlot, id: string, rear: boolean): string => {
  const p = catalogPart(id);
  const base = p ? (slot === 'wheels' ? `${p.displayName} wheels` : `${p.displayName} ${SLOT_LABELS[slot].toLowerCase()}`) : `${SLOT_LABELS[slot]} (${id})`;
  return rear ? `${base} (rear)` : base;
};

/** Every non-stock part a look wears, the rear wheel included when it has its own. */
export function wornParts(v: VisualBuild): WornPart[] {
  const out: WornPart[] = [];
  for (const slot of PART_SLOTS) {
    const id = v.parts[slot];
    if (typeof id === 'string') out.push({ slot, id, rear: false, name: partName(slot, id, false) });
  }
  const rear = v.wheels.rearPart;
  if (rear && rear !== v.parts.wheels) out.push({ slot: 'wheels', id: rear, rear: true, name: partName('wheels', rear, true) });
  return out;
}

/** The parts a look wears that `carId` does not own. */
export function unownedParts(v: VisualBuild, carId: string): WornPart[] {
  const saved = loadPurchases();
  return wornParts(v).filter((w) => !owns(carId, w.id, saved));
}

/** Takes worn parts off a look: each slot back to stock (or none), a rear wheel back to following the front. */
export function stripParts(v: VisualBuild, parts: readonly WornPart[]): void {
  for (const w of parts) {
    if (w.rear) v.wheels.rearPart = null;
    else delete v.parts[w.slot];
  }
}

/**
 * Strips the parts a build wears that its car does not own back to stock (or none), in place, and says what went.
 * Applied to imported share codes (with a dialog), to the garage as it loads (quietly: a cloud save lands in
 * storage before the load) and to the player's look at a race start (defensively).
 */
export function enforceOwnership(build: CarBuild): WornPart[] {
  if (!FEATURES.economy) return [];
  const gone = unownedParts(build.visual, build.carId);
  stripParts(build.visual, gone);
  return gone;
}

/**
 * Starts this device's ledger once: with no `purchases.v1` saved, every part the builds wear is recorded as owned
 * for its car (grandfathering what was equipped before parts cost points). True when it wrote the ledger.
 */
export function startLedger(builds: readonly CarBuild[]): boolean {
  if (!FEATURES.economy || hasLedger()) return false;
  return saveJson(PURCHASES_KEY, grandfathered(builds));
}

/** The ledger that grandfathers every part the builds wear, each for its build's car. */
export function grandfathered(builds: readonly CarBuild[]): PurchasesSave {
  const owned: PurchasesSave = {};
  for (const b of builds) for (const w of wornParts(b.visual)) if (!w.id.startsWith('dev_')) (owned[b.carId] ??= []).push(w.id);
  return cleanPurchases(owned);
}

/** What a buy came to: bought (points spent, part owned), already owned, still locked, or the balance was short. */
export type BuyResult = 'bought' | 'owned' | 'locked' | 'short';

/** Buys a part for a car: checks it is unlocked and affordable, spends its price and records it. */
export function buy(carId: string, part: PartEntry, stats: StatsSave = loadStats()): BuyResult {
  const saved = loadPurchases();
  if (owns(carId, part.id, saved)) return 'owned';
  if (!isUnlocked(part, stats)) return 'locked';
  if (!spendPoints(priceOf(part, carId))) return 'short';
  saveJson(PURCHASES_KEY, mergePurchases(saved, { [carId]: [part.id] }));
  return 'bought';
}
