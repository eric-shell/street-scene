/**
 * Timed hazards on screen for one race session: poses the drawbridge view
 * (render/drawbridge.ts) at the interpolated sim tick every frame, so a
 * replay shows the same bridge at the same moment, lets its bell ring only
 * while the session runs, and drives the HUD warning (ui/hazardBanner.ts)
 * from what the player's car is heading at: the gates ahead warning or coming
 * down, holding traffic back (with the seconds left), or the span under the
 * car about to lift. Reads race state only.
 */
import type { RaceState } from '../sim/race';
import type { DrawbridgeView } from '../render/drawbridge';
import { HazardBanner } from '../ui/hazardBanner';
import { gateAhead, gatePhase } from '../sim/gates';
import type { GatePhase } from '../sim/gates';
import { leafAngle, onSpan } from '../city/drawbridge';
import { TICK_HZ } from '../sim/constants';

/** The warning shows for gates the player heads at within this far (m); the span counts this far past its hinges (m). */
const WARN = { range: 230, spanMargin: 1 } as const;

export class HazardFx {
  private readonly banner: HazardBanner;
  private readonly phase: GatePhase = { name: 'open', t: 0, len: 0, arm: 0, blocking: false, untilBlock: 0, untilClear: 0, cycleT: -1 };

  constructor(
    private readonly view: DrawbridgeView,
    hudRoot: HTMLElement,
  ) {
    this.banner = new HazardBanner(hudRoot);
  }

  /** Once per rendered frame: `alpha` is the loop's interpolation, `audible` false while paused. */
  update(r: RaceState, alpha: number, audible: boolean): void {
    const tick = Math.max(0, r.tick - 1 + alpha);
    this.view.sync(tick, audible);
    this.banner.set(...this.warning(r));
  }

  private warning(r: RaceState): [string | null, 'warn' | 'stop'] {
    const set = r.world.timedGates;
    const rc = r.cars[0];
    if (!set || !set.gates.length || rc.finished) return [null, 'warn'];
    const c = rc.state;
    const db = r.world.drawbridge;
    if (db && onSpan(db, c.x, c.z, WARN.spanMargin)) {
      const p = gatePhase(set.cycles[db.cycle], r.tick, this.phase);
      if ((p.name === 'lowering' || p.name === 'closed') && leafAngle(db, set, r.tick) === 0) return ['CLEAR THE BRIDGE', 'stop'];
      return [null, 'warn'];
    }
    const ahead = gateAhead(set, c.x, c.z, Math.sin(c.yaw), Math.cos(c.yaw), WARN.range);
    if (!ahead) return [null, 'warn'];
    const p = gatePhase(set.cycles[set.gates[ahead.gate].cycle], r.tick, this.phase);
    // The drawbridge's gates say so; any other timed gate gets the plain wording.
    const bridge = !!db && db.gates.includes(ahead.gate);
    if (p.name === 'warn' || p.name === 'lowering') return [bridge ? 'BRIDGE RISING' : 'GATES CLOSING', 'warn'];
    if (p.blocking) return [`${bridge ? 'BRIDGE UP' : 'GATES DOWN'} ${Math.ceil(p.untilClear / TICK_HZ)}s`, 'stop'];
    return [null, 'warn'];
  }

  dispose(): void {
    this.banner.dispose();
  }
}
