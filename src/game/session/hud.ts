/**
 * What RaceSession feeds the HUD: the card the drone shares (free roam's green
 * Exit card, or a race's Pause card in its type's hue), the help panel's
 * sections for the mode, the per frame `HudData` read off the race (place,
 * lap, speed, gears, nitrous, drift score, the waypoint target) and the
 * free roam minimap's traffic dots. The session passes in what these read, so
 * the HUD wiring stays apart from the tick and render core. Render only.
 */
import { standings, raceTime, ticksToSeconds, type RaceMode, type RaceState } from '../../sim/race';
import { MapIcon, Compass, Pause } from '../../ui/kit/icons';
import { btn } from '../../ui/kit/dom';
import { mph } from '../../ui/kit/units';
import { HudCard } from '../../ui/hud/hudCard';
import { RACE_CARD, raceReadouts, type HudCar, type HudData } from '../../ui/hud/hud';
import type { Aspiration } from '../../shared/carSpec';
import { MUSIC_KEYS, type HelpKey, type HelpSection } from '../../ui/panels/help';
import { driftZoneStatus } from '../../sim/driftZones';
import { DRIFT_ZONES } from '../../sim/tuning';
import { TRAFFIC_SNAP } from '../../render/traffic/traffic';

/** Free roam minimap: traffic this close to the player shows as dots (m; the map spans about 260 m to its edge). */
const TRAFFIC_DOT_RANGE = 280;

/** What the HUD card needs from the session. */
interface HudCardWiring {
  race: RaceState;
  isReplay: boolean;
  openWorld: boolean;
  /** The card's Map button (a replay has none). */
  onMap(): void;
  /** The card's hide button works while the drive runs (not paused, the map shut, no camera shot). */
  canHide(): boolean;
  /** Free roam's Exit, back to the menu. */
  onQuit(): void;
  /** A race's Pause, the pause screen. */
  onPause(): void;
}

/** The same card as the drone's in every mode: Map (not in a replay, which has none) and hide. */
export function createHudCard(w: HudCardWiring): HudCard {
  const shared = {
    actions: w.isReplay ? [] : [btn(MapIcon, 'Map', () => w.onMap(), '--small')],
    canHide: () => w.canHide(),
  };
  if (w.openWorld) {
    // Free roam's green from the menu: the district, time, smashes and top speed, and Exit back to the menu.
    return new HudCard({
      ...shared,
      hue: 'green',
      icon: Compass,
      title: 'Free roam',
      status: '',
      stats: ['Time', 'Smashed', 'Top speed'],
      onExit: () => w.onQuit(),
      exitTitle: 'Back to the menu',
    });
  }
  // A race in its type's hue under the event's name: place, lap or progress, time and best, and Pause where
  // free roam has Exit (quitting a race goes through the pause screen).
  const mode = w.race.config.mode;
  return new HudCard({
    ...shared,
    ...RACE_CARD[mode],
    status: [w.isReplay ? 'Replay' : '', w.race.world.event?.name ?? ''].filter(Boolean).join(' · '),
    stats: raceReadouts(mode),
    onExit: () => w.onPause(),
    exitLabel: 'Pause',
    exitIcon: Pause,
    exitTitle: 'Pause (Esc)',
  });
}

/** The help panel's sections: the driving keys (a replay's cameras instead), the views, music and tips for this mode. */
export function helpSections(mode: RaceMode, isReplay: boolean, openWorld: boolean): HelpSection[] {
  const driving: HelpKey[] = [
    { keys: ['W', '↑'], label: 'Throttle' },
    { keys: ['S', '↓'], label: 'Brake, reverse' },
    { keys: ['A', 'D'], label: 'Steer' },
    { keys: ['Space'], label: 'Handbrake' },
    { keys: ['N'], label: 'Nitrous' },
    { keys: ['G'], label: 'Horn' },
    { keys: ['Q', 'E'], label: 'Shift down, up (manual gearbox)' },
    { keys: ['W + S'], label: 'Line lock burnout (standing)' },
    { keys: ['Shift + W'], label: 'Rolling antilag (turbo, on the move)' },
    { keys: ['R'], label: 'Reset the car' },
  ];
  const view: HelpKey[] = [
    { keys: ['C'], label: isReplay ? 'Next camera' : 'Camera' },
    { keys: [isReplay ? '1–7' : '1–6'], label: 'Pick a camera' },
    { keys: ['0'], label: 'Drone photo mode' },
    ...(isReplay ? [] : [{ keys: ['Tab'], label: 'City map (or click the minimap)' }]),
    { keys: ['H'], label: 'Hide the HUD' },
    { keys: ['Esc'], label: 'Pause' },
  ];
  const tips = openWorld
    ? ['Set a waypoint on the city map: the chip under the card points the way, or T on the map teleports you there.', 'The card counts everything you smash on the way.']
    : mode === 'drift'
      ? ['Drift zones multiply the points you score inside them.']
      : mode === 'waypoint'
        ? ['Hit the waypoints in any order, by any streets: the arrow up top points to the nearest one left.', 'Drift zones refill nitrous faster while you slide through them.']
        : ['Drift zones refill nitrous faster while you slide through them.'];
  return [
    ...(isReplay ? [] : [{ title: 'Driving', keys: driving }]),
    { title: 'View', keys: view },
    { title: 'Music', keys: MUSIC_KEYS },
    { title: 'Tips', tips: [...tips, 'Settings › Controls lists the gamepad and touch controls.'] },
  ];
}

/** The HUD's numbers for this frame, read off the race (the session adds the open world's extras). */
export function raceHudData(r: RaceState, cars: HudCar[], ghost: boolean, aspiration: Aspiration): HudData {
  const rc = r.cars[0];
  const c = rc.state;
  const countdownLeft = r.countdownTicks - r.tick;
  const countdown = countdownLeft > 0 ? Math.ceil(countdownLeft / 60) : countdownLeft > -60 ? 0 : null;
  const st = standings(r);
  const data: HudData = {
    mode: r.config.mode,
    position: st.findIndex((s) => s.car.index === 0) + 1,
    carCount: r.cars.length,
    lap: rc.lap,
    laps: r.config.laps,
    raceTime: rc.finished ? ticksToSeconds(rc.finishTick - r.countdownTicks) : raceTime(r),
    bestLap: rc.bestLap ? ticksToSeconds(rc.bestLap) : null,
    lastLap: rc.lapTimes.length ? ticksToSeconds(rc.lapTimes[rc.lapTimes.length - 1]) : null,
    speedMph: mph(c.speed),
    rpm: c.rpm,
    redline: rc.tuning.engine.redline,
    gear: c.gear,
    manual: c.manualGearbox,
    nitro: c.nitro,
    nitroActive: c.nitroActive,
    nitroStage: c.nitroStage,
    nitroOver: rc.tuning.nitrous.overdriveCap > 0 ? c.nitroOver / rc.tuning.nitrous.overdriveCap : 0,
    throttle: c.throttle,
    launchRpm: rc.tuning.launch.twoStepRpm || undefined,
    aspiration,
    boost: rc.tuning.engine.turbo ? c.boost : undefined,
    antilag: c.antilag,
    countdown,
    wrongWay: rc.wrongWay,
    progress: Math.max(0, rc.dist) / r.distance,
    drift: r.config.mode === 'drift' ? { total: r.drift.total, current: r.drift.current, multiplier: r.drift.multiplier, zoneBonus: r.drift.zoneBonus } : undefined,
    cars,
    ghost,
  };
  const zone = driftZoneStatus(r, 0);
  if (zone) data.zone = { mul: r.config.mode === 'drift' ? DRIFT_ZONES.scoreMul : DRIFT_ZONES.refillMul, nitro: r.config.mode !== 'drift', left: zone.left, resting: zone.resting };
  // The waypoint race points the compass and the minimap at the player's target (the nearest waypoint left).
  const target = r.config.mode === 'waypoint' && !rc.finished ? r.world.route.waypoints?.[rc.waypointTarget] : undefined;
  if (target) {
    const n = r.world.route.waypoints!.length - 1;
    data.waypoint = target;
    data.waypointLabel = rc.nextCheckpoint < n ? `Waypoint ${rc.nextCheckpoint + 1}/${n}` : 'Finish';
  }
  return data;
}

/** Free roam minimap: the traffic near the player as small dots (races keep the map to the field). */
export function trafficDotCars(t: Float32Array, px: number, pz: number): HudCar[] {
  const out: HudCar[] = [];
  for (let o = 0; o < t.length; o += TRAFFIC_SNAP) {
    if (t[o + 3] < 0 || (t[o] - px) ** 2 + (t[o + 1] - pz) ** 2 > TRAFFIC_DOT_RANGE ** 2) continue;
    out.push({ x: t[o], z: t[o + 1], yaw: t[o + 2], isPlayer: false, isTraffic: true });
  }
  return out;
}
