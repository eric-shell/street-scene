/**
 * The game's words for what the analytics record: race types with their colors and icons, car names, quality
 * tiers and the frame-rate lines. Read from the game's own sources only where they are LEAF modules (the car
 * manifest, the palette): every game module the dashboard imports becomes a chunk the two pages share, and one
 * with imports drags its whole graph along (importing render/autoQuality put the settings, the sim and the city
 * config, 479 KB, into a chunk the dashboard loaded, which is why FRAME_BUDGET now lives in the leaf
 * render/frameBudget.ts). One table is restated here and must be kept in step: the race types (the menu's labels
 * and icons in ui/menu/menu.ts, palette.$modes in ui/styles/abstracts/_palette.scss).
 */
import { ChevronsRight, Compass, MapPinned, RotateCcw, Route, Wind, type IconNode } from 'lucide';
import manifest from '../../assets/carManifest.json';
import { FRAME_BUDGET } from '../../render/frameBudget';
import type { ErrorMeta } from '../../shared/analytics';
import type { PaletteColor } from '../../ui/kit/palette';
import type { RaceType } from '../../ui/settings';

export interface ModeInfo {
  label: string;
  icon: IconNode;
  /** palette.$modes: circuit orange, sprint yellow, drift red, drag purple, waypoint cyan, roam green. */
  ink: PaletteColor;
}

export const MODES: Record<RaceType, ModeInfo> = {
  circuit: { label: 'Circuit', icon: RotateCcw, ink: 'orange' },
  sprint: { label: 'Sprint', icon: Route, ink: 'yellow' },
  waypoint: { label: 'Waypoint', icon: MapPinned, ink: 'cyan' },
  drift: { label: 'Drift', icon: Wind, ink: 'red' },
  drag: { label: 'Drag', icon: ChevronsRight, ink: 'purple' },
  roam: { label: 'Free roam', icon: Compass, ink: 'green' },
};

/** The menu's race step order (ui/settings.ts RACE_TYPES), so rows read the way the player picks them. */
export const MODE_ORDER = ['circuit', 'sprint', 'waypoint', 'drift', 'drag', 'roam'] as const satisfies readonly RaceType[];

export function isMode(v: string): v is RaceType {
  return (MODE_ORDER as readonly string[]).includes(v);
}

/** A mode's label, or the raw string for one this build does not know. */
export function modeLabel(mode: string): string {
  return isMode(mode) ? MODES[mode].label : mode;
}

const CAR_NAMES = new Map(manifest.cars.map((c) => [c.id, c.displayName]));

/** `protoHatch` → `Proto Hatch`; an unknown id stays as sent. */
export function carName(id: string): string {
  return CAR_NAMES.get(id) ?? id;
}

/** What broke, as the timeline and the Errors card name it (shared/analytics.ts ErrorMeta). */
export const ERROR_KIND: Record<ErrorMeta['kind'], string> = { error: 'Error', rejection: 'Unhandled rejection', webgl: 'No WebGL', context_lost: 'Graphics reset', bad_frame: 'Bad frame' };

export type Tier = 'low' | 'medium' | 'high';
export const TIERS: readonly Tier[] = ['low', 'medium', 'high'];
export const TIER_LABEL: Record<Tier, string> = { low: 'Low', medium: 'Medium', high: 'High' };

/** FRAME_BUDGET's lines as frame rates: aim for 120, hold 60 on every device, never under 30. */
export const AIM_FPS = Math.round(1 / FRAME_BUDGET.aim);
export const HOLD_FPS = Math.round(1 / FRAME_BUDGET.hold);
export const FLOOR_FPS = Math.round(1 / FRAME_BUDGET.floor);

export type FpsStatus = 'holds' | 'under-hold' | 'under-floor';

/** Where a median frame rate sits against the hold and floor lines. */
export function fpsStatus(fps: number): FpsStatus {
  return fps >= HOLD_FPS ? 'holds' : fps >= FLOOR_FPS ? 'under-hold' : 'under-floor';
}

export const FPS_STATUS_LABEL: Record<FpsStatus, string> = {
  holds: `Holds ${HOLD_FPS}`,
  'under-hold': `Under ${HOLD_FPS}`,
  'under-floor': `Under ${FLOOR_FPS}`,
};
