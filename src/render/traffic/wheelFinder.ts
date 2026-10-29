/**
 * Finds the wheels of a traffic vehicle in its merged mesh, so the vertex shader can spin them.
 *
 * `npm run traffic` bakes each vehicle into ONE mesh (public/traffic/traffic.glb) and Blender is not part of
 * the game, so nothing in the file says where a wheel is. The source packs model every wheel as its own
 * closed shell (tire, rim, hubcap, brake disc) joined into the body mesh, though, and a shell is a connected
 * component of the triangle graph. So: weld the vertices by position (glTF splits them at every UV and
 * normal seam), union the triangles that share a welded vertex, and call a component a wheel when its
 * bounding box is a disc standing on the ground with its axle along x. Shells that sit inside a found wheel
 * (rim, hubcap, disc) join it and turn at the tire's rate.
 *
 * Failure mode: a kind whose wheels are not separate shells (fused into the body, or all four joined by
 * the chassis) finds none, `radius` is 0 and the kind simply does not turn. Nothing else changes.
 *
 * Pure typed arrays in and out (no three.js), so a script can run it on the GLB headlessly.
 */

/** One wheel: its centre (car space, m) and its tire radius (m). */
export interface FoundWheel {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** What `findWheels` returns. */
export interface WheelResult {
  /** Four floats per vertex: the wheel's centre x, y, z (m) and the kind's mean tire radius (m); radius 0 on body vertices. */
  attr: Float32Array;
  /** The kind's tire radius (m, mean over its wheels); 0 when no wheel was found. */
  radius: number;
  wheels: FoundWheel[];
}

/** Welding grid (m): vertices closer than this are one. */
const WELD = 0.001;
/** A disc's y and z extents agree within this share. */
const ROUND = 0.2;
/** A wheel's diameter range (m). */
const DIAMETER = [0.45, 1.4] as const;
/** The axle extent against the diameter at most. */
const THIN = 0.75;
/** A wheel's lowest point is under this (m): it stands on the road. */
const GROUND = 0.15;
/** A wheel's centre is outside this share of the half width (a steering wheel is inside). */
const OUTSIDE = 0.3;
/** A part is concentric with a wheel within these (m): along the axle, and across it. */
const CONCENTRIC_X = 0.3;
const CONCENTRIC_YZ = 0.06;
/** A concentric part is no bigger than its wheel's diameter plus this (m). */
const CONCENTRIC_D = 0.02;
/** How deep a joined component is split to look for the wheels in it. */
const SPLIT_DEPTH = 2;

/** A set of vertices (indices into the welded list) with its bounding box. */
interface Part {
  verts: number[];
  min: [number, number, number];
  max: [number, number, number];
}

function partOf(verts: number[], pos: Float64Array): Part {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    for (let a = 0; a < 3; a++) {
      const p = pos[v * 3 + a];
      if (p < min[a]) min[a] = p;
      if (p > max[a]) max[a] = p;
    }
  }
  return { verts, min, max };
}

/** Is this part a wheel by its box alone, and if not, is it only too wide or too long for one? */
function judge(p: Part, halfWidth: number): 'wheel' | 'big' | 'no' {
  const ex = p.max[0] - p.min[0];
  const ey = p.max[1] - p.min[1];
  const ez = p.max[2] - p.min[2];
  const d = Math.max(ey, ez);
  if (p.min[1] >= GROUND || d < DIAMETER[0]) return 'no';
  const round = Math.abs(ey - ez) <= ROUND * d;
  const fits = round && d <= DIAMETER[1] && ex < THIN * d;
  // Too wide (an axle joining two wheels) or too long (front and rear joined) for one wheel: worth splitting.
  const big = !fits && (ex >= THIN * d || d > DIAMETER[1] || ey > ez * 1.5 || ez > ey * 1.5);
  if (fits) return Math.abs((p.min[0] + p.max[0]) / 2) > OUTSIDE * halfWidth ? 'wheel' : 'no';
  return big ? 'big' : 'no';
}

/** Split a part in two about the middle of its box along an axis (0 x, 2 z). */
function halves(p: Part, pos: Float64Array, axis: 0 | 2): [Part, Part] {
  const mid = (p.min[axis] + p.max[axis]) / 2;
  const lo: number[] = [];
  const hi: number[] = [];
  for (const v of p.verts) (pos[v * 3 + axis] < mid ? lo : hi).push(v);
  return [partOf(lo, pos), partOf(hi, pos)];
}

/**
 * Find the wheels of one vehicle. `position` is xyz per vertex in car space (+z forward, y up, wheels on y = 0,
 * m), `index` the triangle list, `halfWidth` the body's half width (m).
 */
export function findWheels(position: ArrayLike<number>, index: ArrayLike<number>, halfWidth: number): WheelResult {
  const count = Math.floor(position.length / 3);
  // Weld by position.
  const cell = new Map<string, number>();
  const weld = new Int32Array(count);
  const wpos: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = position[i * 3];
    const y = position[i * 3 + 1];
    const z = position[i * 3 + 2];
    const key = `${Math.round(x / WELD)},${Math.round(y / WELD)},${Math.round(z / WELD)}`;
    let w = cell.get(key);
    if (w === undefined) {
      w = wpos.length / 3;
      cell.set(key, w);
      wpos.push(x, y, z);
    }
    weld[i] = w;
  }
  const welded = wpos.length / 3;
  const pos = Float64Array.from(wpos);
  // Union-find over the triangles.
  const parent = new Int32Array(welded);
  for (let i = 0; i < welded; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = find(weld[index[t]]);
    const b = find(weld[index[t + 1]]);
    const c = find(weld[index[t + 2]]);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    if (a2 !== c) parent[c] = a2;
  }
  const groups = new Map<number, number[]>();
  for (let v = 0; v < welded; v++) {
    const r = find(v);
    const g = groups.get(r);
    if (g) g.push(v);
    else groups.set(r, [v]);
  }
  const parts: Part[] = [];
  for (const verts of groups.values()) parts.push(partOf(verts, pos));

  // Wheels: whole components, or the halves of a too-wide or too-long one.
  const found: Part[] = [];
  const rest: Part[] = [];
  const examine = (p: Part, depth: number): void => {
    const j = judge(p, halfWidth);
    if (j === 'wheel') found.push(p);
    else if (j === 'big' && depth < SPLIT_DEPTH && p.verts.length > 8) {
      for (const axis of depth === 0 ? ([0, 2] as const) : ([2, 0] as const)) {
        const [a, b] = halves(p, pos, axis);
        if (a.verts.length && b.verts.length) {
          examine(a, depth + 1);
          examine(b, depth + 1);
          return;
        }
      }
    } else rest.push(p);
  };
  for (const p of parts) examine(p, 0);

  // Largest first, so a rim that passes for a wheel on its own joins the tire around it instead.
  found.sort((a, b) => Math.max(b.max[1] - b.min[1], b.max[2] - b.min[2]) - Math.max(a.max[1] - a.min[1], a.max[2] - a.min[2]));
  // Wheel geometry: the box middle, the tire radius half the larger of y and z extent.
  const wheels: FoundWheel[] = [];
  const members: number[][] = [];
  const concentric = (p: Part): number => {
    const cx = (p.min[0] + p.max[0]) / 2;
    const cy = (p.min[1] + p.max[1]) / 2;
    const cz = (p.min[2] + p.max[2]) / 2;
    const d = Math.max(p.max[1] - p.min[1], p.max[2] - p.min[2]);
    for (let w = 0; w < wheels.length; w++) {
      const wh = wheels[w];
      if (Math.abs(cx - wh.x) <= CONCENTRIC_X && Math.abs(cy - wh.y) <= CONCENTRIC_YZ && Math.abs(cz - wh.z) <= CONCENTRIC_YZ && d <= wh.r * 2 + CONCENTRIC_D) return w;
    }
    return -1;
  };
  for (const p of found) {
    const w = concentric(p);
    if (w >= 0) {
      for (const v of p.verts) members[w].push(v);
      continue;
    }
    wheels.push({
      x: (p.min[0] + p.max[0]) / 2,
      y: (p.min[1] + p.max[1]) / 2,
      z: (p.min[2] + p.max[2]) / 2,
      r: Math.max(p.max[1] - p.min[1], p.max[2] - p.min[2]) / 2,
    });
    members.push(p.verts.slice());
  }
  // Rims, hubcaps and discs inside a wheel turn with it.
  for (const p of rest) {
    const w = concentric(p);
    if (w >= 0) for (const v of p.verts) members[w].push(v);
  }
  // Per welded vertex its wheel, then per source vertex.
  const owner = new Int32Array(welded).fill(-1);
  members.forEach((vs, w) => {
    for (const v of vs) owner[v] = w;
  });
  // Every wheel of a kind carries the kind's mean tire radius: the roll then wraps on a whole number of turns for
  // all of them at once (a 1 cm difference between axles would otherwise show as a jump at the wrap).
  const radius = wheels.length ? wheels.reduce((s, w) => s + w.r, 0) / wheels.length : 0;
  const attr = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const w = owner[weld[i]];
    if (w < 0) continue;
    const wh = wheels[w];
    attr[i * 4] = wh.x;
    attr[i * 4 + 1] = wh.y;
    attr[i * 4 + 2] = wh.z;
    attr[i * 4 + 3] = radius;
  }
  return { attr, radius, wheels };
}
