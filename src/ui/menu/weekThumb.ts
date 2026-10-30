/**
 * One race day of the This Week step (week.ts), planned and drawn without a world. `planDay` runs the
 * city's plan (`planRoads`: the road graph, the districts and the event, no blocks, no buildings, about
 * 300 ms a seed) and keeps only what the step shows: the event's name, tagline and flavour, the circuit's
 * length and a thumbnail map. The thumbnail is drawn from the graph, the district polygons and the circuit
 * in the city map's inks (cityMap.ts), so a player reads the same colors here as on the home map. This
 * module touches no DOM, so weekWorker.ts runs it off the main thread and weekPlanner.ts falls back to it
 * where workers or OffscreenCanvas are missing.
 */
import { planRoads } from '../../city/world';
import { seedFromString } from '../../sim/prng';
import { isChannelEdge } from '../../city/roadGraph';
import type { EventFlavourId } from '../../city/events';
import type { AreaKind } from '../../city/districts/types';
import { KINDS, MAP_INK, shownOnMap } from '../map/cityMap';

/** The thumbnail's size (CSS px). */
export const THUMB_W = 160;
export const THUMB_H = 110;
/** Margin kept round the city in the thumbnail (CSS px). */
const PAD = 5;

/** What the step shows of a day. Small on purpose: it is posted from the worker and kept for the session. */
export interface DaySummary {
  seed: string;
  name: string;
  tagline: string;
  flavour: EventFlavourId;
  /** The weekend special the city really has (events.ts CityEvent.special), set on a Saturday or Sunday. */
  special?: { name: string; tagline: string };
  /** One lap of the circuit (m). */
  circuitLength: number;
  /** The distinct district kinds the city has that the map draws. */
  districts: AreaKind[];
  /** The map, THUMB_W x THUMB_H CSS px at `dpr`; an ImageBitmap from the worker, else a canvas. */
  thumb: CanvasImageSource;
  /** Device pixels per CSS pixel the thumbnail was drawn at. */
  dpr: number;
}

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A planned day: its summary less the thumbnail, and the painter that draws that thumbnail on a context of THUMB_W x THUMB_H CSS px at `dpr`. */
export interface PlannedDay {
  summary: Omit<DaySummary, 'thumb' | 'dpr'>;
  draw(ctx: Ctx2D, dpr: number): void;
}

/** Plan a seed's roads and event (`seed` is the text, hashed as the game does). */
export function planDay(seed: string): PlannedDay {
  const plan = planRoads(seedFromString(seed));
  const { graph, districts, routeNodes, event } = plan;
  const kinds = new Set<AreaKind>();
  for (const a of districts.areas) if (KINDS[a.kind]?.tag && shownOnMap(a)) kinds.add(a.kind);
  const loop = routeNodes.circuit.map((i) => graph.nodes[i]);
  let length = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    length += Math.hypot(b.x - a.x, b.z - a.z);
  }
  const summary: PlannedDay['summary'] = {
    seed,
    name: event.name,
    tagline: event.tagline,
    flavour: event.id,
    ...(event.special ? { special: { name: event.special.name, tagline: event.special.tagline } } : {}),
    circuitLength: length,
    districts: [...kinds],
  };
  const draw = (c: Ctx2D, dpr: number) => {
    const b = graph.bounds;
    const s = Math.min((THUMB_W - 2 * PAD) / (b.maxX - b.minX), (THUMB_H - 2 * PAD) / (b.maxZ - b.minZ));
    const mx = (b.minX + b.maxX) / 2;
    const mz = (b.minZ + b.maxZ) / 2;
    // North (+Z) up puts world +X on the left, as every map in the game draws the city.
    c.setTransform(-s * dpr, 0, 0, -s * dpr, (THUMB_W / 2 + mx * s) * dpr, (THUMB_H / 2 + mz * s) * dpr);
    c.fillStyle = MAP_INK.ground;
    c.fillRect(b.minX - 1e4, b.minZ - 1e4, b.maxX - b.minX + 2e4, b.maxZ - b.minZ + 2e4);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const px = 1 / s;
    // District fills.
    for (const a of districts.areas) {
      const st = KINDS[a.kind];
      if (!st?.fill || a.polygon.length < 3 || a.kind === 'roundabout' || a.kind === 'bluff' || a.kind === 'waterfront' || !shownOnMap(a)) continue;
      c.fillStyle = st.fill;
      c.beginPath();
      a.polygon.forEach((p, i) => (i ? c.lineTo(p.x, p.z) : c.moveTo(p.x, p.z)));
      c.closePath();
      c.fill();
    }
    // Streets by ink, one stroke per group.
    const groups = new Map<string, { ink: string; width: number; path: Path2D }>();
    for (const e of graph.edges) {
      const ink = isChannelEdge(e) ? MAP_INK.channel : e.kind === 'alley' ? KINDS.alley!.ink : e.shortcut ? MAP_INK.shortcut : MAP_INK.road;
      const width = Math.max(0.7, Math.round(e.width * s * 2) / 2) * px;
      const key = `${ink}:${width}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { ink, width, path: new Path2D() }));
      g.path.moveTo(graph.nodes[e.a].x, graph.nodes[e.a].z);
      g.path.lineTo(graph.nodes[e.b].x, graph.nodes[e.b].z);
    }
    for (const g of [...groups.values()].sort((x, y) => Number(x.ink !== MAP_INK.road) - Number(y.ink !== MAP_INK.road))) {
      c.strokeStyle = g.ink;
      c.lineWidth = g.width;
      c.stroke(g.path);
    }
    // Lines that have no fill: the El, the expressway, the cable car.
    for (const a of districts.areas) {
      if ((a.kind !== 'subway' && a.kind !== 'highway' && a.kind !== 'cableCar') || a.path.length < 2) continue;
      c.strokeStyle = KINDS[a.kind]!.ink;
      c.lineWidth = 1.3 * px;
      c.beginPath();
      a.path.forEach((p, i) => (i ? c.lineTo(p.x, p.z) : c.moveTo(p.x, p.z)));
      c.stroke();
    }
    // The circuit, over everything.
    c.strokeStyle = MAP_INK.route;
    c.lineWidth = 2 * px;
    c.beginPath();
    loop.forEach((p, i) => (i ? c.lineTo(p.x, p.z) : c.moveTo(p.x, p.z)));
    c.closePath();
    c.stroke();
  };
  return { summary, draw };
}
