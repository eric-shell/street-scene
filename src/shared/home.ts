/**
 * A seed's home neighbourhood, as a pure pick from the seed alone. The renderer's city identity (render/cityIdentity.ts)
 * builds its grade, lamps and architecture on it; it lives here, with no three.js behind it, so the city's own planning
 * can lean on the same answer (the waterfront's beach is likelier in a Miami, districts/waterfront.ts) without the sim
 * ever reading the renderer. One stream, `deriveSeed(seed, 'identity')`: the home is an even pick of the five.
 */
import { Rng, deriveSeed } from '../sim/prng';

/** The five neighbourhoods a city can call home (architecture.ts's Region is the same union). */
export type Home = 'nyc' | 'la' | 'sf' | 'philly' | 'miami';

export const HOMES: readonly Home[] = ['nyc', 'la', 'sf', 'philly', 'miami'];

/** The seed's home neighbourhood. */
export function homeOf(seed: number): Home {
  return new Rng(deriveSeed(seed, 'identity')).pick(HOMES);
}
