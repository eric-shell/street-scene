/**
 * Park, plaza, parking lot and car park lighting. Parks, plazas and lots are
 * open ground the streetlights barely reach, so they get light of their own,
 * faked like the street pools in lightFx (the only real lights are the few
 * that follow the car):
 *  - a wash over every park, plaza, corner pocket, parking lot, roundabout
 *    island, the monument plaza and each multi-storey car park's apron: a
 *    soft, even glow tinted by what it lies on (green over grass, warm over
 *    paving and asphalt), fading in from a park's edge so the lawn reads as
 *    lit rather than as a decal;
 *  - a pool under every lantern post (props of kind 'parkLamp', placed by
 *    the park, infill and monument modules), draped over the ground point by
 *    point because park lawns roll: a flat disc would sink into a hill and
 *    float over a dip;
 *  - a flood under every plaza centrepiece (a statue, clock, kiosk or fountain, the monument, a
 *    roundabout's basin or sculpture): the same pool, wider and brighter, so the middle of the
 *    square reads lit from below and people gather in it;
 *  - the same pools under the car park's street lamps (render only posts and
 *    bulkheads the car park renderer draws: nothing to break, so never
 *    switched off), so a racer sees its apron lit before turning in.
 * Both are additive vertex colors in one merged mesh, so all of it is a
 * single draw call with no per-frame work. A broken lamp's pool goes dark
 * (setLampOn); the wash stays. Additive light fades to black in fog instead
 * of toward the fog color, so a far park never glows through the mist.
 * Render only.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { World } from '../../city/world';
import type { Area } from '../../city/districts/types';
import { carParkGeo } from '../../city/districts/carPark';
import { circlePolygon, distToPolygonEdge } from '../../city/districts/geom';
import type { Vec2 } from '../../sim/math';
import { GeoBuilder } from '../geoBuilder';
import { carParkStreetLamps } from '../districts/carPark';
import { parkLamps } from './props';
import { heightFogShader } from '../heightFog';

const AREA_LIGHT = {
  /** Lantern pool radius (m), rings and segments of its disc (rings 2.5 m apart follow the lawn's rolls). */
  poolR: 10,
  rings: 4,
  segs: 12,
  /** Lantern light (linear, additive at the pool's middle). */
  lamp: new THREE.Color(0xffc890).multiplyScalar(0.7),
  /**
   * The real light that follows the car (NightLighting) sits this high over a
   * lantern's base (m): higher than the lantern, so its short post doesn't burn
   * a hot spot into the lawn and the light still reaches across the path.
   */
  lightY: 6.5,
  /** Floods under centrepieces: the radius is `base` plus `perSize` times the piece's footprint (m), at most `max`; the color is added at the pool's middle. */
  flood: { base: 4.5, perSize: 1.4, max: 14, color: new THREE.Color(0xffd8a8).multiplyScalar(0.5), kinds: new Set(['statue', 'clock', 'kiosk', 'fountain', 'obelisk', 'column', 'arch', 'basin', 'sculpture', 'urn']) },
  /**
   * Wash per area: color (linear, additive), how far in from the edge it fades
   * up (m) and the triangle size it drapes with (m). Corner pockets and small
   * plazas are lit evenly; the big monument plaza only faintly, so its lantern
   * pools give it shape instead of one flat bright floor. A parking lot's
   * asphalt takes a dim warm wash: enough to tell it from the dark of a
   * building's back, its lamp pools do the rest. A car park's apron is lit
   * by the garage's spill and its own lamps, so it is brighter than a lot.
   */
  wash: {
    park: { color: new THREE.Color(0x3c6a34).multiplyScalar(0.11), fade: 9, edge: 5 },
    plaza: { color: new THREE.Color(0xffd8a8).multiplyScalar(0.16), fade: 1.2, edge: 3 },
    monument: { color: new THREE.Color(0xffd8a8).multiplyScalar(0.035), fade: 4, edge: 8 },
    /** A roundabout's lawn island: lit like a park but evenly, its lanterns stand right at the rim. */
    island: { color: new THREE.Color(0x3c6a34).multiplyScalar(0.13), fade: 4, edge: 2.5 },
    lot: { color: new THREE.Color(0xffc890).multiplyScalar(0.075), fade: 2, edge: 4 },
    apron: { color: new THREE.Color(0xffd8a8).multiplyScalar(0.13), fade: 1.5, edge: 3 },
  },
  /** What light picks up from the ground it lands on: lawn takes it green, paving and asphalt warm. */
  grassTint: new THREE.Color(0.7, 1, 0.55),
  /**
   * Lift over the drawn ground (m): grass and its gravel path, sidewalk level paving, the road, and
   * cobbles (over a park path's paint, which lies 0.075 over the lawn, render/districts/park.ts).
   */
  liftGrass: 0.12,
  liftPaved: CITY.curbHeight + 0.06,
  liftRoad: 0.06,
  liftCobble: 0.11,
} as const;

/** Pool falloff: the radial glow profile of the street pools (textures.ts makeRadialGlow), t = r / radius. */
function poolFalloff(t: number): number {
  if (t >= 1) return 0;
  if (t < 0.25) return 1 - (t / 0.25) * 0.45;
  if (t < 0.6) return 0.55 - ((t - 0.25) / 0.35) * 0.4;
  return 0.15 * (1 - (t - 0.6) / 0.4);
}

export interface AreaLights {
  group: THREE.Group;
  /**
   * Where the real light of each lamp goes (NightLighting): the park lamps first, in parkLamps order
   * (the props' light order), then the car parks' street lamps, which no prop ever switches off.
   */
  lamps: THREE.Vector3[];
  /** Switch the k-th park lamp's pool (parkLamps order): broken lamps go dark. */
  setLampOn(k: number, on: boolean): void;
  dispose(): void;
}

export function buildAreaLights(world: World): AreaLights {
  const group = new THREE.Group();
  group.name = 'areaLights';
  const h = world.heightAt;
  const gb = new GeoBuilder(true);
  const c = new THREE.Color();
  const A = AREA_LIGHT;

  const liftAt = (x: number, z: number): number => {
    const s = world.surfaceAt(x, z);
    return s === 'road' ? A.liftRoad : s === 'cobble' ? A.liftCobble : s === 'sidewalk' || s === 'concrete' || s === 'quay' || s === 'boardwalk' || s === 'sand' ? A.liftPaved : A.liftGrass;
  };

  // ---------- Washes ----------
  /** The wash over one convex polygon: a quad is one bilinear grid, any other shape a fan of sector grids. */
  const wash = (poly: Vec2[], W: { color: THREE.Color; fade: number; edge: number }, lift: number) => {
    if (poly.length < 3) return;
    const vertex = (x: number, z: number) => {
      const k = Math.min(1, Math.max(0, distToPolygonEdge(x, z, poly) / W.fade));
      c.copy(W.color).multiplyScalar(k * k * (3 - 2 * k));
      return gb.vertex(x, h(x, z) + lift, z, 0, 1, 0, 0, 0, c);
    };
    // A quad (every pocket, most parks) is one bilinear grid of about W.edge cells; any other
    // convex shape is a fan of sectors from its middle, each a grid squeezed to a point there.
    const grid = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2) => {
      const ns = Math.max(1, Math.ceil(Math.max(Math.hypot(p1.x - p0.x, p1.z - p0.z), Math.hypot(p2.x - p3.x, p2.z - p3.z)) / W.edge));
      const nt = Math.max(1, Math.ceil(Math.max(Math.hypot(p3.x - p0.x, p3.z - p0.z), Math.hypot(p2.x - p1.x, p2.z - p1.z)) / W.edge));
      const ids: number[] = [];
      for (let j = 0; j <= nt; j++) {
        const t = j / nt;
        for (let i = 0; i <= ns; i++) {
          const u = i / ns;
          const ax = p0.x + (p1.x - p0.x) * u;
          const az = p0.z + (p1.z - p0.z) * u;
          const bx = p3.x + (p2.x - p3.x) * u;
          const bz = p3.z + (p2.z - p3.z) * u;
          ids.push(vertex(ax + (bx - ax) * t, az + (bz - az) * t));
        }
      }
      for (let j = 0; j < nt; j++) {
        for (let i = 0; i < ns; i++) {
          const v = j * (ns + 1) + i;
          gb.quadFacing(ids[v], ids[v + 1], ids[v + ns + 2], ids[v + ns + 1], 0, 1, 0);
        }
      }
    };
    if (poly.length === 4) grid(poly[0], poly[1], poly[2], poly[3]);
    else {
      let cx = 0;
      let cz = 0;
      for (const p of poly) {
        cx += p.x / poly.length;
        cz += p.z / poly.length;
      }
      const mid = { x: cx, z: cz };
      for (let i = 0; i < poly.length; i++) grid(mid, poly[i], poly[(i + 1) % poly.length], mid);
    }
  };
  const washed = (a: Area) => a.kind === 'park' || a.kind === 'monument' || a.kind === 'roundabout' || a.kind === 'parkingLot' || (a.kind === 'infill' && (a.variant === 'plaza' || a.variant === 'cornerPlaza' || a.variant === 'lot'));
  for (const a of world.areas) {
    if (!washed(a)) continue;
    // A roundabout's area is the whole junction; its wash covers the island only.
    const poly = a.kind === 'roundabout' ? circlePolygon(a.params.x, a.params.z, a.params.island, 32) : a.polygon;
    const lawn = a.kind === 'park' || (a.kind === 'roundabout' && !a.params.paved);
    const lot = a.kind === 'parkingLot' || (a.kind === 'infill' && a.variant === 'lot');
    const W = a.kind === 'park' || a.kind === 'monument' ? A.wash[a.kind] : a.kind === 'roundabout' ? (lawn ? A.wash.island : A.wash.plaza) : lot ? A.wash.lot : A.wash.plaza;
    // Islands are drawn at ground level, not at curb height like a plaza's paving; a lot is asphalt at road level.
    const lift = lawn ? A.liftGrass : a.kind === 'roundabout' ? A.liftGrass : lot ? A.liftRoad : A.liftPaved;
    wash(poly, W, lift);
  }
  // Each car park's apron: the flared mouth of its ramp between the building line and the covered part.
  const garages = world.areas.filter((a) => a.kind === 'carPark').map((a) => carParkGeo(a));
  for (const g of garages) {
    const r = g.ramp;
    wash([r[0], r[1], r[4], r[5]], A.wash.apron, A.liftRoad);
  }

  // ---------- Lantern pools ----------
  const pool = (x: number, z: number, radius: number = A.poolR, color: THREE.Color = A.lamp) => {
    const at = (px: number, pz: number, t: number) => {
      c.copy(color).multiplyScalar(poolFalloff(t));
      if (world.surfaceAt(px, pz) === 'grass') c.multiply(A.grassTint);
      return gb.vertex(px, h(px, pz) + liftAt(px, pz), pz, 0, 1, 0, 0, 0, c);
    };
    const center = at(x, z, 0);
    const rings: number[][] = [];
    for (let r = 1; r <= A.rings; r++) {
      const t = r / A.rings;
      const ring: number[] = [];
      for (let k = 0; k < A.segs; k++) {
        const ang = (k / A.segs) * Math.PI * 2;
        ring.push(at(x + Math.cos(ang) * radius * t, z + Math.sin(ang) * radius * t, t));
      }
      rings.push(ring);
    }
    for (let k = 0; k < A.segs; k++) gb.triFacing(center, rings[0][k], rings[0][(k + 1) % A.segs], 0, 1, 0);
    for (let r = 1; r < A.rings; r++) {
      for (let k = 0; k < A.segs; k++) {
        const k1 = (k + 1) % A.segs;
        gb.quadFacing(rings[r - 1][k], rings[r][k], rings[r][k1], rings[r - 1][k1], 0, 1, 0);
      }
    }
  };
  // The park lamps' pools first, one block of perPool vertices each, so setLampOn can find them.
  const lanterns = parkLamps(world);
  const poolStart = gb.vertexCount;
  const perPool = 1 + A.rings * A.segs;
  for (const p of lanterns) pool(p.x, p.z);
  // Then the car parks' street lamps, never switched off.
  const fixed: Vec2[] = garages.flatMap((g) => carParkStreetLamps(g));
  for (const p of fixed) pool(p.x, p.z);
  // And the floods under the plazas' centrepieces, which nothing switches off.
  for (const b of world.districts.builds) for (const p of b.props) if (A.flood.kinds.has(p.kind)) pool(p.x, p.z, Math.min(A.flood.max, A.flood.base + A.flood.perSize * p.size), A.flood.color);

  const geo = gb.build();
  const colors = geo.getAttribute('color') as THREE.BufferAttribute;
  const lit = (colors.array as Float32Array).slice();
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // Light added on top fades out with distance; mixing it toward the fog color would make far parks glow.
  mat.onBeforeCompile = (shader) => {
    heightFogShader(shader, true);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'areaLights';
  mesh.renderOrder = 1;
  if (geo.getAttribute('position').count) group.add(mesh);

  return {
    group,
    lamps: [...lanterns.map((p) => new THREE.Vector3(p.x, p.y + A.lightY, p.z)), ...fixed.map((p) => new THREE.Vector3(p.x, h(p.x, p.z) + A.lightY, p.z))],
    setLampOn(k, on) {
      if (k < 0 || k >= lanterns.length) return;
      const start = (poolStart + k * perPool) * 3;
      const count = perPool * 3;
      const arr = colors.array as Float32Array;
      if (on) arr.set(lit.subarray(start, start + count), start);
      else arr.fill(0, start, start + count);
      colors.addUpdateRange(start, count);
      colors.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
