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

/**
 * What the engine voice can be told beyond layout and aspiration: the parts of
 * a real car's exhaust and intake that change how it sounds. Every field is
 * optional; the synth picks the layout's usual answer (src/audio/engineSynth.ts).
 */
export const VOICE_OPTIONS = {
  /** Header primaries: equal length, or one bank's runners longer (the Subaru rumble, the VR6's growl; how much longer is `headerSpread`). */
  headers: ['equal', 'unequal'],
  /** Separate tailpipes: 1 merges every cylinder, 2 keeps each bank (or half of an inline six) on its own pipe. */
  pipes: [1, 2],
  /** Between twin pipes: none, an H-pipe balance tube (a little of each bank in the other pipe), or an X-pipe (nearly half). */
  crossover: ['none', 'h', 'x'],
  /** How much the silencer lets through. */
  muffler: ['quiet', 'sport', 'straight'],
  /** One throttle on a plenum, or individual throttle bodies that honk when opened. */
  intake: ['plenum', 'itb'],
  /** V8 crankshaft: cross-plane banks fire unevenly (the burble), flat-plane evenly (the scream). */
  crank: ['cross', 'flat'],
  /** Supercharger lobe passes per rotor turn, the whine's order: a twin screw's male rotor lobes (3 to 5), twice the lobes of one rotor on a Roots blower (4 or 6). */
  blowerLobes: [3, 4, 5, 6],
  /** Turbo only, what a lift at boost sounds like: a venting blow-off valve's sharp, hissy chuff, or a recirculating diverter valve's soft "pssh" with the turbine still spinning (stock Audis and Volkswagens). */
  diverter: ['vent', 'recirculating'],
} as const;

/** Numeric voice fields: [min, max]. */
export const VOICE_RANGES = {
  /** How much longer the long bank's primaries run with unequal headers (m): a boxer's crossover under the engine is about 0.5. */
  headerSpread: [0, 1],
  /** Supercharger rotor turns per crank turn (the pulley ratio times any step-up gear inside the blower). */
  blowerRatio: [1, 5],
  /** Peak boost (psi): how hard the blower works at the top, so how loud its whine gets. */
  boost: [0, 35],
  /** Turbo only: the induction whoosh, a band of rushing air that rises with boost, as a multiple of the reference level (0 none, the default; 1 the K24 on a stock Audi S2). */
  whoosh: [0, 2],
} as const;

export interface EngineVoiceSpec {
  headers?: (typeof VOICE_OPTIONS.headers)[number];
  pipes?: (typeof VOICE_OPTIONS.pipes)[number];
  muffler?: (typeof VOICE_OPTIONS.muffler)[number];
  intake?: (typeof VOICE_OPTIONS.intake)[number];
  crank?: (typeof VOICE_OPTIONS.crank)[number];
  crossover?: (typeof VOICE_OPTIONS.crossover)[number];
  /** Extra primary length on the long bank with unequal headers (m, VOICE_RANGES). */
  headerSpread?: number;
  /** Supercharger lobe passes per rotor turn (supercharged engines). */
  blowerLobes?: (typeof VOICE_OPTIONS.blowerLobes)[number];
  /** Supercharger rotor turns per crank turn (VOICE_RANGES). */
  blowerRatio?: number;
  /** Peak boost (psi, VOICE_RANGES). */
  boost?: number;
  /** Turbo lift sound (VOICE_OPTIONS); vent when missing. */
  diverter?: (typeof VOICE_OPTIONS.diverter)[number];
  /** Turbo induction whoosh level (VOICE_RANGES); none when missing. */
  whoosh?: number;
}

/** The `engine` block of a car in carManifest.json. */
export interface EngineSpec {
  /** Cylinder layout code (I4, V6, B4, ...), a key of ENGINE_LAYOUTS. */
  layout: EngineLayout;
  /** Forced induction, if any. */
  aspiration: Aspiration;
  /** Where the engine sits in the chassis; first letter of the drivetrain code. */
  position: EnginePosition;
  /** Exhaust and intake details for the engine voice (optional, see VOICE_OPTIONS). */
  voice?: EngineVoiceSpec;
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
  for (const k of Object.keys(s)) if (!(SPEC_FIELDS as readonly string[]).includes(k) && k !== 'voice') errors.push(`engine.${k} is not a known field (${SPEC_FIELDS.join(', ')}, voice)`);
  if ('voice' in s) {
    const v = s.voice;
    if (!v || typeof v !== 'object' || Array.isArray(v)) errors.push('engine.voice must be an object');
    else {
      for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
        const allowed = (VOICE_OPTIONS as Record<string, readonly (string | number)[]>)[k];
        const range = (VOICE_RANGES as Record<string, readonly [number, number]>)[k];
        if (range) {
          if (!(typeof value === 'number' && value >= range[0] && value <= range[1])) errors.push(`engine.voice.${k} ${JSON.stringify(value)} is not a number from ${range[0]} to ${range[1]}`);
        } else if (!allowed) errors.push(`engine.voice.${k} is not a known field (${[...Object.keys(VOICE_OPTIONS), ...Object.keys(VOICE_RANGES)].join(', ')})`);
        else if (!allowed.includes(value as string | number)) errors.push(`engine.voice.${k} ${JSON.stringify(value)} is not one of ${allowed.join(', ')}`);
      }
    }
  }
  return errors;
}
