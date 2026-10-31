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
  /**
   * Crankshaft: a V8's cross-plane banks fire unevenly (the burble), flat-plane evenly (the scream); `oddfire` is the
   * 90 degree V10 on a 72 degree crank (the Viper), whose firings alternate 90 and 54 degrees. V10 only.
   */
  crank: ['cross', 'flat', 'oddfire'],
  /** Supercharger lobe passes per rotor turn, the whine's order: a twin screw's male rotor lobes (3 to 5), twice the lobes of one rotor on a Roots blower (4, 6 or 8 for 2, 3 or 4 lobe rotors). */
  blowerLobes: [3, 4, 5, 6, 8],
  /**
   * Turbo only, what a lift at boost sounds like: a venting blow-off valve's sharp, hissy chuff, a recirculating
   * diverter valve's soft "pssh" with the turbine still spinning (stock Audis, Volkswagens, Toyotas), or `flutter`,
   * no valve at all: the compressor stalls against the closed throttle and chatters "stu-tu-tu" (a deleted valve).
   */
  diverter: ['vent', 'recirculating', 'flutter'],
  /**
   * A named exhaust manifold's runner table in place of the layout's own (MANIFOLD_LAYOUTS says which layout each fits):
   * `split3`, an inline six's twin turbo manifold split front three and rear three (the RB26DETT's), each trio running
   * into its own turbine with the middle runner shortest; `topmount`, an inline five's tubular turbo manifold up over
   * the head to a T3 flange, its runners near equal and every pulse alike (the 07K turbo kits'), in place of the
   * Audi five's cast log. Absent: the layout's own (the six's ramp, as the 2JZ-GTE's single turbo manifold has).
   */
  manifold: ['split3', 'topmount'],
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
  /** Rpm where a variable valve lift system switches to its high-lift cam (VTEC and kin); absent means no switch. */
  camRpm: [4000, 9000],
  /** How hard that switch is heard (0 none, 1 a Honda VTEC; default 0.7 when `camRpm` is set). */
  camStep: [0, 1],
  /**
   * The idle lope of overlap, as a depth (0 none, the default; 1 the 13B-REW): a rotary's port overlap, or a piston
   * engine's long duration cam holding both valves open, lets burnt gas back into the intake so some firings go weak.
   */
  idleLope: [0, 1],
  /** Rotary only: the apex seal rasp, a noise burst per rotor face, as a multiple of the 13B-REW's (0 none, the default). */
  apexRasp: [0, 2],
  /** Turbo only: compressor surge flutter added to a valve's release at a hard lift at high boost, as a share of the full "stu-tu-tu" (0 none, the default; `diverter: 'flutter'` is always 1). */
  flutter: [0, 1],
  /** Turbo only: wastegate chatter, the rattle of the gate opening on a lift at boost, as a multiple of the reference (0 none, the default). */
  wastegate: [0, 2],
  /** Sequential twin turbo (needs `handoverRpm`): the rpm where the primary turbo reaches full boost; 1,800 when missing. */
  spoolRpm: [1000, 4000],
  /** Sequential twin turbo (needs `handoverRpm`): the rpm where the second turbine starts spooling on the exhaust, still making no boost; 500 under the handover when missing. */
  preboostRpm: [2000, 6000],
  /** Sequential twin turbo: the rpm where the second turbo's output joins (the changeover); absent means one turbo or parallel twins. */
  handoverRpm: [2500, 6500],
  /** Sequential twin turbo: the boost lost at the changeover as a fraction (0.2 is 10 psi down to 8), followed by a smaller surge; 0 none, the default. */
  handoverDip: [0, 0.5],
  /** Active exhaust flaps: how much quieter and duller the silencer is with the flaps shut, 0 to 1 (0 none, the default; 1 is 9 dB down and rolled off at 1.4 kHz). They open on load and revs. */
  flaps: [0, 1],
  /** Air-cooled engine: the cooling fan's turns per crank turn (the belt ratio); the fan's blade pass whine is locked to it. Absent means a liquid cooled engine. */
  fanRatio: [0.5, 3],
  /** Gearbox whine level, as a multiple of the reference (0 none, the default; 1 a straight cut dog box), locked to the driven shaft's speed. */
  gearWhine: [0, 2],
  /**
   * The high-rpm rasp: from about half the redline up, with the pedal down, the pulses sharpen and the band limit and
   * the derivative share open, so a smooth note turns metallic and ragged toward the top (0 none, the default; 1 the
   * full change, as a straight six with throttle bodies wails at 8,000).
   */
  howl: [0, 1],
  /** Parallel twin turbo (turbo only): the two turbines' whistles as two tones this far apart as a fraction of pitch (0.015 is 1.5 percent), each at about 0.72 of a single turbo's level; absent means one tone. */
  twinWhistle: [0, 0.1],
  /**
   * Turbo only: an external wastegate's vent ("screamer pipe") dumped to the air beside the exhaust, so while the gate
   * holds full boost part of the raw, unsilenced pulse train is heard on its own, a brash rasp on top of the note, as a
   * multiple of the reference (0 none, the default; engineAccessories.ts SCREAMER).
   */
  screamer: [0, 2],
} as const;

/** The layout each named manifold (VOICE_OPTIONS.manifold) is built for. */
export const MANIFOLD_LAYOUTS: Record<(typeof VOICE_OPTIONS.manifold)[number], EngineLayout> = { split3: 'I6', topmount: 'I5' };

/** Swept volume (l) the engine voice is tuned on: a firing of this size sounds as it always has; `displacement` scales from it. */
export const DISPLACEMENT_RANGE = [0.5, 10] as const;

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
  /** Rpm of the high-lift cam switch (VOICE_RANGES); no switch when missing. */
  camRpm?: number;
  /** Strength of the cam switch (VOICE_RANGES). */
  camStep?: number;
  /** Idle lope depth, a rotary's ports or a big cam's overlap (VOICE_RANGES). */
  idleLope?: number;
  /** Rotary apex seal rasp level (VOICE_RANGES). */
  apexRasp?: number;
  /** Surge flutter share on a valve car's hard lifts (VOICE_RANGES). */
  flutter?: number;
  /** Wastegate chatter level (VOICE_RANGES). */
  wastegate?: number;
  /** Sequential twin turbo: primary full boost rpm (VOICE_RANGES). */
  spoolRpm?: number;
  /** Sequential twin turbo: second turbine pre-spool rpm (VOICE_RANGES). */
  preboostRpm?: number;
  /** Sequential twin turbo: changeover rpm (VOICE_RANGES). */
  handoverRpm?: number;
  /** Sequential twin turbo: boost dip at the changeover, a fraction (VOICE_RANGES). */
  handoverDip?: number;
  /** Active exhaust flap depth (VOICE_RANGES). */
  flaps?: number;
  /** Air-cooled fan belt ratio (VOICE_RANGES). */
  fanRatio?: number;
  /** Gear whine level (VOICE_RANGES). */
  gearWhine?: number;
  /** Named manifold runner table, for the layout MANIFOLD_LAYOUTS gives (VOICE_OPTIONS). */
  manifold?: (typeof VOICE_OPTIONS.manifold)[number];
  /** High-rpm rasp depth (VOICE_RANGES). */
  howl?: number;
  /** Parallel twin turbo whistle spread (VOICE_RANGES). */
  twinWhistle?: number;
  /** External wastegate vent level (VOICE_RANGES). */
  screamer?: number;
}

/** The `engine` block of a car in carManifest.json. */
export interface EngineSpec {
  /** Cylinder layout code (I4, V6, B4, ...), a key of ENGINE_LAYOUTS. */
  layout: EngineLayout;
  /** Forced induction, if any. */
  aspiration: Aspiration;
  /** Where the engine sits in the chassis; first letter of the drivetrain code. */
  position: EnginePosition;
  /**
   * Swept volume (l, DISPLACEMENT_RANGE): bigger cylinders blow down longer and harder, so each pulse is longer and
   * louder (engineSynth.ts SIZE). Missing: the voice as tuned, which is a firing of about half a litre.
   */
  displacement?: number;
  /** Exhaust and intake details for the engine voice (optional, see VOICE_OPTIONS). */
  voice?: EngineVoiceSpec;
}

/**
 * An engine the garage's Power tab can swap into a car (the manifest car's `engineSwaps`): its name, a line on
 * what it is, and the spec the badges and the voice read in place of the car's own. Its physics (torque curve,
 * redline, the mass it adds or saves, the turbo's lag) are `swaps.<carId>.<id>` in drivingParams.json, merged
 * over the car's tuning by the sim (tuning.ts applySwap); the two lists must name the same swaps.
 */
export interface EngineSwap {
  /** Key in drivingParams.json `swaps.<carId>` and in a build's `performance.swap`. */
  id: string;
  /** The engine as tuners call it: '3.6 VR6'. */
  name: string;
  /** One line under the name: where the engine comes from and what the swap is. */
  note: string;
  engine: EngineSpec;
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
  /** What the tag says, which picks its ink (`.ink-*`): an engine swap, the drivetrain, the engine, forced induction. */
  ink: 'swap' | 'drive' | 'engine' | 'boost';
}

/**
 * The tags shown on a garage car tile and a build: a Swap tag first when `swap` names the engine swapped in (a build's
 * Power tab pick), then the drivetrain code, the engine layout and forced induction of `spec` (the swap's, when swapped).
 */
export function specBadges(spec: EngineSpec, drive: DrivetrainLayout, swap?: string): SpecBadge[] {
  const badges: SpecBadge[] = [
    { text: drivetrainCode(spec.position, drive), title: drivetrainName(spec.position, drive), ink: 'drive' },
    { text: spec.layout, title: engineName(spec), ink: 'engine' },
  ];
  if (swap) badges.unshift({ text: 'Swap', title: `Engine swap: ${swap}`, ink: 'swap' });
  const forced = ASPIRATIONS[spec.aspiration].badge;
  if (forced) badges.push({ text: forced, title: engineName(spec), ink: 'boost' });
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
  for (const k of Object.keys(s)) if (!(SPEC_FIELDS as readonly string[]).includes(k) && k !== 'voice' && k !== 'displacement') errors.push(`engine.${k} is not a known field (${SPEC_FIELDS.join(', ')}, displacement, voice)`);
  if ('displacement' in s && !(typeof s.displacement === 'number' && s.displacement >= DISPLACEMENT_RANGE[0] && s.displacement <= DISPLACEMENT_RANGE[1])) errors.push(`engine.displacement ${JSON.stringify(s.displacement)} is not a number of litres from ${DISPLACEMENT_RANGE[0]} to ${DISPLACEMENT_RANGE[1]}`);
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
      // Fields that only make sense for some engines.
      const voice = v as Record<string, unknown>;
      const layout = s.layout as EngineLayout;
      if (voice.crank === 'oddfire' && layout !== 'V10') errors.push('engine.voice.crank "oddfire" is for a V10');
      if ('camStep' in voice && !('camRpm' in voice)) errors.push('engine.voice.camStep needs camRpm');
      if ('apexRasp' in voice && !ENGINE_LAYOUTS[layout]?.rotary) errors.push('engine.voice.apexRasp is for a rotary');
      const fits = MANIFOLD_LAYOUTS[voice.manifold as keyof typeof MANIFOLD_LAYOUTS];
      if (fits && layout !== fits) errors.push(`engine.voice.manifold "${String(voice.manifold)}" is for an ${ENGINE_LAYOUTS[fits].name}`);
      if ('twinWhistle' in voice && s.aspiration !== 'turbo') errors.push('engine.voice.twinWhistle is for a turbo');
      if ('twinWhistle' in voice && 'handoverRpm' in voice) errors.push('engine.voice.twinWhistle is for parallel twins, not a sequential pair (handoverRpm)');
      for (const k of ['flutter', 'wastegate', 'screamer', 'spoolRpm', 'preboostRpm', 'handoverRpm', 'handoverDip']) if (k in voice && s.aspiration !== 'turbo') errors.push(`engine.voice.${k} is for a turbo`);
      if (voice.diverter === 'flutter' && s.aspiration !== 'turbo') errors.push('engine.voice.diverter "flutter" is for a turbo');
      for (const k of ['spoolRpm', 'preboostRpm', 'handoverDip']) if (k in voice && !('handoverRpm' in voice)) errors.push(`engine.voice.${k} needs handoverRpm`);
      if (typeof voice.handoverRpm === 'number') {
        const spool = typeof voice.spoolRpm === 'number' ? voice.spoolRpm : 0;
        const pre = typeof voice.preboostRpm === 'number' ? voice.preboostRpm : voice.handoverRpm;
        if (!(spool < pre && pre <= voice.handoverRpm)) errors.push('engine.voice needs spoolRpm < preboostRpm <= handoverRpm');
      }
    }
  }
  return errors;
}
