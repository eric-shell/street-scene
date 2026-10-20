/**
 * Elevated railway renderer, New York / Chicago "El" style, built on the
 * smoothed track curve (render/railCurve.ts) so steel and trains agree:
 *  - a riveted plate girder at each deck edge, floor beams every few meters,
 *    stringers under the rails, open deck ties you can see the sky between
 *    (alpha tested), running rails, a third rail with its cover board per
 *    track, catwalk handrails, sodium lamps under the deck;
 *  - steel H columns on concrete footings (the footing is the sim's pillar
 *    wall) with a bent cap under the deck and knee braces out to the
 *    cantilevered street side; a through truss where the line crosses the
 *    river channel and the columns cannot stand;
 *  - stations: an island platform the street side track swings out around,
 *    a corrugated canopy with fluorescent strips and lit name boards, the
 *    station house hung under the deck, and enclosed stairs down to the
 *    sidewalk (solid to the ground: they are the sim's 'pillar' walls) with
 *    green globe lamps and a SUBWAY sign;
 *  - signals along the line and, past both map ends, the viaduct running on
 *    into the fog on render-only columns and down a ramp into a tunnel portal.
 * Two merged meshes (textured steel atlas, alpha tested ties) plus lamps in
 * the kit's shared glow builder; the trains are their own instanced meshes
 * (render/trains.ts). Quality trims detail: Low draws a solid deck instead of
 * open ties, fewer handrail posts and no sparks or light wash.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import { riverCenter } from '../../city/districts/river';
import type { Area } from '../../city/districts/types';
import { GeoBuilder } from '../geoBuilder';
import { CurvePoint, RAIL, RailCurve, buildRailCurve, curvePoint, dirOn, projectOnCurve, sampleCurve, stationSwing, trackLateral } from '../railCurve';
import { Band, STATION_NAMES, SUBWAY_SIGN, makeSteelAtlas, makeTieTexture, signBand, steelBand } from '../railTextures';
import { createTrains } from '../trains';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder } from './kit';

interface V3 {
  x: number;
  y: number;
  z: number;
}

const GIRDER = steelBand('girder');
const STEEL = steelBand('steel');
const CONCRETE = steelBand('concrete');
const HOUSE = steelBand('house');
const ROOF = steelBand('roof');
const LIT = steelBand('lit');

/** Vertex tints (linear) multiplying the atlas. */
const TINT = {
  steel: col(0xffffff),
  dark: col(0xffffff, 0.75),
  rail: col(0xd8dde4, 1.9),
  third: col(0xb0b4b8, 1.3),
  board: col(0x8a6a4c, 0.7),
  concrete: col(0xffffff),
  yellow: col(0xffd23a, 1.5),
  roofUnder: col(0xffffff, 0.55),
} as const;

/** Lamp colors (unlit glow builder). */
const LAMP = {
  sodium: col(0xffa040, 1.25),
  tube: col(0xe6f0ff, 0.55),
  globe: col(0x3dff7a, 1.3),
  red: col(0xff2a1a, 1.9),
  green: col(0x2aff8a, 1.6),
  amber: col(0xffb020, 1.7),
  house: col(0xfff1d6, 0.7),
  void: col(0x000000),
} as const;

/** Structure dimensions relative to the deck (tie) top and the track curve (m). */
const EL = {
  girderHalf: 0.2,
  girderTop: 0.45,
  girderBottom: -1.15,
  capTop: -1.05,
  capBottom: -1.55,
  footing: 1.1,
  railGauge: 0.72,
  thirdRail: 1.25,
  handrail: 1.4,
  lampEvery: 18,
  signalEvery: 280,
  /** Run-off columns (outside the map) every this many meters. */
  runOffColumn: 26,
  /** Platform top above the deck top, canopy eave and ridge (m). */
  platformTop: 1.05,
  eave: 4.45,
  ridge: 4.9,
  /** Station house under the deck: half length along the deck and its depth below it (m). */
  houseHalf: CITY.districts.subway.mezzanine / 2,
  houseBottom: -4.35,
  truss: 4.6,
} as const;

/** Band-mapped oriented cuboid from a to b (end face centers): hw across (horizontal), hh up. */
function strut(gb: GeoBuilder, a: V3, b: V3, hw: number, hh: number, band: Band, color: THREE.Color, opts: { caps?: boolean; top?: boolean; bottom?: boolean; side?: { x: number; z: number } } = {}): void {
  let fx = b.x - a.x;
  let fy = b.y - a.y;
  let fz = b.z - a.z;
  const len = Math.hypot(fx, fy, fz);
  if (len < 1e-4) return;
  fx /= len;
  fy /= len;
  fz /= len;
  // Side axis: horizontal and across the member (or the hint for vertical members).
  let sx = -fz;
  let sz = fx;
  let sl = Math.hypot(sx, sz);
  if (sl < 0.05) {
    sx = opts.side?.x ?? 1;
    sz = opts.side?.z ?? 0;
    sl = Math.hypot(sx, sz) || 1;
  }
  sx /= sl;
  sz /= sl;
  // Up axis u = s x f.
  const ux = 0 * fz - sz * fy;
  const uy = sz * fx - sx * fz;
  const uz = sx * fy - 0 * fx;
  const corner = (p: V3, s: number, u: number): [number, number, number] => [p.x + sx * hw * s + ux * hh * u, p.y + uy * hh * u, p.z + sz * hw * s + uz * hh * u];
  const uLen = len / band.tile;
  const face = (p: [number, number, number][], nx: number, ny: number, nz: number, u1: number) => {
    const ids = [
      gb.vertex(p[0][0], p[0][1], p[0][2], nx, ny, nz, 0, band.v0, color),
      gb.vertex(p[1][0], p[1][1], p[1][2], nx, ny, nz, u1, band.v0, color),
      gb.vertex(p[2][0], p[2][1], p[2][2], nx, ny, nz, u1, band.v1, color),
      gb.vertex(p[3][0], p[3][1], p[3][2], nx, ny, nz, 0, band.v1, color),
    ];
    gb.quadFacing(ids[0], ids[1], ids[2], ids[3], nx, ny, nz);
  };
  // Sides (+s, -s): along the member, bottom to top.
  face([corner(a, 1, -1), corner(b, 1, -1), corner(b, 1, 1), corner(a, 1, 1)], sx, 0, sz, uLen);
  face([corner(b, -1, -1), corner(a, -1, -1), corner(a, -1, 1), corner(b, -1, 1)], -sx, 0, -sz, uLen);
  if (opts.top !== false) face([corner(a, -1, 1), corner(a, 1, 1), corner(b, 1, 1), corner(b, -1, 1)], ux, uy, uz, uLen);
  if (opts.bottom !== false) face([corner(a, 1, -1), corner(a, -1, -1), corner(b, -1, -1), corner(b, 1, -1)], -ux, -uy, -uz, uLen);
  if (opts.caps !== false) {
    face([corner(a, -1, -1), corner(a, 1, -1), corner(a, 1, 1), corner(a, -1, 1)], -fx, -fy, -fz, (2 * hw) / band.tile);
    face([corner(b, 1, -1), corner(b, -1, -1), corner(b, -1, 1), corner(b, 1, 1)], fx, fy, fz, (2 * hw) / band.tile);
  }
}

/** A quad through four points (any order around), band mapped, facing n. */
function quad(gb: GeoBuilder, p: V3[], n: [number, number, number], band: Band, uLen: number, color: THREE.Color): void {
  const uv: [number, number][] = [
    [0, band.v0],
    [uLen, band.v0],
    [uLen, band.v1],
    [0, band.v1],
  ];
  const ids = p.map((q, i) => gb.vertex(q.x, q.y, q.z, n[0], n[1], n[2], uv[i][0], uv[i][1], color));
  gb.quadFacing(ids[0], ids[1], ids[2], ids[3], n[0], n[1], n[2]);
}

/** Band-mapped vertical prism of n sides around (x, z) from y0 to y1, capped on top. */
function footing(gb: GeoBuilder, x: number, z: number, r: number, y0: number, y1: number, n: number, band: Band, color: THREE.Color): void {
  const circ = (2 * Math.PI * r) / band.tile;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    quad(
      gb,
      [
        { x: x + Math.cos(a0) * r, y: y0, z: z + Math.sin(a0) * r },
        { x: x + Math.cos(a1) * r, y: y0, z: z + Math.sin(a1) * r },
        { x: x + Math.cos(a1) * r, y: y1, z: z + Math.sin(a1) * r },
        { x: x + Math.cos(a0) * r, y: y1, z: z + Math.sin(a0) * r },
      ],
      [Math.cos(am), 0, Math.sin(am)],
      band,
      circ / n,
      color,
    );
  }
  const c = gb.vertex(x, y1, z, 0, 1, 0, 0, band.v0, color);
  const ring: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push(gb.vertex(x + Math.cos(a) * r, y1, z + Math.sin(a) * r, 0, 1, 0, 0.2, band.v1, color));
  }
  for (let i = 0; i < n; i++) gb.triFacing(c, ring[i], ring[(i + 1) % n], 0, 1, 0);
}

/** A small lamp: an unlit box in the glow builder. */
function lamp(gb: GeoBuilder, c: V3, hx: number, hy: number, along: { x: number; z: number }, length: number, color: THREE.Color): void {
  strut(gb, { x: c.x - along.x * length, y: c.y, z: c.z - along.z * length }, { x: c.x + along.x * length, y: c.y, z: c.z + along.z * length }, hx, hy, STEEL, color);
}

export const subwayRenderer: DistrictRenderer = {
  kinds: ['subway'],
  build(kit, areas) {
    if (!areas.length) return;
    const atlas = makeSteelAtlas();
    kit.track(atlas.map);
    kit.track(atlas.emissive);
    const steel = new GeoBuilder(true);
    const open = kit.quality !== 'low';
    const bed = new GeoBuilder(false);
    for (const a of areas) {
      const b = kit.builds[a.id];
      const H = a.params.deckHeight;
      const stationHints = b.hints.filter((hh) => hh.kind === 'station');
      const curve = buildRailCurve(a.path, a.params.side, H, kit.h, stationHints.map((hh) => hh.points[0]));
      curve.stations.forEach((st, i) => (st.name = ((a.params.seed ?? 0) + i) % STATION_NAMES.length));
      buildLine(kit, a, curve, steel, open ? bed : null);
      const trains = createTrains(kit.group, curve, a.params.seed ?? 1, kit.quality, kit.track);
      kit.track(trains);
      kit.animate(trains.update);
      kit.view(trains.view);
      // Debug handle (headless screenshots, the console): the curve and timetable of this line.
      const handle = new THREE.Object3D();
      handle.name = 'subwayLine';
      handle.userData = { curve, services: trains.services };
      kit.group.add(handle);
    }
    const steelMat = new THREE.MeshStandardMaterial({
      map: atlas.map,
      emissiveMap: atlas.emissive,
      emissive: 0xffffff,
      emissiveIntensity: 0.85,
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.35,
      envMapIntensity: 0.6,
    });
    const sm = new THREE.Mesh(kit.track(steel.build()), kit.track(steelMat));
    sm.name = 'elevatedSteel';
    kit.group.add(sm);
    if (bed.vertexCount) {
      const ties = kit.track(makeTieTexture());
      const bm = new THREE.Mesh(kit.track(bed.build()), kit.track(new THREE.MeshStandardMaterial({ map: ties, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, envMapIntensity: 0.3 })));
      bm.name = 'elevatedTies';
      kit.group.add(bm);
    }
  },
};

function buildLine(kit: DistrictKit, area: Area, c: RailCurve, steel: GeoBuilder, bed: GeoBuilder | null): void {
  const glow = kit.glow;
  const low = kit.quality === 'low';
  const P0: CurvePoint = curvePoint();
  const P1: CurvePoint = curvePoint();
  const at = (p: CurvePoint, l: number, dy: number): V3 => ({ x: p.x + p.px * l, y: p.y + dy, z: p.z + p.pz * l });
  const edgeIn = (s: number) => trackLateral(c, 0, s) - RAIL.edgeOut;
  const edgeOut = RAIL.trackHalf + RAIL.edgeOut;
  const piece = low ? 8 : 6;
  const near = (s: number) => s > c.cityA - 60 && s < c.cityB + 60;

  // ----- Deck: girders, floor beams, stringers, rails, ties, handrails, lamps.
  for (let s = c.portalA; s < c.portalB - 0.01; s += piece) {
    const s1 = Math.min(c.portalB, s + piece);
    sampleCurve(c, s, P0);
    sampleCurve(c, s1, P1);
    const ein0 = edgeIn(s);
    const ein1 = edgeIn(s1);
    const detail = near(s);
    const gy = (EL.girderTop + EL.girderBottom) / 2;
    const gh = (EL.girderTop - EL.girderBottom) / 2;
    strut(steel, at(P0, ein0 + EL.girderHalf, gy), at(P1, ein1 + EL.girderHalf, gy), EL.girderHalf, gh, GIRDER, TINT.steel, { caps: false });
    strut(steel, at(P0, edgeOut - EL.girderHalf, gy), at(P1, edgeOut - EL.girderHalf, gy), EL.girderHalf, gh, GIRDER, TINT.steel, { caps: false });
    strut(steel, at(P0, ein0 + 0.4, -0.78), at(P0, edgeOut - 0.4, -0.78), 0.13, 0.28, STEEL, TINT.dark, { top: false });
    for (const tr of [0, 1] as const) {
      const l0 = trackLateral(c, tr, s);
      const l1 = trackLateral(c, tr, s1);
      const offs = detail && !low ? [-EL.railGauge, EL.railGauge] : [0];
      for (const r of offs) strut(steel, at(P0, l0 + r, -0.38), at(P1, l1 + r, -0.38), offs.length > 1 ? 0.09 : 0.6, 0.24, STEEL, TINT.dark, { caps: false, top: false });
      for (const r of [-EL.railGauge, EL.railGauge]) strut(steel, at(P0, l0 + r, 0.08), at(P1, l1 + r, 0.08), 0.035, 0.08, STEEL, TINT.rail, { caps: false, bottom: false });
      if (detail) {
        const out = l0 < 0 ? -1 : 1;
        strut(steel, at(P0, l0 + out * EL.thirdRail, 0.12), at(P1, l1 + out * EL.thirdRail, 0.12), 0.045, 0.06, STEEL, TINT.third, { caps: false, bottom: false });
        strut(steel, at(P0, l0 + out * EL.thirdRail, 0.26), at(P1, l1 + out * EL.thirdRail, 0.26), 0.14, 0.015, CONCRETE, TINT.board, { caps: false });
      }
      if (bed) {
        // Ties: one strip per track, V running along the track (5 m per repeat).
        const v0 = s / 5;
        const v1 = s1 / 5;
        const A = at(P0, l0 - 1.3, 0);
        const B = at(P0, l0 + 1.3, 0);
        const C = at(P1, l1 + 1.3, 0);
        const D = at(P1, l1 - 1.3, 0);
        const ids = [bed.vertex(A.x, A.y, A.z, 0, 1, 0, 0, v0), bed.vertex(B.x, B.y, B.z, 0, 1, 0, 1, v0), bed.vertex(C.x, C.y, C.z, 0, 1, 0, 1, v1), bed.vertex(D.x, D.y, D.z, 0, 1, 0, 0, v1)];
        bed.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
      }
    }
    if (!bed) {
      // Low: a solid deck plate instead of open ties.
      quad(steel, [at(P0, ein0 + 0.3, -0.06), at(P0, edgeOut - 0.3, -0.06), at(P1, edgeOut - 0.3, -0.06), at(P1, ein1 + 0.3, -0.06)], [0, 1, 0], STEEL, piece / STEEL.tile, TINT.dark);
    }
    // Catwalk handrails along both girders.
    if (detail) {
      for (const [l0, l1] of [
        [ein0 + EL.girderHalf, ein1 + EL.girderHalf],
        [edgeOut - EL.girderHalf, edgeOut - EL.girderHalf],
      ]) {
        const posts = low ? [0] : [0, 0.5];
        for (const f of posts) {
          sampleCurve(c, s + piece * f, P1);
          const l = l0 + (l1 - l0) * f;
          strut(steel, at(P1, l, EL.girderTop), at(P1, l, EL.handrail), 0.03, 0.03, STEEL, TINT.dark, { caps: false, side: { x: P1.tx, z: P1.tz } });
        }
        sampleCurve(c, s1, P1);
        strut(steel, at(P0, l0, EL.handrail), at(P1, l1, EL.handrail), 0.03, 0.03, STEEL, TINT.dark, { caps: false, bottom: false });
        if (!low) strut(steel, at(P0, l0, (EL.handrail + EL.girderTop) / 2), at(P1, l1, (EL.handrail + EL.girderTop) / 2), 0.02, 0.02, STEEL, TINT.dark, { caps: false, bottom: false });
      }
    }
    sampleCurve(c, s1, P1);
    // Sodium lamps under the deck, alternating over the sidewalk and the street.
    if (detail && Math.floor(s / EL.lampEvery) !== Math.floor(s1 / EL.lampEvery)) {
      const k = Math.floor(s1 / EL.lampEvery);
      lamp(glow, at(P1, k % 2 ? edgeOut - 1.2 : -RAIL.trackHalf, -1.12), 0.18, 0.05, { x: P1.tx, z: P1.tz }, 0.35, LAMP.sodium);
    }
  }

  // ----- Columns: the sim's pillars (footing = the wall circle), then render-only ones past the map.
  const builds = kit.builds[area.id];
  const column = (x: number, z: number, r: number) => {
    const pr = projectOnCurve(c, x, z);
    sampleCurve(c, pr.s, P0);
    const g = kit.h(x, z);
    const top = P0.y + EL.capBottom;
    const t = { x: P0.tx, z: P0.tz };
    const p = { x: P0.px, z: P0.pz };
    footing(steel, x, z, r, g - 0.3, g + EL.footing, 8, CONCRETE, TINT.concrete);
    const base = { x, y: g + EL.footing, z };
    // H section: web across the deck, flanges along it.
    strut(steel, base, { x, y: top, z }, 0.19, 0.022, STEEL, TINT.steel, { side: p });
    for (const k of [-1, 1]) strut(steel, { x: x + p.x * 0.19 * k, y: base.y, z: z + p.z * 0.19 * k }, { x: x + p.x * 0.19 * k, y: top, z: z + p.z * 0.19 * k }, 0.21, 0.025, STEEL, TINT.steel, { side: t });
    strut(steel, { x, y: base.y, z }, { x, y: base.y + 0.06, z }, 0.32, 0.32, STEEL, TINT.dark, { side: p });
    // Bent cap under the floor beams, knee braces out to the cantilevered side(s).
    const ein = edgeIn(pr.s);
    const capY = (EL.capTop + EL.capBottom) / 2;
    strut(steel, at(P0, ein + 0.3, capY), at(P0, edgeOut - 0.3, capY), 0.2, (EL.capTop - EL.capBottom) / 2, STEEL, TINT.steel);
    const lc = pr.lateral;
    const braces = Math.abs(lc) < 1.5 ? [-1, 1] : [lc > 0 ? -1 : 1];
    for (const k of braces) strut(steel, at(P0, lc, -4.3), at(P0, lc + k * 2.8, EL.capBottom), 0.09, 0.09, STEEL, TINT.dark);
    if (stationSwing(c, pr.s) > 0.3) strut(steel, at(P0, lc, -6), at(P0, ein + 1.6, EL.capBottom), 0.1, 0.1, STEEL, TINT.dark);
  };
  for (const pr of builds.props) if (pr.kind === 'pillar') column(pr.x, pr.z, pr.size);
  const runOff = (sFrom: number, sTo: number) => {
    for (let s = sFrom; s < sTo; s += EL.runOffColumn) {
      sampleCurve(c, s, P0);
      if (P0.y - P0.ground < 3.4) continue;
      column(P0.x, P0.z, CITY.districts.subway.pillarRadius);
    }
  };
  runOff(c.portalA + RAIL.ramp * 0.3, c.cityA - 30);
  runOff(c.cityB + 30, c.portalB - RAIL.ramp * 0.3);

  // ----- Truss spans over the river channel (no columns there).
  const rivers = kit.world.areas.filter((x) => x.kind === 'river');
  if (rivers.length) {
    const wet = (s: number) => {
      sampleCurve(c, s, P0);
      return rivers.some((rv) => Math.abs(P0.z - riverCenter(rv.params, P0.x)) < rv.params.top + CITY.districts.river.bridgeBody + 2);
    };
    let s = c.cityA;
    while (s < c.cityB) {
      if (!wet(s)) {
        s += 2;
        continue;
      }
      let e = s;
      while (e < c.cityB && wet(e)) e += 2;
      truss(s - 6, e + 6);
      s = e + 2;
    }
  }
  function truss(sa: number, sb: number): void {
    const panels = Math.max(2, Math.round((sb - sa) / 6));
    const step = (sb - sa) / panels;
    for (const side of [0, 1]) {
      const lat = (s: number) => (side ? edgeOut - 0.15 : edgeIn(s) + 0.15);
      for (let i = 0; i < panels; i++) {
        const s0 = sa + i * step;
        const s1 = s0 + step;
        sampleCurve(c, s0, P0);
        sampleCurve(c, s1, P1);
        strut(steel, at(P0, lat(s0), EL.truss), at(P1, lat(s1), EL.truss), 0.2, 0.24, STEEL, TINT.steel);
        strut(steel, at(P0, lat(s0), EL.girderTop), at(P0, lat(s0), EL.truss), 0.14, 0.14, STEEL, TINT.steel, { side: { x: P0.tx, z: P0.tz } });
        const up = i % 2 === 0;
        strut(steel, at(up ? P0 : P1, lat(up ? s0 : s1), EL.girderTop), at(up ? P1 : P0, lat(up ? s1 : s0), EL.truss), 0.1, 0.1, STEEL, TINT.dark);
      }
      sampleCurve(c, sb, P1);
      strut(steel, at(P1, lat(sb), EL.girderTop), at(P1, lat(sb), EL.truss), 0.14, 0.14, STEEL, TINT.steel, { side: { x: P1.tx, z: P1.tz } });
    }
    // Top bracing across, above the trains.
    for (let i = 0; i <= panels; i += 2) {
      const s0 = sa + i * step;
      sampleCurve(c, s0, P0);
      strut(steel, at(P0, edgeIn(s0) + 0.15, EL.truss + 0.1), at(P0, edgeOut - 0.15, EL.truss + 0.1), 0.1, 0.12, STEEL, TINT.dark);
    }
  }

  // ----- Signals beside each track, facing the trains that run on it.
  for (let s = c.cityA + 120; s < c.cityB - 60; s += EL.signalEvery) {
    for (const tr of [0, 1] as const) {
      const ss = s + tr * 40;
      sampleCurve(c, ss, P0);
      const l = trackLateral(c, tr, ss);
      const out = l < 0 ? -1 : 1;
      const lx = l + out * 1.85;
      strut(steel, at(P0, lx, 0), at(P0, lx, 2.6), 0.05, 0.05, STEEL, TINT.dark, { side: { x: P0.tx, z: P0.tz } });
      strut(steel, at(P0, lx, 2.3), at(P0, lx, 3.1), 0.16, 0.12, STEEL, TINT.dark, { side: { x: P0.px, z: P0.pz } });
      // Lamps on the side the trains on this track come from.
      const face = dirOn(c, tr);
      const red = ((ss * 7) | 0) % 5 === 0;
      for (const [y, color] of [
        [2.9, red ? LAMP.red : col(0x220806)],
        [2.55, red ? col(0x062210) : LAMP.green],
      ] as const) {
        const p = at(P0, lx, y);
        lamp(glow, { x: p.x - P0.tx * face * 0.13, y: p.y, z: p.z - P0.tz * face * 0.13 }, 0.07, 0.07, { x: P0.tx, z: P0.tz }, 0.02, color);
      }
    }
  }

  // ----- Stations.
  for (const st of c.stations) station(st.s, st.name);
  function station(sc: number, name: number): void {
    const half = RAIL.platform / 2;
    for (let s = sc - half; s < sc + half - 0.01; s += 6) {
      const s1 = Math.min(sc + half, s + 6);
      sampleCurve(c, s, P0);
      sampleCurve(c, s1, P1);
      const la0 = trackLateral(c, 0, s) + 1.6;
      const la1 = trackLateral(c, 0, s1) + 1.6;
      const lb = RAIL.trackHalf - 1.6;
      // Platform slab (top at platformTop) and its yellow edges.
      const m0 = (la0 + lb) / 2;
      const m1 = (la1 + lb) / 2;
      strut(steel, at(P0, m0, EL.platformTop / 2 - 0.05), at(P1, m1, EL.platformTop / 2 - 0.05), (lb - la0) / 2, EL.platformTop / 2 + 0.05, CONCRETE, TINT.concrete, {
        caps: s === sc - half || s1 >= sc + half - 0.01,
        top: false,
      });
      quad(steel, [at(P0, la0, EL.platformTop), at(P0, lb, EL.platformTop), at(P1, lb, EL.platformTop), at(P1, la1, EL.platformTop)], [0, 1, 0], LIT, (s1 - s) / LIT.tile, TINT.concrete);
      for (const [l0, l1] of [
        [la0 + 0.25, la1 + 0.25],
        [lb - 0.25, lb - 0.25],
      ])
        strut(steel, at(P0, l0, EL.platformTop + 0.005), at(P1, l1, EL.platformTop + 0.005), 0.22, 0.01, CONCRETE, TINT.yellow, { caps: false, bottom: false });
      // Canopy: posts down the middle, a shallow gable roof, tube lights under it.
      const ridge = -RAIL.trackHalf - 0.2;
      const eaveA = la0 - 0.3;
      const eaveA1 = la1 - 0.3;
      const eaveB = lb + 0.5;
      strut(steel, at(P0, ridge, EL.platformTop), at(P0, ridge, EL.eave), 0.09, 0.09, STEEL, TINT.steel, { caps: false, side: { x: P0.tx, z: P0.tz } });
      for (const [e0, e1] of [
        [eaveA, eaveA1],
        [eaveB, eaveB],
      ]) {
        const top = [at(P0, ridge, EL.ridge), at(P0, e0, EL.eave), at(P1, e1, EL.eave), at(P1, ridge, EL.ridge)];
        quad(steel, top, [0, 1, 0], ROOF, (s1 - s) / ROOF.tile, TINT.steel);
        const under = top.map((p) => ({ x: p.x, y: p.y - 0.06, z: p.z }));
        quad(steel, under, [0, -1, 0], STEEL, (s1 - s) / STEEL.tile, TINT.roofUnder);
      }
      for (const l of [ridge - 1.4, ridge + 1.3]) lamp(glow, at(P0, l, EL.eave - 0.12), 0.07, 0.03, { x: P0.tx, z: P0.tz }, 1.8, LAMP.tube);
    }
    // Name boards hanging under the canopy, facing each track.
    for (let s = sc - half + 9; s < sc + half - 6; s += 15) {
      sampleCurve(c, s, P0);
      const band = signBand(name);
      for (const [l, face] of [
        [trackLateral(c, 0, s) + 1.75, -1],
        [RAIL.trackHalf - 1.75, 1],
      ] as const) {
        const a = at(P0, l, 3.05);
        const n: [number, number, number] = [P0.px * face, 0, P0.pz * face];
        // Read left to right by someone facing the board: their right is (nz, -nx).
        const r = { x: n[2] * 1.3, z: -n[0] * 1.3 };
        const pts = [
          { x: a.x - r.x, y: a.y, z: a.z - r.z },
          { x: a.x + r.x, y: a.y, z: a.z + r.z },
          { x: a.x + r.x, y: a.y + 0.48, z: a.z + r.z },
          { x: a.x - r.x, y: a.y + 0.48, z: a.z - r.z },
        ];
        quad(steel, pts, n, band, 1, TINT.steel);
        // Lettered on the platform side too (its own left to right).
        const back = [pts[1], pts[0], pts[3], pts[2]].map((p) => ({ x: p.x - n[0] * 0.04, y: p.y, z: p.z - n[2] * 0.04 }));
        quad(steel, back, [-n[0], 0, -n[2]], band, 1, TINT.steel);
      }
    }
    // Station house under the deck, lit windows all round, lamps under it.
    sampleCurve(c, sc - EL.houseHalf, P0);
    sampleCurve(c, sc + EL.houseHalf, P1);
    const lIn = -RAIL.trackHalf - RAIL.edgeOut + 0.1;
    const lOut = edgeOut - 0.1;
    const hy = (EL.houseBottom + EL.girderBottom) / 2;
    const hh = (EL.girderBottom - EL.houseBottom) / 2;
    strut(steel, at(P0, (lIn + lOut) / 2, hy), at(P1, (lIn + lOut) / 2, hy), (lOut - lIn) / 2, hh, HOUSE, TINT.steel);
    for (let k = -1; k <= 1; k++) {
      sampleCurve(c, sc + k * 4.5, P0);
      lamp(glow, at(P0, (lIn + lOut) / 2 + 2, EL.houseBottom - 0.04), 0.5, 0.02, { x: P0.tx, z: P0.tz }, 0.6, LAMP.house);
    }
  }

  // ----- Street stairs (sim walls with look 'pillar'): solid stringers to the ground, steps, globes.
  const stairHalf = CITY.districts.subway.stairWidth / 2;
  for (const pr of builds.props) {
    if (pr.kind !== 'stair') continue;
    const ux = Math.sin(pr.yaw);
    const uz = Math.cos(pr.yaw);
    const qx = -uz;
    const qz = ux;
    const run = pr.size;
    const rise = pr.height;
    const g0 = kit.h(pr.x, pr.z);
    const P = (t: number, l: number, y: number): V3 => ({ x: pr.x + ux * t + qx * l, y, z: pr.z + uz * t + qz * l });
    const ground = (t: number, l: number) => kit.h(pr.x + ux * t + qx * l, pr.z + uz * t + qz * l) - 0.25;
    const wall = 0.16;
    for (const k of [-1, 1]) {
      const lo = k * (stairHalf - wall);
      const hi = k * stairHalf;
      const topAt = (t: number) => g0 + (rise * t) / run + 0.95;
      // Outer and inner faces of the stringer, its top and both ends.
      for (const [l, nk] of [
        [hi, k],
        [lo, -k],
      ] as const)
        quad(steel, [P(0, l, ground(0, l)), P(run, l, ground(run, l)), P(run, l, topAt(run)), P(0, l, topAt(0))], [qx * nk, 0, qz * nk], CONCRETE, run / CONCRETE.tile, TINT.concrete);
      quad(steel, [P(0, lo, topAt(0)), P(0, hi, topAt(0)), P(run, hi, topAt(run)), P(run, lo, topAt(run))], [0, 1, 0], CONCRETE, run / CONCRETE.tile, TINT.concrete);
      quad(steel, [P(0, lo, ground(0, lo)), P(0, hi, ground(0, hi)), P(0, hi, topAt(0)), P(0, lo, topAt(0))], [-ux, 0, -uz], CONCRETE, 0.05, TINT.concrete);
      strut(steel, P(0, (lo + hi) / 2, topAt(0) + 0.05), P(run, (lo + hi) / 2, topAt(run) + 0.05), 0.07, 0.04, STEEL, TINT.dark);
      // Globe lamps on posts at the foot of the stair.
      const post = P(0.12, (lo + hi) / 2, topAt(0));
      strut(steel, post, { x: post.x, y: g0 + 3.1, z: post.z }, 0.035, 0.035, STEEL, TINT.dark, { side: { x: ux, z: uz } });
      cylinder(glow, post.x, post.z, 0.2, g0 + 2.3, g0 + 2.5, 6, LAMP.globe, false, 0.2);
      cylinder(glow, post.x, post.z, 0.2, g0 + 2.5, g0 + 2.68, 6, LAMP.globe, true, 0.04);
      cylinder(glow, post.x, post.z, 0.04, g0 + 2.14, g0 + 2.3, 6, LAMP.globe, false, 0.2);
    }
    // Steps between the stringers, and the closed back under the top landing.
    const n = Math.max(4, Math.round(rise / 0.19));
    const dt = run / n;
    const dh = rise / n;
    const l0 = -stairHalf + wall;
    const l1 = stairHalf - wall;
    for (let i = 0; i < n; i++) {
      const t0 = i * dt;
      const y0 = g0 + i * dh;
      quad(steel, [P(t0, l0, y0), P(t0, l1, y0), P(t0, l1, y0 + dh), P(t0, l0, y0 + dh)], [-ux, 0, -uz], CONCRETE, 0.4, TINT.concrete);
      quad(steel, [P(t0, l0, y0 + dh), P(t0, l1, y0 + dh), P(t0 + dt, l1, y0 + dh), P(t0 + dt, l0, y0 + dh)], [0, 1, 0], CONCRETE, 0.4, TINT.dark);
    }
    quad(steel, [P(run, -stairHalf, ground(run, -stairHalf)), P(run, stairHalf, ground(run, stairHalf)), P(run, stairHalf, g0 + rise), P(run, -stairHalf, g0 + rise)], [ux, 0, uz], CONCRETE, 0.4, TINT.concrete);
    // SUBWAY sign over the entrance.
    const band = signBand(SUBWAY_SIGN);
    const sy = g0 + 2.78;
    quad(steel, [P(0.1, -stairHalf, sy), P(0.1, stairHalf, sy), P(0.1, stairHalf, sy + 0.34), P(0.1, -stairHalf, sy + 0.34)], [-ux, 0, -uz], band, 1, TINT.steel);
    quad(steel, [P(0.14, -stairHalf, sy), P(0.14, stairHalf, sy), P(0.14, stairHalf, sy + 0.34), P(0.14, -stairHalf, sy + 0.34)], [ux, 0, uz], STEEL, 0.5, TINT.dark);
  }

  // ----- Embankment walls where the ramps come down near the portals.
  for (let s = c.portalA; s < c.portalB; s += piece) {
    const s1 = Math.min(c.portalB, s + piece);
    sampleCurve(c, s, P0);
    sampleCurve(c, s1, P1);
    const c0 = P0.y - P0.ground;
    const c1 = P1.y - P1.ground;
    if (Math.min(c0, c1) > 3.6) continue;
    for (const [l0, l1, k] of [
      [edgeIn(s), edgeIn(s1), -1],
      [edgeOut, edgeOut, 1],
    ] as const) {
      const a = at(P0, l0, EL.girderBottom);
      const b = at(P1, l1, EL.girderBottom);
      quad(steel, [{ x: a.x, y: P0.ground - 0.4, z: a.z }, { x: b.x, y: P1.ground - 0.4, z: b.z }, b, a], [P0.px * k, 0, P0.pz * k], CONCRETE, piece / CONCRETE.tile, TINT.concrete);
    }
  }

  // ----- Tunnel portals at both ends: headwall, black mouth, cut and cover box behind.
  for (const [sm, inward] of [
    [c.portalA, 1],
    [c.portalB, -1],
  ] as const) {
    sampleCurve(c, sm, P0);
    const y = P0.y;
    const g = P0.ground;
    const half = edgeOut + 1.5;
    const open = edgeOut - 0.2;
    const t = { x: P0.tx * inward, z: P0.tz * inward };
    const block = (sa: number, sb: number, la: number, lb: number, ya: number, yb: number) => {
      const lm = (la + lb) / 2;
      const a = { x: P0.x + t.x * sa + P0.px * lm, y: (ya + yb) / 2, z: P0.z + t.z * sa + P0.pz * lm };
      const b = { x: P0.x + t.x * sb + P0.px * lm, y: (ya + yb) / 2, z: P0.z + t.z * sb + P0.pz * lm };
      strut(steel, a, b, (lb - la) / 2, (yb - ya) / 2, CONCRETE, TINT.concrete);
    };
    // Headwall around the opening (s from -1.2 to 0 relative to the mouth, toward the tunnel).
    block(-1.2, 0, -half, -open, g - 0.5, y + 5.8);
    block(-1.2, 0, open, half, g - 0.5, y + 5.8);
    block(-1.2, 0, -open, open, y + 4.6, y + 5.8);
    block(-1.2, 0, -open, open, g - 0.5, y - 0.3);
    // The dark mouth just inside, then the box that hides the descending tunnel.
    const m = (l: number, yy: number): V3 => ({ x: P0.x - t.x * 1.0 + P0.px * l, y: yy, z: P0.z - t.z * 1.0 + P0.pz * l });
    quad(glow, [m(-open, y - 0.3), m(open, y - 0.3), m(open, y + 4.6), m(-open, y + 4.6)], [t.x, 0, t.z], STEEL, 1, LAMP.void);
    block(-34, -1.2, -half, -half + 0.6, g - 0.5, y + 5.8);
    block(-34, -1.2, half - 0.6, half, g - 0.5, y + 5.8);
    block(-34, -1.2, -half, half, y + 5.0, y + 5.8);
    block(-34.6, -34, -half, half, g - 0.5, y + 5.8);
  }
}
