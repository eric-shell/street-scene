/**
 * Physics tuning panel. Exposes every driving parameter of the player's
 * CarTuning as a live slider (drivetrain layout as a switch), grouped by
 * section, with a tooltip per parameter, JSON export (copy / download) and
 * import. Changes persist per car and are re-applied on the next free roam in
 * debug mode. Shown in races and free roam when the "Debug mode" setting is
 * on, and toggled there with ` / F2 (runs with changed tuning are never saved
 * as records).
 */
import { CarTuning, DRIVETRAIN_LAYOUTS, DrivetrainLayout, getBaseTuning, getByPath, setByPath, tuningHash } from '../../sim/tuning';
import { PerformanceBuild, applyBuild } from '../../sim/build';
import { btn, h, iconBtn, toast } from '../kit/dom';
import { Check, Copy, Download, RotateCcw, SlidersHorizontal, Upload, X, icon } from '../kit/icons';

export interface TuningParam {
  path: string;
  min: number;
  max: number;
  step: number;
  /** One sentence: what it does and which direction does what. */
  tip: string;
}

type ParamInfo = Omit<TuningParam, 'path'>;
const P = (min: number, max: number, step: number, tip: string): ParamInfo => ({ min, max, step, tip });

/**
 * Slider range and tooltip of every parameter, in one place. Array entries
 * (torque curve, gear ratios) are described by paramInfo() below.
 */
export const PARAM_INFO: Record<string, ParamInfo> = {
  mass: P(700, 2600, 10, 'Car weight in kg. Higher = slower to accelerate, brake and turn.'),
  yawInertiaScale: P(0.5, 2, 0.05, 'Resistance to rotating. Higher = lazier, more stable turn in; lower = twitchier.'),
  cgHeight: P(0.2, 1, 0.01, 'Center of gravity height. Higher = more weight transfer, body roll and pitch.'),
  'drivetrain.awdFrontShare': P(0, 1, 0.01, 'AWD only: torque share sent to the front axle. Higher = more understeer, less power oversteer.'),
  'engine.idleRpm': P(500, 1500, 10, 'Idle engine speed. Mostly affects sound and pull away from a stop.'),
  'engine.redline': P(5000, 10000, 50, 'Rev limit. Higher = each gear reaches more speed before the limiter.'),
  'engine.torqueMul': P(0.5, 2.5, 0.01, 'Scales the whole torque curve. Higher = more power everywhere.'),
  'engine.engineBraking': P(0, 200, 1, 'Engine drag off throttle (Nm at redline). Higher = slows harder when you lift.'),
  'engine.launchRpm': P(1500, 7000, 50, 'Revs the clutch holds when pulling away. Higher = harder launches, more wheelspin.'),
  'engine.inertia': P(0.05, 1, 0.01, 'Spin inertia of the engine and flywheel, kg m^2, geared onto the driven wheels. Lower = wheels spin up quicker in low gears.'),
  'gearbox.reverseRatio': P(1.5, 5, 0.05, 'Reverse gear ratio. Higher = quicker but slower reverse.'),
  'gearbox.finalDrive': P(2.5, 5.5, 0.05, 'Final drive ratio for all gears. Higher = quicker acceleration, lower top speed.'),
  'gearbox.efficiency': P(0.5, 1, 0.01, 'Share of engine torque reaching the wheels. Higher = more drive force.'),
  'gearbox.shiftTime': P(0.02, 0.5, 0.01, 'Seconds without drive during a shift. Lower = faster shifts.'),
  'gearbox.upshiftRpmFrac': P(0.6, 1, 0.01, 'Auto upshift point as a share of redline. Higher = holds gears longer.'),
  'gearbox.downshiftRpmFrac': P(0.2, 0.8, 0.01, 'Auto downshift point as a share of redline. Higher = downshifts earlier.'),
  'gearbox.reverseMaxSpeed': P(3, 30, 0.5, 'Reverse speed limit in m/s.'),
  'tires.gripFront': P(0.6, 2.2, 0.01, 'Front tire grip. Higher = sharper turn in; lower = more understeer.'),
  'tires.gripRear': P(0.6, 2.2, 0.01, 'Rear tire grip. Lower = looser rear, easier oversteer.'),
  'tires.peakSlipDeg': P(3, 20, 0.5, 'Slip angle of peak grip. Higher = softer, more progressive tires.'),
  'tires.peakSlipRatio': P(0.05, 0.4, 0.01, 'Wheel slip (tread speed over road speed, minus one) of peak grip. Higher = more wheelspin before the tires let go.'),
  'tires.fullSlideDeg': P(10, 60, 1, 'Slip angle where grip has dropped to slideGrip. Lower = snappier breakaway.'),
  'tires.slideGrip': P(0.3, 1, 0.01, 'Grip left when sliding sideways. Lower = slides grow and are harder to catch.'),
  'tires.slideGripLong': P(0.3, 1, 0.01, 'Grip left when sliding lengthways (spinning or locked wheels). Lower = burnouts waste more acceleration, locked wheels stop worse.'),
  'tires.minLateralShare': P(0, 1, 0.01, 'Side grip kept however hard the foot brake is used. Lower = brakes steal more cornering grip.'),
  'tires.rollingResistance': P(0, 40, 0.1, 'Rolling drag per m/s. Higher = coasts down faster.'),
  'tires.loadCap': P(1.2, 5, 0.05, 'Wheel load where grip stops growing, times the static load. Lower = landings and kerb hits kick the car less.'),
  'traction.wheelInertia': P(0.3, 4, 0.05, 'Spin inertia of each wheel, kg m^2. Lower = wheels spin up and hook back up quicker.'),
  'traction.launchBoost': P(0, 3, 0.05, 'Extra torque when the clutch is dumped at high revs. Higher = smokier launches and clutch kicks.'),
  'traction.clutchKickSpeed': P(0, 20, 0.5, 'Wheel speed a clutch kick adds to the driven wheels, m/s. Higher = clutch kicks break traction harder.'),
  'traction.tcSlipTarget': P(0.5, 1, 0.01, 'Traction control: drive allowed as a share of what keeps the tires inside their peak. Lower = safer but slower exits.'),
  'traction.tcMinDrive': P(0, 0.6, 0.01, 'Traction control: drive always allowed as a share of grip, even at full cornering slip. Higher = pulls out of slides, loses more cornering grip.'),
  'traction.tcMaxSlipDeg': P(2, 30, 0.5, 'Traction control: cuts power above this slide angle. Lower = stops slides earlier.'),
  'launch.twoStepRpm': P(0, 10000, 50, 'Launch rpm the two-step holds at the line (the garage Tune tab sets it per build). 0 = off, free revs.'),
  'launch.defaultRpm': P(0, 10000, 50, "The car's stock launch rpm: what a new garage build starts on. Read by the garage, not the sim."),
  'launch.twoStepDepth': P(50, 1500, 10, 'How far the two-step cut lets the revs fall under the launch rpm. Higher = deeper, slower stutter.'),
  'launch.twoStepCutTime': P(0.01, 0.3, 0.01, 'How long each two-step cut lasts, s. Higher = slower stutter.'),
  'launch.pedalThreshold': P(0.1, 0.95, 0.05, 'Throttle and brake both past this is the pedal combo (line lock, antilag). Lower = easier to trigger by accident.'),
  'launch.lineLockSpeed': P(0.5, 10, 0.1, 'Below this speed, m/s, throttle + brake is a line lock burnout and the two-step is armed; above it, antilag.'),
  'launch.antilagRpm': P(2000, 8000, 50, 'Rpm rolling antilag holds the engine at when no launch rpm is set. Higher = louder, more boost on release.'),
  'launch.antilagHold': P(0, 3, 0.05, 'Seconds boost stays pinned at full after the brake comes off antilag. Higher = more forgiving release.'),
  'launch.spoolTime': P(0.05, 3, 0.05, 'Turbo cars: seconds for boost to build from nothing under load. Higher = laggier turbo.'),
  'launch.spoolDownTime': P(0.05, 3, 0.05, 'Turbo cars: seconds for boost to bleed off the throttle. Lower = lift loses boost faster.'),
  'launch.spoolRpmFrac': P(0, 0.9, 0.01, 'Turbo cars: boost only builds above this share of the redline. Higher = nothing down low.'),
  'launch.turboShare': P(0, 0.8, 0.01, 'Turbo cars: share of torque that needs full boost. Higher = more lag to lose, bigger antilag payoff.'),
  'suspension.frequency': P(0.8, 3, 0.05, 'Spring stiffness as ride frequency. Higher = stiffer, less body motion.'),
  'suspension.dampingRatio': P(0.1, 1.2, 0.02, 'Bump damping (compressing). Higher = firmer over bumps; lower = floaty.'),
  'suspension.reboundRatio': P(0.1, 2, 0.02, 'Rebound damping (extending). Higher = settles after a landing without bouncing; lower = springs back up.'),
  'suspension.travel': P(0.04, 0.3, 0.005, 'Suspension travel before the bump stop, m. Lower = bottoms out sooner.'),
  'suspension.bumpStopRate': P(4, 60, 1, 'Bump stop stiffness as a multiple of the spring. Higher = a hard landing stops sooner, sits lower less.'),
  'suspension.bumpStopDamping': P(0, 2, 0.05, 'Bump stop damping while it compresses. Higher = landings are soaked up, less rebound.'),
  'suspension.bumpStopReturn': P(0, 1, 0.01, 'Share of a bump stop hit given back. 0 = dead landing, 1 = bouncy ball.'),
  'suspension.airLevel': P(0, 15, 0.5, 'How fast the car levels out in the air, rad/s. Higher = lands flat on all four; 0 = keeps its takeoff angle.'),
  'brakes.force': P(5000, 30000, 100, 'Total tire brake force in N. Higher = shorter stops until the tires run out of grip.'),
  'brakes.frontBias': P(0.3, 0.9, 0.01, 'Share of braking on the front axle. Lower = rear brakes more, car rotates under braking.'),
  'brakes.handbrakeTorque': P(0, 15000, 100, 'Handbrake torque on the rear axle, Nm. Above what the rear tires hold back it locks them; higher = locks faster.'),
  'brakes.assistDecel': P(0, 40, 0.5, 'Arcade braking on top of the tires, m/s^2 at full brake. Higher = shorter stops, cornering grip untouched.'),
  'steering.maxDeg': P(15, 45, 0.5, 'Steering lock at low speed. Higher = tighter turns.'),
  'steering.highSpeedDeg': P(1, 15, 0.25, 'Steering lock at high speed. Higher = more agile but nervous at speed.'),
  'steering.fadeSpeed': P(10, 80, 1, 'Speed (m/s) where lock has faded to highSpeedDeg. Higher = keeps full lock longer.'),
  'steering.rateDegPerSec': P(40, 400, 5, 'How fast the wheels turn. Higher = quicker, twitchier steering.'),
  'steering.counterSteerAllowance': P(0, 2, 0.05, 'Extra lock when steering into a slide. Higher = easier to catch drifts.'),
  'aero.drag': P(0.1, 1, 0.01, 'Air drag. Higher = lower top speed.'),
  'aero.downforce': P(0, 3, 0.05, 'Aero grip that grows with speed. Higher = more high speed grip.'),
  'nitrous.capacity': P(0.5, 10, 0.1, 'Seconds of boost in each of the three stages.'),
  'nitrous.force': P(0, 9000, 100, 'Extra push while boosting at stage 1, N. Higher = harder kick.'),
  'nitrous.torqueMul': P(1, 2, 0.01, 'Engine torque multiplier while boosting at stage 1. Higher = more power, more wheelspin.'),
  'nitrous.refillDrift': P(0, 0.5, 0.01, 'Share of a stage refilled per second while drifting.'),
  'nitrous.refillNearMiss': P(0, 1, 0.01, 'Share of a stage refilled per second while skimming walls.'),
  'nitrous.refillDraft': P(0, 0.5, 0.01, 'Share of a stage refilled per second while drafting.'),
  'nitrous.draftDragMul': P(0.2, 1, 0.01, 'Air drag in a slipstream. Lower = bigger draft speed boost.'),
  'nitrous.wreckBonus': P(0, 1, 0.01, 'Share of a stage a knocked down prop pays (a heavy one; lighter props pay less).'),
  'nitrous.wreckFullMass': P(50, 2000, 10, 'Effective prop mass that pays the whole wreck bonus, kg. Lower = cans pay as much as poles.'),
  'drift.clutchKickTime': P(0.05, 1.5, 0.01, 'How long a clutch kick keeps feeding extra torque, s.'),
  'drift.maxSlipDeg': P(20, 80, 1, 'Slide angle where the anti spin aid pushes back. Lower = harder to spin out.'),
  'drift.assistTorque': P(0, 60000, 250, 'Strength of the anti spin aid past maxSlipDeg. Higher = stronger catch.'),
  'drift.yawDamping': P(0, 8000, 50, 'Always on rotation damping. Higher = calmer, less twitchy car.'),
  'drift.yawDampingLowSpeed': P(0, 20, 0.1, 'Extra rotation damping below 3 m/s. Higher = no pirouettes at a crawl.'),
  'surface.sidewalkGrip': P(0.2, 1, 0.01, 'Grip multiplier on sidewalks. Lower = slippery curbs.'),
  'surface.offroadGrip': P(0.2, 1, 0.01, 'Grip multiplier off road. Lower = slippery dirt.'),
  'surface.offroadDrag': P(0, 3000, 10, 'Extra drag off road, N. Higher = dirt slows you down more.'),
  'surface.cobbleGrip': P(0.2, 1, 0.01, 'Grip multiplier on cobbled alleys. Lower = slippery stones.'),
  'surface.cobbleDrag': P(0, 1500, 10, 'Extra rolling drag on cobbles, N. Higher = alleys bleed more speed.'),
  'surface.waterDrag': P(0, 10, 0.1, 'Drag in the river trickle, N per (m/s)² with every wheel in it. Higher = the wet line costs more at speed.'),
  'collision.wallRestitution': P(0, 1, 0.01, 'Wall bounce. Higher = bounces off walls harder.'),
  'collision.wallScrub': P(0, 1, 0.01, 'Speed lost along a wall per hit, relative to hit strength. Higher = walls cost more speed.'),
  'collision.railRestitution': P(0, 1, 0.01, 'Corner rail bounce. Higher = bounces off rails harder.'),
  'collision.railScrub': P(0, 1, 0.01, 'Speed lost along a rail per hit, relative to hit strength. Higher = rail hits cost more speed.'),
  'collision.railAngularScale': P(0, 1, 0.01, 'How much rail hits spin the car. Higher = more rotation from rail hits.'),
  'collision.railDrag': P(0, 20, 0.1, 'Sliding friction while scraping a rail, m/s². Higher = scraping costs more speed.'),
  'collision.railSpeedLoss': P(0, 2, 0.01, 'Share of speed lost per second scraping a rail. Higher = rails punish fast scrapes more.'),
  'collision.railDentLoss': P(0, 5, 0.05, 'Share of speed lost per meter a hit shoves a heavy rail piece back. Higher = denting rails costs more.'),
  'collision.railStepLoss': P(0, 8, 0.1, 'Share of speed lost per meter of step when scraping into a rail piece that sticks out past a dented one. Higher = bumpy rails hurt more.'),
  'collision.carRestitution': P(0, 1, 0.01, 'Car to car bounce. Higher = cars bounce apart harder.'),
  'collision.angularScale': P(0, 1, 0.01, 'How much wall and car hits spin the car. Higher = more rotation from impacts.'),
};

export const LAYOUT_TIP = 'Driven wheels. RWD = rear (power oversteer), AWD = both axles (stable launches), FWD = front (understeer).';

/** Range and tooltip for any tunable path, including torque curve points and gear ratios. */
export function paramInfo(path: string, value: number, t?: CarTuning): ParamInfo {
  const known = PARAM_INFO[path];
  if (known) return known;
  const curve = /^engine\.torqueCurve\.(\d+)\.1$/.exec(path);
  if (curve) {
    const rpm = t ? t.engine.torqueCurve[Number(curve[1])]?.[0] : undefined;
    return P(0, 600, 1, `Torque (Nm) at ${rpm ?? '?'} rpm. Higher = more pull in that rev range.`);
  }
  const gear = /^gearbox\.ratios\.(\d+)$/.exec(path);
  if (gear) return P(0.5, 5, 0.01, `Gear ${Number(gear[1]) + 1} ratio. Higher = shorter gear: more pull, less speed in that gear.`);
  const stage = /^nitrous\.(stagePower|chainRefill)\.(\d+)$/.exec(path);
  if (stage) {
    const n = Number(stage[2]) + 1;
    return stage[1] === 'stagePower'
      ? P(0.5, 2, 0.01, `Boost power while burning stage ${n}, times the stage 1 push and extra torque. Higher = harder kick.`)
      : P(0, 3, 0.01, `Stages put back when a boost begun with ${n} full stage${n > 1 ? 's' : ''} is held until the tank runs dry. Higher = longer chains.`);
  }
  // Fallback for parameters added to the tuning without a table entry.
  const min = value > 0 ? 0 : value * 3;
  const max = value > 0 ? Math.max(value * 3, value + 1) : value < 0 ? 0 : 1;
  return P(min, max, niceStep(max - min), 'No description yet: add it to PARAM_INFO in tuningPanel.ts.');
}

/** Saved free roam tuning: values plus the fingerprint of drivingParams.json they were made against. */
interface SavedTuning {
  v: string;
  changed: TuningValues;
}
type TuningValues = Record<string, number | string>;

const KEY = (carId: string) => `nightrun.testTuning.${carId}`;
/** Geometry comes from the car manifest, not from tuning. */
const SKIP = (path: string) => path === 'carId' || path === 'geometry' || path.startsWith('geometry.');
const LAYOUT_PATH = 'drivetrain.layout';
/** Torque curve rpm points stay fixed; only the torque values are tunable. */
const isCurveRpm = (path: string) => /^engine\.torqueCurve\.\d+\.0$/.test(path);

function niceStep(range: number): number {
  const raw = range / 200;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 2 ? 1 : m < 5 ? 2 : 5) * p;
}

/** Every numeric leaf in the tuning object, with slider ranges and tooltips. */
export function tuningParams(t: CarTuning): TuningParam[] {
  const out: TuningParam[] = [];
  const walk = (o: unknown, path: string) => {
    if (SKIP(path)) return;
    if (typeof o === 'number') {
      if (!isCurveRpm(path)) out.push({ path, ...paramInfo(path, o, t) });
      return;
    }
    if (Array.isArray(o)) o.forEach((x, i) => walk(x, `${path}.${i}`));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(t, '');
  return out;
}

/**
 * Flatten tuning-like JSON into path -> value. Accepts flat maps ("tires.gripRear": 1.2),
 * nested deep partials (the drivingParams.json car override format) or a full tuning.
 * Keys starting with `_`, carId and geometry are ignored.
 */
export function flattenTuning(o: unknown, prefix = '', out: TuningValues = {}): TuningValues {
  if (typeof o === 'number' || typeof o === 'string') {
    if (prefix && !SKIP(prefix)) out[prefix] = o;
    return out;
  }
  if (Array.isArray(o)) o.forEach((x, i) => flattenTuning(x, `${prefix}.${i}`, out));
  else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) flattenTuning(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/** Pick the values to import from pasted JSON: the panel's own export, a drivingParams.json style block, or a flat map. */
export function importValues(obj: unknown, carId: string): TuningValues {
  const o = (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>;
  // Panel export: the full tuning reproduces the exported car exactly; fall back to its changed list.
  if ('nightRunTuning' in o) return o.tuning ? flattenTuning(o.tuning) : flattenTuning(o.changed ?? {});
  // Whole drivingParams.json: base, then this car's override.
  if (o.base && o.cars) return { ...flattenTuning(o.base), ...flattenTuning((o.cars as Record<string, unknown>)[carId] ?? {}) };
  return flattenTuning(o.changed ?? o);
}

export function loadSavedTuning(carId: string): TuningValues {
  try {
    const raw = localStorage.getItem(KEY(carId));
    const obj = raw ? (JSON.parse(raw) as Partial<SavedTuning>) : null;
    // Made against an older drivingParams.json (or the old unversioned format): drop it so it never masks file edits.
    if (!obj || obj.v !== tuningHash(carId) || !obj.changed) {
      if (raw) localStorage.removeItem(KEY(carId));
      return {};
    }
    return Object.fromEntries(Object.entries(obj.changed).filter(([, v]) => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string'));
  } catch {
    return {};
  }
}

function saveTuning(carId: string, changed: TuningValues): void {
  try {
    if (Object.keys(changed).length) localStorage.setItem(KEY(carId), JSON.stringify({ v: tuningHash(carId), changed } satisfies SavedTuning));
    else localStorage.removeItem(KEY(carId));
  } catch {
    /* ignore */
  }
}

/** Apply saved or imported values onto a live tuning object. Returns how many were applied. */
export function applySavedTuning(t: CarTuning, overrides: TuningValues): number {
  let n = 0;
  for (const [path, v] of Object.entries(overrides)) {
    if (SKIP(path)) continue;
    try {
      const cur = getByPath(t, path) as unknown;
      if (path === LAYOUT_PATH ? DRIVETRAIN_LAYOUTS.includes(v as DrivetrainLayout) : typeof cur === 'number' && typeof v === 'number' && Number.isFinite(v)) {
        setByPath(t, path, v);
        n++;
      }
    } catch {
      /* unknown path */
    }
  }
  return n;
}

/** Nest changed paths into a drivingParams.json car override. Arrays are written whole, as the file replaces them whole. */
function fileOverride(t: CarTuning, changed: TuningValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of Object.keys(changed)) {
    const keys = path.split('.');
    const arrayAt = keys.findIndex((k) => /^\d+$/.test(k));
    const keep = arrayAt > 0 ? keys.slice(0, arrayAt) : keys;
    let o = out;
    for (let i = 0; i < keep.length - 1; i++) o = (o[keep[i]] ??= {}) as Record<string, unknown>;
    o[keep[keep.length - 1]] = JSON.parse(JSON.stringify(getByPath(t, keep.join('.'))));
  }
  return out;
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toFixed(3));

export class TuningPanel {
  private root: HTMLElement | null = null;

  constructor(private readonly parent: HTMLElement) {}

  get open(): boolean {
    return !!this.root;
  }

  toggle(tuning: CarTuning, performance: PerformanceBuild, onChange: () => void): void {
    if (this.root) this.close();
    else this.show(tuning, performance, onChange);
  }

  show(tuning: CarTuning, performance: PerformanceBuild, onChange: () => void): void {
    this.close();
    // Baseline = this car with its performance parts, before any manual tuning.
    const base = applyBuild(getBaseTuning(tuning.carId), performance);
    const params = tuningParams(base);
    const stockParts = Object.values(performance).every((v) => v === 0);
    const changed = (): TuningValues => {
      const out: TuningValues = {};
      if (tuning.drivetrain.layout !== base.drivetrain.layout) out[LAYOUT_PATH] = tuning.drivetrain.layout;
      for (const p of params) {
        const v = getByPath(tuning, p.path);
        if (Math.abs(v - getByPath(base, p.path)) > 1e-9) out[p.path] = v;
      }
      return out;
    };
    const persist = () => saveTuning(tuning.carId, changed());
    const exportJson = () => {
      const c = changed();
      return JSON.stringify(
        {
          nightRunTuning: 1,
          carId: tuning.carId,
          performance,
          changed: c,
          // Paste into cars.<carId> of src/sim/drivingParams.json (only meaningful with stock parts).
          fileOverride: stockParts ? fileOverride(tuning, c) : 'Only exported with stock performance parts (tuning values include the upgrades).',
          tuning,
        },
        null,
        2,
      );
    };

    const search = h('input', { type: 'text', placeholder: 'Filter parameters', 'aria-label': 'Filter parameters', style: 'width:100%' }) as HTMLInputElement;
    const list = h('div', { class: 'tuning-panel__list' });
    const sections = new Map<string, HTMLElement>();
    const rows: { path: string; text: string; el: HTMLElement; sync: () => void }[] = [];
    const sectionBody = (sec: string): HTMLElement => {
      let body = sections.get(sec);
      if (!body) {
        body = h('div', { class: 'tuning-panel__section-body' });
        const det = h('details', { class: 'tuning-panel__section', open: sec === 'tires' || sec === 'traction' || sec === 'drift' || sec === 'steering' }, h('summary', { class: 'tuning-panel__section-title' }, sec), body);
        list.append(det);
        sections.set(sec, body);
      }
      return body;
    };
    // Tooltip: hover shows the title; a tap or click on the name shows it inline (touch friendly).
    const labelWithTip = (text: string, tip: string, row: HTMLElement) => {
      const tipEl = h('div', { class: 'muted tuning-panel__tip', style: 'grid-column:1 / span 3;font-size:11px;line-height:1.35;display:none' }, tip);
      const label = h('label', { class: 'tuning-panel__label', title: tip, style: 'cursor:help' }, text);
      label.addEventListener('click', () => (tipEl.style.display = tipEl.style.display === 'none' ? '' : 'none'));
      row.append(label);
      return tipEl;
    };

    // Drivetrain layout: a switch rather than a slider.
    {
      const row = h('div', { class: 'tuning-panel__row' });
      const tipEl = labelWithTip('layout', LAYOUT_TIP, row);
      const seg = h('div', { class: 'segmented', role: 'radiogroup', style: 'grid-column:1 / span 3' });
      const buttons = DRIVETRAIN_LAYOUTS.map((l) => {
        const b = h('button', { class: 'segmented__option', type: 'button', role: 'radio' }, l.toUpperCase());
        b.addEventListener('click', () => {
          tuning.drivetrain.layout = l;
          sync();
          persist();
          onChange();
          b.blur();
        });
        seg.append(b);
        return b;
      });
      const sync = () => {
        buttons.forEach((b, i) => b.classList.toggle('is-selected', DRIVETRAIN_LAYOUTS[i] === tuning.drivetrain.layout));
        row.classList.toggle('is-changed', tuning.drivetrain.layout !== base.drivetrain.layout);
      };
      const reset = iconBtn(
        RotateCcw,
        'Reset drivetrain layout',
        () => {
          tuning.drivetrain.layout = base.drivetrain.layout;
          sync();
          persist();
          onChange();
        },
        '--small tuning-panel__reset',
      );
      row.append(h('span', { class: 'tuning-panel__value' }, ''), reset, tipEl, seg);
      sync();
      sectionBody('drivetrain').append(row);
      rows.push({ path: LAYOUT_PATH, text: `${LAYOUT_PATH} ${LAYOUT_TIP}`.toLowerCase(), el: row, sync });
    }

    for (const p of params) {
      const sec = p.path.includes('.') ? p.path.split('.')[0] : 'body';
      const label = p.path.includes('.') ? p.path.slice(sec.length + 1) : p.path;
      const val = getByPath(tuning, p.path);
      const lo = Math.min(p.min, val);
      const hi = Math.max(p.max, val);
      const out = h('span', { class: 'tuning-panel__value' }, fmt(val));
      const input = h('input', { class: 'tuning-panel__slider', type: 'range', min: lo, max: hi, step: p.step, value: val, 'aria-label': p.path, title: p.tip }) as HTMLInputElement;
      const row = h('div', { class: 'tuning-panel__row' });
      const sync = () => {
        const v = getByPath(tuning, p.path);
        input.value = String(v);
        out.textContent = fmt(v);
        row.classList.toggle('is-changed', Math.abs(v - getByPath(base, p.path)) > 1e-9);
      };
      input.addEventListener('input', () => {
        setByPath(tuning, p.path, Number(input.value));
        sync();
        onChange();
      });
      // Give the keyboard back to driving as soon as the slider is released.
      input.addEventListener('change', () => {
        persist();
        input.blur();
      });
      const reset = iconBtn(
        RotateCcw,
        `Reset ${p.path}`,
        () => {
          setByPath(tuning, p.path, getByPath(base, p.path));
          sync();
          persist();
          onChange();
        },
        '--small tuning-panel__reset',
      );
      const tipEl = labelWithTip(label, p.tip, row);
      row.append(out, reset, tipEl, input);
      sync();
      sectionBody(sec).append(row);
      rows.push({ path: p.path, text: `${p.path} ${p.tip}`.toLowerCase(), el: row, sync });
    }
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      // Matches parameter names and tooltip text, so "oversteer" finds every related knob.
      for (const r of rows) r.el.style.display = !q || r.text.includes(q) ? '' : 'none';
      if (q) list.querySelectorAll('details').forEach((d) => ((d as HTMLDetailsElement).open = true));
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());

    const importBox = () => {
      const area = h('textarea', { rows: 6, placeholder: 'Paste exported tuning JSON, a drivingParams.json car block, or a "path": value map', style: 'width:100%;font:12px monospace' }) as HTMLTextAreaElement;
      area.addEventListener('keydown', (e) => e.stopPropagation());
      const wrap = h('div', { class: 'col' }, area);
      wrap.append(
        btn(Check, 'Apply', () => {
          try {
            const n = applySavedTuning(tuning, importValues(JSON.parse(area.value), tuning.carId));
            rows.forEach((r) => r.sync());
            persist();
            onChange();
            toast(`Applied ${n} values`, Check);
            wrap.remove();
          } catch {
            toast('That is not valid tuning JSON', Upload);
          }
        }, '--small --primary'),
      );
      list.before(wrap);
    };

    this.root = h(
      'div',
      { class: 'tuning-panel panel' },
      h('div', { class: 'tuning-panel__head' }, h('div', { class: 'label' }, icon(SlidersHorizontal, { size: 14 }), `Physics tuning · ${tuning.carId}`), iconBtn(X, 'Close tuning', () => this.close(), '--small')),
      search,
      h(
        'div',
        { class: 'row', style: 'gap:6px' },
        btn(Copy, 'Copy JSON', async () => {
          try {
            await navigator.clipboard.writeText(exportJson());
            toast('Tuning JSON copied', Check);
          } catch {
            toast('Clipboard blocked: use Download', Copy);
          }
        }, '--small'),
        btn(Download, 'Download', () => {
          const blob = new Blob([exportJson()], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `nightrun-tuning-${tuning.carId}.json` });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }, '--small'),
        btn(Upload, 'Import', importBox, '--small'),
        btn(RotateCcw, 'Reset all', () => {
          tuning.drivetrain.layout = base.drivetrain.layout;
          for (const p of params) setByPath(tuning, p.path, getByPath(base, p.path));
          rows.forEach((r) => r.sync());
          persist();
          onChange();
        }, '--small'),
      ),
      h(
        'div',
        { class: 'muted tuning-panel__note' },
        'Changes apply live and are kept for this car in free roam. Tap a name for its description. The export has a "changed" list, a "fileOverride" block for src/sim/drivingParams.json and the full tuning.',
      ),
      list,
    );
    this.parent.append(this.root);
  }

  close(): void {
    this.root?.remove();
    this.root = null;
  }
}
