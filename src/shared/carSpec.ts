/**
 * Car spec labels: engine layout, aspiration and position, and the two letter
 * drivetrain code the garage shows next to each car (FR, FA, MR, ...). The
 * first letter is where the engine sits (Front, Mid, Rear), the second which
 * wheels it drives (Front, Rear, All).
 *
 * The engine is a fact about the model and lives in carManifest.json; which
 * wheels are driven is physics and comes from drivingParams.json
 * (`drivetrain.layout`), so a badge can never disagree with how the car
 * drives. Pure data: shared by the garage, the engine audio (cylinder count
 * and firing rate) and the asset validation.
 */
import type { DrivetrainLayout } from '../sim/tuning';

export type EngineLayout = 'I3' | 'I4' | 'I5' | 'I6' | 'B4' | 'B6' | 'V6' | 'VR6' | 'V8' | 'V10' | 'V12' | 'W12' | 'W16' | 'R2' | 'R3';

/** Cylinder layouts. Rotary engines count rotors instead of cylinders. */
export const ENGINE_LAYOUTS: Record<EngineLayout, { cylinders: number; name: string; rotary?: boolean }> = {
  I3: { cylinders: 3, name: 'inline 3' },
  I4: { cylinders: 4, name: 'inline 4' },
  I5: { cylinders: 5, name: 'inline 5' },
  I6: { cylinders: 6, name: 'inline 6' },
  B4: { cylinders: 4, name: 'flat 4' },
  B6: { cylinders: 6, name: 'flat 6' },
  V6: { cylinders: 6, name: 'V6' },
  VR6: { cylinders: 6, name: 'narrow angle V6' },
  V8: { cylinders: 8, name: 'V8' },
  V10: { cylinders: 10, name: 'V10' },
  V12: { cylinders: 12, name: 'V12' },
  W12: { cylinders: 12, name: 'W12' },
  W16: { cylinders: 16, name: 'W16' },
  R2: { cylinders: 2, name: 'twin rotor', rotary: true },
  R3: { cylinders: 3, name: 'triple rotor', rotary: true },
};

export type EnginePosition = 'front' | 'mid' | 'rear';
export const ENGINE_POSITIONS: Record<EnginePosition, { code: string; name: string }> = {
  front: { code: 'F', name: 'Front engine' },
  mid: { code: 'M', name: 'Mid engine' },
  rear: { code: 'R', name: 'Rear engine' },
};

export type Aspiration = 'na' | 'turbo' | 'supercharged';
/** `badge` is the short garage tag; naturally aspirated engines get none. */
export const ASPIRATIONS: Record<Aspiration, { badge: string | null; name: string }> = {
  na: { badge: null, name: 'naturally aspirated' },
  turbo: { badge: 'Turbo', name: 'turbocharged' },
  supercharged: { badge: 'S/C', name: 'supercharged' },
};

/** Second letter of the drivetrain code, from the sim's drivetrain layout. */
export const DRIVE_WHEELS: Record<DrivetrainLayout, { code: string; name: string }> = {
  fwd: { code: 'F', name: 'front-wheel drive' },
  rwd: { code: 'R', name: 'rear-wheel drive' },
  awd: { code: 'A', name: 'all-wheel drive' },
};

/** The `engine` block of a car in carManifest.json. */
export interface EngineSpec {
  /** Cylinder layout code (I4, V6, B4, ...), a key of ENGINE_LAYOUTS. */
  layout: EngineLayout;
  /** Forced induction, if any. */
  aspiration: Aspiration;
  /** Where the engine sits in the chassis; first letter of the drivetrain code. */
  position: EnginePosition;
}

export function cylinderCount(spec: EngineSpec): number {
  return ENGINE_LAYOUTS[spec.layout].cylinders;
}

/**
 * Combustion events per crankshaft revolution: the engine's fundamental
 * frequency is rpm / 60 times this. A four stroke piston fires every other
 * revolution; a rotor fires once per eccentric shaft revolution.
 */
export function firingsPerRev(spec: EngineSpec): number {
  const l = ENGINE_LAYOUTS[spec.layout];
  return l.rotary ? l.cylinders : l.cylinders / 2;
}

/** 'FR', 'FA', 'MR', ... */
export function drivetrainCode(position: EnginePosition, drive: DrivetrainLayout): string {
  return ENGINE_POSITIONS[position].code + DRIVE_WHEELS[drive].code;
}

/** 'Front engine, all-wheel drive' */
export function drivetrainName(position: EnginePosition, drive: DrivetrainLayout): string {
  return `${ENGINE_POSITIONS[position].name}, ${DRIVE_WHEELS[drive].name}`;
}

/** 'Turbocharged inline 4', 'Naturally aspirated V6' */
export function engineName(spec: EngineSpec): string {
  const a = ASPIRATIONS[spec.aspiration].name;
  return `${a[0].toUpperCase()}${a.slice(1)} ${ENGINE_LAYOUTS[spec.layout].name}`;
}

export interface SpecBadge {
  /** Short tag text: FR, V6, Turbo. */
  text: string;
  /** Long form for the tooltip. */
  title: string;
}

/** The tags shown on a garage car tile: drivetrain code, engine layout, forced induction. */
export function specBadges(spec: EngineSpec, drive: DrivetrainLayout): SpecBadge[] {
  const badges: SpecBadge[] = [
    { text: drivetrainCode(spec.position, drive), title: drivetrainName(spec.position, drive) },
    { text: spec.layout, title: engineName(spec) },
  ];
  const forced = ASPIRATIONS[spec.aspiration].badge;
  if (forced) badges.push({ text: forced, title: engineName(spec) });
  return badges;
}

const SPEC_FIELDS = ['layout', 'aspiration', 'position'] as const;

/** Problems with a manifest `engine` block, empty when it is a valid EngineSpec. Used by validation and tests. */
export function engineSpecErrors(spec: unknown): string[] {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['engine spec missing (expected { layout, aspiration, position })'];
  const s = spec as Record<string, unknown>;
  const errors: string[] = [];
  const check = (key: (typeof SPEC_FIELDS)[number], known: Record<string, unknown>) => {
    if (!(typeof s[key] === 'string' && s[key] in known)) errors.push(`engine.${key} "${String(s[key])}" is not one of ${Object.keys(known).join(', ')}`);
  };
  check('layout', ENGINE_LAYOUTS);
  check('aspiration', ASPIRATIONS);
  check('position', ENGINE_POSITIONS);
  for (const k of Object.keys(s)) if (!(SPEC_FIELDS as readonly string[]).includes(k)) errors.push(`engine.${k} is not a known field (${SPEC_FIELDS.join(', ')})`);
  return errors;
}
