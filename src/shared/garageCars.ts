/**
 * The garage cars this build offers: every selectable car in `npm run dev`, only the manifest's `released` ones in
 * the builds Vercel serves (`FEATURES.allCars`; `?features=allCars` shows the rest on one device). The garage's
 * model list, the rivals, the showroom's lifts and the roadblocks' parked cars draw from it. A saved build of an
 * unreleased car still loads (`validateBuild` checks the selectable cars), so hiding a car never resets anyone's slot.
 */
import manifest from '../assets/carManifest.json';
import { SELECTABLE_CAR_IDS } from '../sim/tuning';
import { FEATURES } from './features';

const released = new Set((manifest.cars as { id: string; released?: boolean }[]).filter((c) => c.released).map((c) => c.id));

export const GARAGE_CAR_IDS: readonly string[] = SELECTABLE_CAR_IDS.filter((id) => FEATURES.allCars || released.has(id));
