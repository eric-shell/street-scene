/**
 * Exposure by zone: the eye adapts going into a tunnel and under a deck. The
 * target comes from what is over the camera or car (ceilings.ts overheadAt:
 * tunnel bore, other cover such as viaduct, highway deck or the El, open
 * sky); `ExposureAdapt` eases the tone mapping exposure and the fog density
 * toward it, quickly into the dark and slowly out, holding the tunnel's
 * brightness for a beat after the portal (the blow-out) before it settles.
 * Render only; the zone test is bounding boxes plus a few polygon tests per
 * frame (see overheadAt) and nothing here allocates.
 */
import type * as THREE from 'three';
import type { World } from '../city/world';
import { damp } from '../shared/anim';
import { overheadAt, type Overhang } from './camera/ceilings';

/** The exposure adaptation numbers. */
export const EXPOSURE = {
  /** Tone mapping exposure in the open street (matches GameRenderer's start value). */
  open: 1.05,
  /** Under a viaduct, a highway deck, a bridge, a garage level or the El. */
  covered: 1.15,
  /** Inside a tunnel bore: the sodium strips want a brighter exposure. */
  tunnel: 1.35,
  /** Fog density multiplier inside a tunnel bore, so the strips read down its length. */
  tunnelFog: 0.5,
  /** Fog density multiplier under other cover. */
  coveredFog: 1,
  /** Adaptation rate going to a higher exposure (1/s, about 0.2 s to settle): fast into the dark. */
  rateIn: 5,
  /** Adaptation rate going back to a lower exposure (1/s, about 0.9 s). */
  rateOut: 1.1,
  /** After leaving a tunnel the exposure stays above open street for this long (s) before it settles. */
  blowout: 0.6,
  /** The exposure held through the blow-out (a little above the tunnel's). */
  blowoutExposure: 1.4,
} as const;

/** Target exposure and fog multiplier per zone. */
const TARGETS: Record<Overhang, { exposure: number; fog: number }> = {
  open: { exposure: EXPOSURE.open, fog: 1 },
  covered: { exposure: EXPOSURE.covered, fog: EXPOSURE.coveredFog },
  tunnel: { exposure: EXPOSURE.tunnel, fog: EXPOSURE.tunnelFog },
};

/** The smoothed exposure and fog multiplier, advanced once per frame. */
export class ExposureAdapt {
  exposure: number = EXPOSURE.open;
  fogMul = 1;
  private hold = 0;
  private wasTunnel = false;

  /** Advance by dt (s) with the zone at (x, y, z) in the world. */
  update(world: World, x: number, y: number, z: number, dt: number): void {
    const zone = overheadAt(world, x, y, z);
    const tunnel = zone === 'tunnel';
    if (tunnel) this.hold = 0;
    else if (this.wasTunnel) this.hold = EXPOSURE.blowout;
    this.wasTunnel = tunnel;
    let te = TARGETS[zone].exposure;
    let tf = TARGETS[zone].fog;
    if (this.hold > 0) {
      this.hold -= dt;
      te = EXPOSURE.blowoutExposure;
      tf = EXPOSURE.tunnelFog;
    }
    this.exposure += (te - this.exposure) * damp(te > this.exposure ? EXPOSURE.rateIn : EXPOSURE.rateOut, dt);
    // Fog thins as fast as the eye opens, and thickens back at the slow rate.
    this.fogMul += (tf - this.fogMul) * damp(tf < this.fogMul ? EXPOSURE.rateIn : EXPOSURE.rateOut, dt);
  }

  /** Write the result: the renderer's exposure and the scene fog at the mood's base density. */
  apply(setExposure: (v: number) => void, fog: THREE.FogExp2 | null, baseDensity: number): void {
    setExposure(this.exposure);
    if (fog) fog.density = baseDensity * this.fogMul;
  }
}
