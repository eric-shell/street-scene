/**
 * The full map's tuning, inks and the small helpers its parts share (the
 * camera, the painters, the name tags and the side panel): motion and
 * interaction numbers, overlay colors, the legend's sections and the layers
 * in them, which areas are shortcuts or minor places, the pin's shape and the
 * compass rose.
 */
import type { Area, AreaKind } from '../../city/districts/types';
import type { Vec2 } from '../../sim/math';
import { KINDS, MAP_INK } from './cityMap';
import { isNamedPlace } from './placeNames';
import { PALETTE, rgba } from '../kit/palette';
import { M_PER_FT, M_PER_MI } from '../kit/units';

/** Motion, interaction and drawing tuning. Lengths in CSS px, times in s, rates in 1/s. */
export const UI = {
  /** Deepest zoom, in multiples of the fitted city. */
  maxZoom: 8,
  /** Ease rates: the scale toward a wheel or key zoom, the center toward a key pan or a spring back, a fling's glide. */
  zoomRate: 14,
  panRate: 12,
  flingRate: 4.5,
  /** A fly-to (find me, fit, a place) lasts flyTime, plus up to flyExtra on a long trip, pulling back up to bump (log zoom). */
  flyTime: 0.55,
  flyExtra: 0.4,
  bump: 0.8,
  /** Wheel zoom per pixel of scroll; a trackpad pinch (ctrl + wheel) reports much smaller steps. */
  wheel: 0.0022,
  pinchWheel: 0.012,
  /** Zoom step of the buttons and the + and - keys, and of a double click. */
  step: 1.6,
  dblStep: 2,
  /** Find me zooms in to at least this; a place is framed between these zooms. */
  findZoom: 3,
  placeMin: 1.4,
  placeMax: 5,
  /** Key pan speed. */
  keyPan: 760,
  /** A press that travels this far is a drag, not a click (a finger gets more room). */
  dragSlop: 5,
  touchSlop: 10,
  /** Two clicks this close in time and space are a double click. */
  dblTime: 0.26,
  dblDist: 22,
  /** A drag released faster than this flings on; past the city's edge a drag moves the view this share of the way. */
  minFling: 160,
  rubber: 0.3,
  /** The open: the panel lands, then the map is revealed outwards from the player. */
  revealDelay: 0.14,
  revealTime: 0.7,
  /** Route dashes: their march speed and pattern. */
  march: 16,
  dash: 3,
  gap: 11,
  /** The player's two pings, a beat apart (the menu maps' map-ping). */
  ping: 2.4,
  /** The waypoint pin drops in, then a ripple spreads from it; a place picked from the list pulses. */
  drop: 0.45,
  ripple: 0.6,
  pulse: 1.8,
  /** Hit radii: the waypoint pin's head, the start and finish discs. */
  pinHit: 15,
  markHit: 12,
  /** The view's bitmap margin (share of the canvas), the least time between redraws while moving, the zoom it may drift. */
  margin: 0.15,
  rasterGap: 0.09,
  rasterDrift: 1.3,
  /** Highlight and tag fades. */
  fade: 12,
  tagFade: 10,
  /** Minor places (roundabouts, lots, shortcuts...) get tags from this zoom. */
  minorZoom: 2.4,
  /** The grid's cell (m), labelled A, B, C... across and 1, 2, 3... down; 100 m lines show in between from minorGrid px per cell. */
  grid: 200,
  minorGrid: 64,
  /** How often live readouts (where you are, distances) refresh. */
  live: 0.5,
  /** Decoration alone (dashes, pings) redraws at most this often. */
  idleHz: 60,
} as const;

/** Inks of the overlays (the city's own are MAP_INK and KINDS in cityMap.ts). */
export const INK = {
  veil: PALETTE.bg0,
  grid: 'rgba(252, 252, 250, 0.075)',
  gridMinor: 'rgba(252, 252, 250, 0.035)',
  band: 'rgba(25, 24, 26, 0.82)',
  label: PALETTE.muted,
  routeDash: 'rgba(255, 238, 220, 0.95)',
  ping: PALETTE.orange,
  pin: PALETTE.yellow,
  outline: PALETTE.bg0,
  player: PALETTE.text,
  plate: rgba('bg0', 0.8),
  scaleLight: PALETTE.soft,
  scaleDark: PALETTE.bg3,
  font: MAP_INK.font,
} as const;

/** A legend row that shows and hides district kinds: kinds that read as one thing share a row (the water, the high ground). */
export interface LegendLayer {
  key: LayerKey;
  label: string;
  kinds: readonly AreaKind[];
}
export type LayerKey = 'park' | 'water' | 'high' | 'monument' | 'market' | 'carPark' | 'infill' | 'subway' | 'highway' | 'alley' | 'backAlley' | 'tunnel' | 'overpass' | 'roundabout' | 'roadworks';

/** The legend's district sections in order; layers missing from the city are left out, and a section with none. */
export const LEGEND_SECTIONS: readonly { title: string; layers: readonly LegendLayer[] }[] = [
  {
    title: 'Places',
    layers: [
      { key: 'park', label: 'Parks', kinds: ['park'] },
      { key: 'water', label: 'Water', kinds: ['river', 'lake', 'waterfront'] },
      { key: 'high', label: 'High ground', kinds: ['hills', 'bluff'] },
      { key: 'monument', label: 'Monuments', kinds: ['monument'] },
      { key: 'market', label: 'Night markets', kinds: ['market'] },
      { key: 'carPark', label: 'Parking garages', kinds: ['carPark'] },
      { key: 'infill', label: 'Plazas and lots', kinds: ['infill'] },
    ],
  },
  {
    title: 'Streets',
    layers: [
      { key: 'subway', label: 'The El', kinds: ['subway'] },
      { key: 'highway', label: 'Expressway', kinds: ['highway'] },
      { key: 'alley', label: 'Raceway alleys', kinds: ['alley'] },
      { key: 'backAlley', label: 'Back alleys', kinds: ['backAlley'] },
      { key: 'tunnel', label: 'Tunnels', kinds: ['tunnel'] },
      { key: 'overpass', label: 'Overpasses', kinds: ['overpass'] },
      { key: 'roundabout', label: 'Roundabouts', kinds: ['roundabout'] },
      { key: 'roadworks', label: 'Roadworks', kinds: ['roadworks'] },
    ],
  },
];
const LAYERS = new Map<string, LegendLayer>(LEGEND_SECTIONS.flatMap((s) => s.layers.map((l) => [l.key, l] as const)));

/** What a legend row stands for: a layer of district kinds, one neighbourhood (`hood:<id>`), all of their borders, or one of the map's own marks. */
export type LegendKey = LayerKey | 'you' | 'route' | 'shortcut' | 'waypoint' | 'hoods' | `hood:${number}`;

/** The district kinds a legend row shows and hides (none for the map's own marks and the neighbourhoods). */
export const kindsOf = (key: LegendKey | null): readonly AreaKind[] => (key && LAYERS.get(key)?.kinds) || [];
/** The neighbourhood a legend row stands for, or -1. */
export const hoodKey = (key: LegendKey | null): number => (key?.startsWith('hood:') ? Number(key.slice(5)) : -1);

export const isShortcut = (a: Area) => a.kind === 'backAlley' && a.variant === 'routeShortcut';
/** Small places tagged only once zoomed in. */
export const isMinor = (a: Area) => a.kind === 'roundabout' || a.kind === 'overpass' || a.kind === 'roadworks' || isShortcut(a) || (a.kind === 'infill' && isNamedPlace(a));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeOut = (t: number) => 1 - (1 - t) ** 3;
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** A drop that lands, bounces once and settles. */
export const bounceOut = (t: number) => (t < 0.62 ? (t / 0.62) ** 2 : 1 - 0.22 * Math.sin(((t - 0.62) / 0.38) * Math.PI) * (1 - (t - 0.62) / 0.38));

/** Grid column name: A..Z, then AA, AB... */
export const colName = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));

/** Append a closed polygon or an open polyline (world m) to a path. */
export function trace(p: Path2D, pts: readonly Vec2[], closed: boolean): void {
  for (let i = 0; i < pts.length; i++) (i ? p.lineTo(pts[i].x, pts[i].z) : p.moveTo(pts[i].x, pts[i].z));
  if (closed) p.closePath();
}

/** A legend kind's or an area's ink on the map (the race shortcuts have their own). */
export function inkOf(a: Area | null): string {
  if (!a) return PALETTE.soft;
  if (isShortcut(a)) return MAP_INK.shortcut;
  return KINDS[a.kind]?.ink ?? PALETTE.soft;
}

/** Where the pin's drop (0..1) and landing ripple end, in drop lengths. */
export const DROP_END = 1 + UI.ripple / UI.drop;
/** The player's two pings start this far apart (s), and a picked place's two rings. */
export const PINGS = [0, UI.ping / 2] as const;
export const PULSE_RINGS = [0, 0.45] as const;
export const NO_DASH: number[] = [];
/** Scale bar lengths in round US units (ui/units.ts), shortest first. */
export const SCALE_STEPS = [
  ...[50, 100, 250, 500, 1000].map((ft) => ({ m: ft * M_PER_FT, label: `${ft} ft` })),
  ...[0.25, 0.5, 1].map((mi) => ({ m: mi * M_PER_MI, label: `${mi} mi` })),
] as const;
/** Keys that pass through while the map is open: music (M, [ and ]), the dev panels and the function keys. */
export const PASS_KEYS = /^(KeyM|BracketLeft|BracketRight|Backquote|F\d+)$/;
/** The waypoint pin (CSS px): its canvas, the tip's height in it, the head's center above the tip and its radius. */
export const PIN = { w: 22, h: 30, tip: 27, head: 15, r: 7.5 } as const;

/** The compass rose in the map's corner: north in yellow (the map never turns, so it is static markup). */
export const ROSE_SVG = `<svg viewBox="-26 -30 52 56" width="52" height="56">
<circle r="17" fill="rgba(25,24,26,0.8)" stroke="rgba(252,252,250,0.22)"/>
<circle r="12.5" fill="none" stroke="rgba(252,252,250,0.08)"/>
<path d="M0 -15 L4 0 L-4 0Z" fill="#ffd866"/><path d="M0 15 L4 0 L-4 0Z" fill="#727072"/>
<path d="M-13 0 L0 -2.6 L0 2.6Z M13 0 L0 -2.6 L0 2.6Z" fill="#5b595c"/>
<circle r="1.8" fill="#19181a"/>
<text y="-20.5" text-anchor="middle" font-size="10" font-weight="900" fill="#ffd866">N</text>
</svg>`;
