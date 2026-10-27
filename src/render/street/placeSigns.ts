/**
 * The signs that name places in the world, so it calls the city what the map does (city/names):
 *
 *  - Street name blades at the junctions. Each junction where two or more named streets meet
 *    (city/names/streetNames.ts) gets a flat double sided plate per street on the traffic light pole
 *    nearest its middle (a streetlight pole where a junction has no signal), stacked big street on top,
 *    each lying along its street so a driver on the cross street reads it face on. Reflective green or
 *    blue by the seed's home region (cityIdentity.ts). A blade goes with its pole: `setPoleBroken` (the
 *    props' onBroken hook) collapses the pole's plates to degenerate triangles, and restores them when the
 *    prop stands again.
 *  - Neighbourhood gateways (city/names/gateways.ts): a banner strung across the street, wall to wall at
 *    6.6 m like the event banners (buildings/wallDressing.ts), at the street a driver first comes into
 *    each neighbourhood by, naming it; readable from both ways. Found by probing the drawn facades
 *    (wallProbe.ts); where no two facades face each other it is a plaque on one wall instead.
 *
 * Two draw calls at most (one mesh and atlas each), Medium and up, built once from the world; nothing
 * per frame. The meshes are far below the chunker's size floor (cityChunks.ts CHUNKS.minTris), so they are
 * named for the `detail` class but draw whole, which is also what lets the pole hook edit the index buffer
 * in place. Render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { hoodGateways } from '../../city/names/gateways';
import { streetNames } from '../../city/names/streetNames';
import type { Prop } from '../../city/props';
import type { Quality } from '../../ui/settings';
import { cityIdentity } from '../cityIdentity';
import { GeoBuilder } from '../geoBuilder';
import { FacadeProbe } from '../buildings/wallProbe';
import { makeGatewayAtlas, makeStreetBladeAtlas, placeCellUV, type BladeTone } from '../textures/placeSignAtlases';

/** Sizes and heights (m) of the place signs, and the tiers that get them. */
export const PLACE_SIGNS = {
  /** Street blade: length, height, the gap before the pole it hangs off, and the height of the lowest plate's centre above the pole's foot. */
  bladeW: 1.4,
  bladeH: 0.35,
  bladeReach: 0.18,
  bladeY: 4.15,
  /** Height step between the plates of one pole (m). */
  bladeStep: 0.4,
  /** How far from a junction's middle a streetlight may stand to carry its blades when no signal does (m). */
  poleSearch: 18,
  /** Gateway banner: height over the street (m), sag at the middle (m), cloth height (m), the probe's reach past the sidewalk (m). */
  bannerY: [6.6, 5.7] as readonly number[],
  bannerSag: 0.7,
  bannerH: 1.15,
  bannerProbe: 1.8,
  /** Where along the street (m past the gateway's spot) a gateway may move to find its walls, and how far it keeps from a junction (m). */
  bannerSlide: [0, 8, 16, -8, 24, 32] as readonly number[],
  junctionClear: 14,
  /** The wall plaque a gateway falls back to: height of its middle over the street, width and the least width worth hanging (m). */
  plaqueY: 3.6,
  plaqueW: 4.4,
  plaqueMin: 2.6,
  /** Tiers that get them. */
  tiers: { low: false, medium: true, high: true } as Record<Quality, boolean>,
} as const;

/** The reflective sheeting colour of a home region's street blades. */
const BLADE_TONE: Record<string, BladeTone> = { nyc: 'green', philly: 'green', la: 'blue', sf: 'blue', miami: 'blue' };

export interface PlaceSignsOptions {
  quality: Quality;
  /** The drawn podium geometry (cityMeshes 'podiums'): the gateway banners are strung between its facades. */
  facades?: THREE.BufferGeometry | null;
}

export interface PlaceSigns {
  group: THREE.Group;
  /** A pole (prop id) broken or stood up again: its street blades come off or go back. */
  setPoleBroken(id: number, broken: boolean): void;
  /** Counts for the dev stats and the perf report. */
  stats: { blades: number; poles: number; gateways: number; plaques: number; triangles: number };
  dispose(): void;
}

const none = (): PlaceSigns => ({ group: new THREE.Group(), setPoleBroken() {}, stats: { blades: 0, poles: 0, gateways: 0, plaques: 0, triangles: 0 }, dispose() {} });

/** Shared by both sheets: a plain lit sheeting with a trace of self light so lettering reads past the lamp pools. */
function sheeting(map: THREE.Texture, emissive: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: emissive, roughness: 0.5, metalness: 0 });
}

export function buildPlaceSigns(world: World, opts: PlaceSignsOptions): PlaceSigns {
  if (!PLACE_SIGNS.tiers[opts.quality]) return none();
  const group = new THREE.Group();
  group.name = 'placeSigns';
  const disposables: { dispose(): void }[] = [];
  const g = world.graph;
  const h = world.heightAt;

  // ---------- street name blades ----------
  const streets = streetNames(world);
  const used = new Map<number, number>();
  const bladeNames: string[] = [];
  const cellOf = (streetId: number): number => {
    let c = used.get(streetId);
    if (c === undefined) {
      c = bladeNames.length;
      used.set(streetId, c);
      bladeNames.push(streets.streets[streetId].blade);
    }
    return c;
  };
  const props = world.blocks.props ?? [];
  const signalAt = new Map<number, Prop>();
  const lampCells = new Map<number, Prop[]>();
  const CELL = 24;
  const key = (x: number, z: number) => Math.floor(x / CELL) * 65536 + Math.floor(z / CELL);
  for (const p of props) {
    if (p.kind === 'trafficLight' && p.node !== undefined && !signalAt.has(p.node)) signalAt.set(p.node, p);
    else if (p.kind === 'streetlight') (lampCells.get(key(p.x, p.z)) ?? lampCells.set(key(p.x, p.z), []).get(key(p.x, p.z))!).push(p);
  }
  const poleFor = (node: number): Prop | null => {
    const sig = signalAt.get(node);
    if (sig) return sig;
    const n = g.nodes[node];
    let best: Prop | null = null;
    let bestD = PLACE_SIGNS.poleSearch ** 2;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const p of lampCells.get(key(n.x + dx * CELL, n.z + dz * CELL)) ?? []) {
          const d = (p.x - n.x) ** 2 + (p.z - n.z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
      }
    }
    return best;
  };

  interface Plate {
    pole: Prop;
    cell: number;
    /** Unit axis of the street, pointing from the pole toward the junction's middle. */
    ax: number;
    az: number;
    level: number;
  }
  const plates: Plate[] = [];
  for (const n of g.nodes) {
    const on = streets.at(n.id);
    if (on.length < 2) continue;
    const pole = poleFor(n.id);
    if (!pole) continue;
    // Toward the middle of the junction from the pole, the way a plate on a bracket would reach.
    const mx = n.x - pole.x;
    const mz = n.z - pole.z;
    on.slice(0, 3).forEach((s, level) => {
      const eid = n.edges.find((e) => streets.ofEdge[e] === s.id);
      if (eid === undefined) return;
      const e = g.edges[eid];
      const o = g.nodes[e.a === n.id ? e.b : e.a];
      const l = Math.hypot(o.x - n.x, o.z - n.z) || 1;
      let ax = (o.x - n.x) / l;
      let az = (o.z - n.z) / l;
      if (ax * mx + az * mz < 0) {
        ax = -ax;
        az = -az;
      }
      plates.push({ pole, cell: cellOf(s.id), ax, az, level });
    });
  }

  const blades = new GeoBuilder(false);
  const ranges = new Map<number, { start: number; count: number }>();
  /** One face of a plate: centre (cx, cy, cz), facing (nx, nz), reading along r = (nz, -nx). */
  const face = (gb: GeoBuilder, cx: number, cy: number, cz: number, nx: number, nz: number, hw: number, hh: number, uv: { u0: number; u1: number; v0: number; v1: number }): void => {
    const rx = nz;
    const rz = -nx;
    const a = gb.vertex(cx - rx * hw, cy - hh, cz - rz * hw, nx, 0, nz, uv.u0, uv.v0);
    const b = gb.vertex(cx + rx * hw, cy - hh, cz + rz * hw, nx, 0, nz, uv.u1, uv.v0);
    const c = gb.vertex(cx + rx * hw, cy + hh, cz + rz * hw, nx, 0, nz, uv.u1, uv.v1);
    const d = gb.vertex(cx - rx * hw, cy + hh, cz - rz * hw, nx, 0, nz, uv.u0, uv.v1);
    gb.quadFacing(a, b, c, d, nx, 0, nz);
  };
  plates.sort((p, q) => p.pole.id - q.pole.id || p.level - q.level);
  for (const pl of plates) {
    const uv = placeCellUV(pl.cell, bladeNames.length);
    const reach = PLACE_SIGNS.bladeReach + PLACE_SIGNS.bladeW / 2;
    const cx = pl.pole.x + pl.ax * reach;
    const cz = pl.pole.z + pl.az * reach;
    const cy = pl.pole.y + PLACE_SIGNS.bladeY + pl.level * PLACE_SIGNS.bladeStep;
    const start = blades.indices.length;
    // The plate lies along (ax, az); its faces look across it.
    face(blades, cx, cy, cz, -pl.az, pl.ax, PLACE_SIGNS.bladeW / 2, PLACE_SIGNS.bladeH / 2, uv);
    face(blades, cx, cy, cz, pl.az, -pl.ax, PLACE_SIGNS.bladeW / 2, PLACE_SIGNS.bladeH / 2, uv);
    const r = ranges.get(pl.pole.id);
    if (r) r.count += blades.indices.length - start;
    else ranges.set(pl.pole.id, { start, count: blades.indices.length - start });
  }
  let bladeIndex: THREE.BufferAttribute | null = null;
  const saved = new Map<number, Uint16Array>();
  if (blades.vertexCount) {
    const tone = BLADE_TONE[cityIdentity(world.seed).home] ?? 'green';
    const map = makeStreetBladeAtlas(bladeNames, tone);
    const mat = sheeting(map, 0.28);
    const geo = blades.build();
    disposables.push(map, mat, geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'streetBlades';
    group.add(mesh);
    bladeIndex = geo.getIndex() as THREE.BufferAttribute;
  }

  // ---------- neighbourhood gateways ----------
  const gateways = hoodGateways(world);
  const banners = new GeoBuilder(false);
  const probe = new FacadeProbe(opts.facades);
  /** A gateway as found: a banner across the street, or (where no two facades face each other) a plaque on one wall. */
  type Found = { name: string } & ({ ax: number; az: number; bx: number; bz: number; y: number } | { px: number; pz: number; py: number; nx: number; nz: number; w: number });
  const found: Found[] = [];
  let strung = 0;
  if (!probe.empty) {
    for (const gw of gateways) {
      // Left of travel.
      const lx = -gw.dz;
      const lz = gw.dx;
      const lat = gw.width / 2 + gw.sidewalk;
      /** Positions along the street to try, nearest the gateway's spot first and clear of both junctions. */
      const slides = PLACE_SIGNS.bannerSlide.filter((d) => d >= PLACE_SIGNS.junctionClear - gw.behind && d <= gw.ahead - PLACE_SIGNS.junctionClear);
      const at = (d: number) => ({ x: gw.x + gw.dx * d, z: gw.z + gw.dz * d });
      let ok = false;
      for (const slide of slides) {
        const { x, z } = at(slide);
        for (const up of PLACE_SIGNS.bannerY) {
          const y = h(x, z) + up;
          const L = probe.probe(x + lx * lat, z + lz * lat, y, lx, lz, PLACE_SIGNS.bannerProbe);
          const ld = L ? L.d : 0;
          const R = L ? probe.probe(x - lx * lat, z - lz * lat, y, -lx, -lz, PLACE_SIGNS.bannerProbe) : null;
          if (!L || !R) continue;
          found.push({ name: gw.hood.name, ax: x + lx * (lat + ld), az: z + lz * (lat + ld), bx: x - lx * (lat + R.d), bz: z - lz * (lat + R.d), y });
          strung++;
          ok = true;
          break;
        }
        if (ok) break;
      }
      if (ok) continue;
      // No pair of facades to string it between: a plaque on the right hand wall, facing the street.
      for (const slide of slides) {
        const { x, z } = at(slide);
        for (const side of [-1, 1]) {
          const py = h(x, z) + PLACE_SIGNS.plaqueY;
          const hit = probe.probe(x + lx * lat * side, z + lz * lat * side, py, lx * side, lz * side, PLACE_SIGNS.bannerProbe);
          if (!hit) continue;
          const w = Math.min(PLACE_SIGNS.plaqueW, 2 * Math.min(hit.left, hit.right) - 0.3);
          if (w < PLACE_SIGNS.plaqueMin) continue;
          found.push({ name: gw.hood.name, px: x + lx * side * (lat + hit.d) + hit.nx * 0.04, pz: z + lz * side * (lat + hit.d) + hit.nz * 0.04, py, nx: hit.nx, nz: hit.nz, w });
          ok = true;
          break;
        }
        if (ok) break;
      }
    }
  }
  if (found.length) {
    const names = found.map((p) => p.name);
    found.forEach((p, i) => {
      const uv = placeCellUV(i, names.length);
      if ('ax' in p) banner(banners, p, uv);
      else face(banners, p.px, p.py, p.pz, p.nx, p.nz, p.w / 2, p.w / 8, uv);
    });
    const map = makeGatewayAtlas(names);
    const mat = sheeting(map, 0.12);
    const geo = banners.build();
    disposables.push(map, mat, geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'gatewayBanners';
    group.add(mesh);
  }

  /** A banner as a sagging cloth from a to b: plain cloth, the lettered panel, plain cloth; a face each way, each reading left to right. */
  function banner(gb: GeoBuilder, p: { ax: number; az: number; bx: number; bz: number; y: number }, uv: { u0: number; u1: number; v0: number; v1: number }): void {
    const span = Math.hypot(p.bx - p.ax, p.bz - p.az);
    const ux = (p.bx - p.ax) / span;
    const uz = (p.bz - p.az) / span;
    const H = PLACE_SIGNS.bannerH;
    const textW = Math.min(span - 1, H * 4);
    const drop = (t: number) => p.y - PLACE_SIGNS.bannerSag * 4 * t * (1 - t);
    const cloth = (uv.u1 - uv.u0) * 0.04;
    const parts: [number, number, number, number][] = [
      [0, (span - textW) / 2, uv.u0, uv.u0 + cloth],
      [(span - textW) / 2, (span + textW) / 2, uv.u0, uv.u1],
      [(span + textW) / 2, span, uv.u0, uv.u0 + cloth],
    ];
    // Face normals: perpendicular to the cloth, one each way.
    for (const side of [1, -1]) {
      const nx = -uz * side;
      const nz = ux * side;
      // This side reads along (nz, -nx); the text runs with the cloth when that is +u.
      const forward = nz * ux - nx * uz > 0;
      parts.forEach(([s0, s1, ua, ub], part) => {
        const n = Math.max(1, Math.ceil((s1 - s0) / 1.5));
        for (let k = 0; k < n; k++) {
          const t0 = s0 + ((s1 - s0) * k) / n;
          const t1 = s0 + ((s1 - s0) * (k + 1)) / n;
          const f0 = ua + ((ub - ua) * k) / n;
          const f1 = ua + ((ub - ua) * (k + 1)) / n;
          // The lettered panel runs against the cloth on the side that reads the other way; the plain cloth is the same either way.
          const [q0, q1] = part === 1 && !forward ? [uv.u1 - (f0 - uv.u0), uv.u1 - (f1 - uv.u0)] : [f0, f1];
          const y0a = drop(t0 / span) - H / 2;
          const y0b = drop(t1 / span) - H / 2;
          const a = gb.vertex(p.ax + ux * t0, y0a, p.az + uz * t0, nx, 0, nz, q0, uv.v0);
          const b = gb.vertex(p.ax + ux * t1, y0b, p.az + uz * t1, nx, 0, nz, q1, uv.v0);
          const c = gb.vertex(p.ax + ux * t1, y0b + H, p.az + uz * t1, nx, 0, nz, q1, uv.v1);
          const d = gb.vertex(p.ax + ux * t0, y0a + H, p.az + uz * t0, nx, 0, nz, q0, uv.v1);
          gb.quadFacing(a, b, c, d, nx, 0, nz);
        }
      });
    }
  }

  const triangles = (blades.indices.length + banners.indices.length) / 3;
  return {
    group,
    setPoleBroken(id, broken) {
      const r = ranges.get(id);
      if (!r || !bladeIndex) return;
      const arr = bladeIndex.array as Uint16Array;
      if (broken && !saved.has(id)) {
        saved.set(id, arr.slice(r.start, r.start + r.count));
        arr.fill(0, r.start, r.start + r.count);
        bladeIndex.needsUpdate = true;
      } else if (!broken && saved.has(id)) {
        arr.set(saved.get(id)!, r.start);
        saved.delete(id);
        bladeIndex.needsUpdate = true;
      }
    },
    stats: { blades: plates.length, poles: ranges.size, gateways: strung, plaques: found.length - strung, triangles },
    dispose() {
      for (const d of disposables) d.dispose();
      group.removeFromParent();
    },
  };
}
