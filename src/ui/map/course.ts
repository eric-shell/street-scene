/**
 * What a caller hands the full city map (ui/map/fullMap.ts): its options, the
 * store a waypoint is kept in, and the course look of each race type, one table
 * so the menu's race step and a race's own map draw a type alike. Types and one
 * table, no DOM; fullMap.ts re-exports them, so callers import from either.
 */
import type { Route as RaceRoute } from '../../city/route';
import type { Vec2 } from '../../sim/math';
import type { MapCar } from '../hud/minimap';
import type { PaletteColor } from '../kit/palette';
import type { RaceType } from '../settings';

/** Where a waypoint is kept: by whoever owns the map's city (main.ts keeps one per event city, so one set on the menu carries into free roam). */
export interface WaypointStore {
  get(): Vec2 | null;
  set(p: Vec2 | null): void;
}

export interface FullMapOptions {
  /** Close request: the close button, the backdrop, Tab or Escape. The owner then calls dispose(). */
  onClose(): void;
  /** The player's pose now, read every frame (the menu's cruising car); without it the marker stays where `player` put it. */
  livePlayer?: () => MapCar;
  /**
   * Where the waypoint is kept: a click on the map or a place's pin button
   * sets it, a click on the pin or Clear removes it. Free roam and the menu
   * share one per event city; without it the map sets none.
   */
  waypoint?: WaypointStore;
  /** Free roam: put the car down at the waypoint (the waypoint card's Teleport button, or T); the owner closes the map. Without it the map offers none. */
  teleport?(at: Vec2): void;
  /** Header chips: the event's name and the seed. */
  event?: string;
  seed?: string;
  /**
   * The course to draw: a route in its race type's color under that type's
   * name, with the drift zones lit for drift (the menu's race step), or none
   * (free roam picked on the menu: the whole city is the course). Without it
   * the world's own route shows in orange, as free roam shows it to find your
   * way.
   */
  course?: { route: RaceRoute | null; ink: PaletteColor; label: string; zones?: boolean };
}

/** Each race type's course look on the map: one table, so the menu's race step and a race's own map draw a type alike. */
const COURSE_STYLE: Record<RaceType, Omit<NonNullable<FullMapOptions['course']>, 'route'>> = {
  circuit: { ink: 'orange', label: 'Circuit' },
  sprint: { ink: 'yellow', label: 'Sprint' },
  drag: { ink: 'purple', label: 'Drag strip' },
  waypoint: { ink: 'cyan', label: 'Waypoint race' },
  drift: { ink: 'red', label: 'Drift', zones: true },
  roam: { ink: 'green', label: 'Free roam' },
};

/** The map's course for a race type on `route` (free roam has none: the whole city is the course). */
export function courseFor(type: RaceType, route: RaceRoute | null): NonNullable<FullMapOptions['course']> {
  return { route: type === 'roam' ? null : route, ...COURSE_STYLE[type] };
}
