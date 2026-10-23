/**
 * Shared vocabulary for the parts slot system. Pure data, used by the
 * renderer, the garage, build validation and the asset scripts.
 */

/** Every swappable visible piece lives in one of these slots. Add new slots here. */
export const PART_SLOTS = ['body', 'frontBumper', 'rearBumper', 'sideSkirts', 'spoiler', 'hood', 'roof', 'wheels'] as const;
export type PartSlot = (typeof PART_SLOTS)[number];

/** Slots shown as body part menus in the garage (body and wheels have their own menus). */
export const BODY_PART_SLOTS: PartSlot[] = ['frontBumper', 'rearBumper', 'sideSkirts', 'spoiler', 'hood', 'roof'];

/** Slots where "none" is a valid choice (nothing rendered, base meshes still visible unless hidden). */
export const OPTIONAL_SLOTS: PartSlot[] = ['spoiler'];

export const SLOT_LABELS: Record<PartSlot, string> = {
  body: 'Body kit',
  frontBumper: 'Front bumper',
  rearBumper: 'Rear bumper',
  sideSkirts: 'Side skirts',
  spoiler: 'Spoiler',
  hood: 'Hood',
  roof: 'Roof',
  wheels: 'Wheels',
};

/**
 * Shared material names. Source assets are renamed to these during import and
 * new parts must use them, so paint, trim and tint apply automatically.
 */
export const MATERIAL_NAMES = ['Paint', 'Trim', 'Black', 'Chrome', 'Glass', 'Rim', 'Tire', 'HeadLight', 'TailLight', 'Light', 'Interior', 'Grille'] as const;
export type MaterialName = (typeof MATERIAL_NAMES)[number];

/** Triangle budgets per slot used by validation. */
export const TRI_BUDGETS: Record<PartSlot, number> = {
  body: 12000,
  frontBumper: 3000,
  rearBumper: 3000,
  sideSkirts: 2000,
  spoiler: 1500,
  hood: 2000,
  roof: 2000,
  wheels: 12000,
};

export interface PartEntry {
  id: string;
  displayName: string;
  /** Car id, or "universal" (wheels). */
  carId: string;
  slot: PartSlot;
  /** Path under public/, e.g. "parts/proto_frontBumper_street.glb". */
  file: string;
  /** Optional node name inside `file` when several parts share one GLB. */
  node?: string;
  /** Base car mesh names to hide while this part is equipped. */
  hides: string[];
  materialSlots: MaterialName[];
  tris: number;
}

export interface PartsCatalog {
  version: number;
  parts: PartEntry[];
}

/** File naming convention for authored parts. */
export function partFileName(carId: string, slot: PartSlot, partId: string): string {
  return `${carId}_${slot}_${partId}.glb`;
}
