/**
 * What the dot-matrix band under the gantry signs says during a race: the player's place and lap, the gap
 * to the leader (or to second, when leading), the fastest lap once there is one, FINAL LAP on the last lap
 * and FINISH P2 after the line. Read off the race state, never written; the session calls it at
 * `DIEGETIC.band.refreshHz` and the band only redraws when a page's text changes. Render only.
 */
import { standings, ticksToSeconds, type RaceState } from '../../sim/race';
import type { BandPage } from '../../render/race/gantryBand';

/** A lap time as m:ss.t. */
function lapText(seconds: number): string {
  const t = Math.floor(seconds * 10 + 1e-6);
  const m = Math.floor(t / 600);
  const s = Math.floor((t % 600) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${t % 10}`;
}

/** The pages for this race state, the player's view of it. */
export function gantryPages(r: RaceState, eventName: string): BandPage[] {
  const rc = r.cars[0];
  const st = standings(r);
  const place = st.findIndex((s) => s.car.index === 0) + 1;
  const n = r.cars.length;
  if (rc.finished) {
    const pages: BandPage[] = [{ text: `FINISH P${place}`, tone: place === 1 ? 'green' : 'pink' }];
    pages.push({ text: lapText(ticksToSeconds(rc.finishTick - r.countdownTicks)), tone: 'white' });
    return pages;
  }
  if (r.tick < r.countdownTicks) return [{ text: eventName.toUpperCase(), tone: 'amber' }, { text: `P${place} OF ${n}`, tone: 'green' }];
  const laps = r.config.laps;
  const circuit = r.world.route.closed && laps > 1;
  const pages: BandPage[] = [];
  if (circuit && rc.lap === laps - 1) pages.push({ text: 'FINAL LAP', tone: 'red', flash: true });
  pages.push({ text: circuit ? `P${place} LAP ${Math.min(laps, rc.lap + 1)}/${laps}` : `P${place} OF ${n}`, tone: 'amber' });
  if (n > 1) {
    // Seconds at the player's pace (a floor keeps a standing start from reading minutes).
    const pace = Math.max(15, rc.state.speed);
    if (place === 1) {
      const second = st[1].car;
      pages.push({ text: `AHEAD +${((rc.dist - second.dist) / pace).toFixed(1)}S`, tone: 'green' });
    } else {
      pages.push({ text: `LEADER +${((st[0].car.dist - rc.dist) / pace).toFixed(1)}S`, tone: 'white' });
    }
  }
  if (circuit) {
    let best = 0;
    for (const c of r.cars) if (c.bestLap && (!best || c.bestLap < best)) best = c.bestLap;
    if (best) pages.push({ text: `BEST ${lapText(ticksToSeconds(best))}`, tone: 'white' });
  }
  return pages;
}
