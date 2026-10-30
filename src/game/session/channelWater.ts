/**
 * Feeds the concrete channel's water voice (audio/sceneVoices.ts ChannelWater) from where the listening car is.
 * Down on the channel floor (its body well below the bank top) the water is full; on a bridge deck or the
 * banks' edge it is faint; it falls away with the distance from the channel's top edge and is silent elsewhere,
 * and it fades out over the channel's ends. The voice is made the first time the car comes near, after a user
 * gesture. Shared by the race session and the menu's street stage. Reads the world only.
 */
import { CITY } from '../../city/config';
import { channelCenter, channelL } from '../../city/districts/channel';
import type { Area } from '../../city/districts/types';
import type { World } from '../../city/world';
import { smoothstep } from '../../sim/math';
import { damp } from '../../shared/anim';
import { ChannelWater } from '../../audio/sceneVoices';

const CFG = CITY.districts.channel;

const WATER_FEED = {
  /** Level at the bank's top edge or on a deck over the floor, against 1 down on the floor. */
  edge: 0.18,
  /** Falls to 1/e this far past the top edge (m), and is silent past `cut` (m). */
  falloff: 12,
  cut: [30, 50] as const,
  /** The level fades out over this far beyond the channel's ends (m). */
  ends: 40,
  /** How fast the drop into the channel is followed (1/s), so a car climbing a ramp eases the water out. */
  follow: 6,
} as const;

export class ChannelWaterFeed {
  private voice: ChannelWater | null = null;
  private tried = false;
  private readonly area: Area | null;
  /** Smoothed fraction of the channel's depth the car is down (0 at the lip, 1 on the floor). */
  private drop = 0;

  constructor(private readonly world: World) {
    this.area = world.areas.find((a) => a.kind === 'channel') ?? null;
  }

  /** The listening car at (x, y, z) and the z of the camera's right vector (0 when there is none); call every rendered frame the scene is live. */
  update(x: number, y: number, z: number, rz: number, dt: number): void {
    const area = this.area;
    if (!area) return;
    const p = area.params;
    const lat = Math.abs(channelL(p, x, z));
    const beyond = Math.max(0, lat - p.top);
    const along = 1 - Math.min(1, Math.max(0, p.x0 - x, x - p.x1) / WATER_FEED.ends);
    if (beyond > WATER_FEED.cut[1] || along <= 0) {
      // Out of earshot: let the voice's own dead man's switch close it, and forget the drop.
      this.drop = 0;
      return;
    }
    const centre = channelCenter(p, x);
    let target = 0;
    if (beyond === 0) {
      const lip = this.world.heightAt(x, centre + p.top + 2);
      target = Math.min(1, Math.max(0, (lip - y) / p.depth));
    }
    this.drop += (target - this.drop) * damp(WATER_FEED.follow, dt);
    const reach = Math.exp(-beyond / WATER_FEED.falloff) * (1 - smoothstep(WATER_FEED.cut[0], WATER_FEED.cut[1], beyond));
    const level = along * reach * (WATER_FEED.edge + (1 - WATER_FEED.edge) * this.drop * this.drop);
    if (level < 0.003) return;
    if (!this.voice && !this.tried) {
      this.voice = ChannelWater.create();
      this.tried = this.voice !== null || !ChannelWater.blocked();
    }
    // Toward the trickle (a little to one side of the centerline), against the camera's right.
    const dz = centre + CFG.waterOffset - z;
    this.voice?.update(level, (dz * rz) / (Math.abs(dz) + 4));
  }

  dispose(): void {
    this.voice?.dispose();
    this.voice = null;
  }
}
