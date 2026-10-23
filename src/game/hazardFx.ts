/**
 * Timed hazards on screen for one race session: drives the HUD warning
 * (ui/hud/hazardBanner.ts) from what the player's car is heading at: the
 * level crossing gates ahead warning or coming down, or holding traffic back
 * (with the seconds left). Reads race state only; the gates themselves are
 * posed by the bluff renderer at the session's interpolated tick.
 */
import type { RaceState } from '../sim/race';
import { HazardBanner } from '../ui/hud/hazardBanner';
import { gateAhead, gatePhase, newGatePhase } from '../sim/gates';
import { TICK_HZ } from '../sim/constants';

/** The warning shows for gates the player heads at within this far (m). */
const WARN = { range: 230 } as const;

export class HazardFx {
  private readonly banner: HazardBanner;
  private readonly phase = newGatePhase();

  constructor(hudRoot: HTMLElement) {
    this.banner = new HazardBanner(hudRoot);
  }

  /** Once per rendered frame. */
  update(r: RaceState): void {
    this.banner.set(...this.warning(r));
  }

  private warning(r: RaceState): [string | null, 'warn' | 'stop'] {
    const set = r.world.timedGates;
    const rc = r.cars[0];
    if (!set || !set.gates.length || rc.finished) return [null, 'warn'];
    const c = rc.state;
    const ahead = gateAhead(set, c.x, c.z, Math.sin(c.yaw), Math.cos(c.yaw), WARN.range);
    if (!ahead) return [null, 'warn'];
    const p = gatePhase(set.cycles[set.gates[ahead.gate].cycle], r.tick, this.phase);
    if (p.name === 'warn' || p.name === 'lowering') return ['GATES CLOSING', 'warn'];
    if (p.blocking) return [`GATES DOWN ${Math.ceil(p.untilClear / TICK_HZ)}s`, 'stop'];
    return [null, 'warn'];
  }

  dispose(): void {
    this.banner.dispose();
  }
}
