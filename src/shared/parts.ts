/**
 * Shared vocabulary for the parts slot system. Pure data, used by the
 * renderer, the garage, build validation and the asset scripts.
 */

/** Every swappable visible piece lives in one of these slots. Add new slots here. */
export const PART_SLOTS = ['body', 'frontBumper', 'rearBumper', 'sideSkirts', 'spoiler', 'hood', 'roof', 'wheels'] as const;
export type PartSlot = (typeof PART_SLOTS)[number];

/** Slots shown as body part menus in the garage (body and wheels have their own menus). */
export const BODY_PART_SLOTS: PartSlot[] = ['frontBumper', 'sideSkirts', 'rearBumper', 'hood', 'spoiler', 'roof'];

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
 * new parts must use them, so paint and tint apply automatically. Only the main
 * lamps glow (`HeadLight`, `TailLight`, and `BrakeLight`, the third brake light,
 * only under braking); the other lamp lenses are unlit: `Light`
 * the amber indicators and side markers, `Reflector` red reflectors and markers,
 * `ClearLens` white side markers and repeaters, `Lens` the clear covers and unlit
 * clear lamps (reverse, fog), see-through so a
 * lamp's reflectors and bulbs show behind it. `Strap` is red woven webbing (a
 * motorsport tow strap): matte, never painted.
 */
export const MATERIAL_NAMES = ['Paint', 'Trim', 'Black', 'Chrome', 'Glass', 'Rim', 'Tire', 'HeadLight', 'TailLight', 'Light', 'Interior', 'Grille', 'RimLip', 'RimCap', 'Lens', 'Reflector', 'BrakeLight', 'ClearLens', 'Strap'] as const;
export type MaterialName = (typeof MATERIAL_NAMES)[number];

/** Triangle budgets per slot used by validation. */
export const TRI_BUDGETS: Record<PartSlot, number> = {
  body: 20000,
  // A donor shell's bumper, cut whole with its intakes and lips, runs past 3,000 (the Wendt Strom's 3,240),
  // and a part adds lamps, a lip or cut openings to it (the Wendt Strom's Cupra R Lip w/ Fogs: 3,991;
  // its Speedholes, ten real 16-sided holes: 4,365; its Track Mild, holes, a smooth sheet splitter and
  // canards: 4,973; its Track Wild, a dropped splitter with its air dam, spats, rods, a tow strap and a trim
  // plate round oval speed holes: 7,357).
  frontBumper: 7500,
  rearBumper: 5500,
  sideSkirts: 2000,
  spoiler: 1500,
  hood: 2000,
  roof: 2000,
  wheels: 12000,
};

/** The lug circle of a wheel GLB, in the GLB's own space (glTF frame, meters, axle along X, face toward +X); render/car/lugNuts.ts seats the house nuts on it. */
export interface WheelLugs {
  /** Number of nuts. */
  count: number;
  /** Bolt circle radius, m. */
  r: number;
  /** Angle of the first nut about the axle, rad: atan2(z, y) in the glTF frame; the others follow every 2π/count. */
  phase: number;
  /** X of the seat the nut's base sits on, m; the nut stands toward +X. */
  x: number;
  /** Seat radius, m: the nut's washer must cover a hole this wide. */
  size: number;
}

/**
 * How a wheel is built: 'single' is one piece (a cast or forged monoblock), 'multi' is a bolted lip and barrel
 * round a separate face (two or three piece). Stated per wheel in its recipe (scripts/blender/carWheels.py), never
 * guessed from the model: the stock lip finish reads it, and the offset tooling acts on multi-piece wheels only.
 */
export const WHEEL_CONSTRUCTIONS = ['single', 'multi'] as const;
export type WheelConstruction = (typeof WHEEL_CONSTRUCTIONS)[number];

export interface PartEntry {
  id: string;
  displayName: string;
  /** The garage section a wheel is listed under: a fictional maker name standing for its donor's real maker. */
  group?: string;
  /** Wheels: one piece or multi-piece (`WHEEL_CONSTRUCTIONS`); every shipped wheel carries it. */
  construction?: WheelConstruction;
  /**
   * Multi-piece wheels: the stock offset, m along the axle (+X outboard) from the tire's centerline to the lug
   * seat (the cap's front where a cap hides the nuts), so the wheel's ET at the house scale. The per-car offset
   * targets move the face by their difference from it (render/car/wheelFit.ts, `FaceFit`). Missing on a one-piece,
   * and on a multi-piece wheel that ships as modelled on every car (a face proud of the lip by design).
   */
  offset?: number;
  /**
   * Wheels: mm on the car (+ outboard) the face moves past the car's target (a flush face reads deeper than its
   * seat says), or from stock on a one-piece wheel or one without `offset`, which is then its only move.
   */
  offsetBias?: number;
  /** Wheels: how the source models ship the lip, polished ('chrome') or in the face's paint ('rim'). Not read at runtime: a stock lip is chrome on every wheel. */
  lip?: 'chrome' | 'rim';
  /** Wheels: the lug circle the house lug nuts sit on; missing: no lug nuts (a solid face hides the hub). */
  lugs?: WheelLugs;
  /** Car id, or "universal" (wheels). */
  carId: string;
  slot: PartSlot;
  /** Path under public/, e.g. "parts/proto_frontBumper_street.glb". */
  file: string;
  /** Optional node name inside `file` when several parts share one GLB. */
  node?: string;
  /** Base car mesh names to hide while this part is equipped. */
  hides: string[];
  /** Exhaust tips this part moves the car's to (car space x, y, z; m, the manifest's `exhaustTips` frame), as many as the car has: a center exhaust bumper carries its own pipes and hides the stock ones. */
  exhaustTips?: [number, number, number][];
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
