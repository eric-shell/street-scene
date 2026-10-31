/**
 * Finds the node paths the races run: a closed circuit and a point to point
 * sprint planned with the city (scored on length and corners, steered by the
 * event's RoutePreference), and, from the finished city, the drag strip (the
 * straightest long run) and the waypoint race's suggested route. route.ts
 * builds a Route from the nodes these return.
 */
import { ROUTE } from './config';
import { type RoadEdge, type RoadGraph, chainFrom, edgeBetween, isBendNode, isChannelEdge, isFeatureEdge, otherNode } from './roadGraph';
import { Rng, deriveSeed } from '../sim/prng';
import { routeChains } from './districts/alleyPath';
import { isChannelNode } from './districts/channel';
import { DEG, abs, sqrt } from '../sim/math';
import { dijkstra } from './graphSearch';
import { DRAG_DISTANCE, cornerStats, polylineFrom, routeRuns, turnAngle, type CornerStats } from './route';

function pathLength(g: RoadGraph, nodes: number[], closed: boolean): number {
  let len = 0;
  const m = closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < m; i++) {
    const a = g.nodes[nodes[i]];
    const b = g.nodes[nodes[(i + 1) % nodes.length]];
    len += sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
  }
  return len;
}

/** `bias` remembered per edge: it is pure for a graph and the finders ask it for every edge of every attempt. */
function memoBias(edges: number, bias?: (edge: number) => number): ((edge: number) => number) | undefined {
  if (!bias) return undefined;
  const cache = new Float64Array(edges).fill(NaN);
  return (i) => (cache[i] === cache[i] ? cache[i] : (cache[i] = bias(i)));
}

function randomWeights(g: RoadGraph, rng: Rng, bias?: (edge: number) => number): Float64Array {
  const w = new Float64Array(g.edges.length);
  g.edges.forEach((e, i) => {
    // Favor the wide fast roads a little so routes have long straights, raceway alleys so more races
    // squeeze through one, and the channel most of all: a race that can dive in, does.
    const kindBias = e.kind === 'boulevard' ? 0.7 : e.kind === 'diagonal' ? 0.75 : e.kind === 'avenue' ? 0.85 : e.kind === 'alley' ? 0.78 : e.kind === 'channel' ? ROUTE.channelBias : 1;
    const r = rng.range(0.45, 1.9);
    // Back alley shortcuts and loop mouths are never part of a route (Infinity is never relaxed).
    w[i] = e.shortcut || e.kind === 'mouth' ? Infinity : e.length * kindBias * r * (bias ? bias(i) : 1);
  });
  return w;
}

function score(stats: CornerStats, len: number, minLen: number, maxLen: number): number {
  let s = 0;
  if (len < minLen) s -= (minLen - len) / 100;
  if (len > maxLen) s -= (len - maxLen) / 100;
  s -= Math.max(0, ROUTE.minTightCorners - stats.tight) * 2;
  s -= Math.max(0, ROUTE.minSweepers - stats.sweepers) * 2;
  s -= Math.max(0, stats.maxTurn - ROUTE.maxTurnDeg) * 10;
  return s;
}

/**
 * What the finders would rather pick (planRoads: what the seed's event
 * flavour wants, see events.ts, and a dive into the channel). The
 * search goes on past acceptable routes until it finds one `prefer` likes
 * (one rated `goal` when `rate` grades them), and settles for the best plain
 * route only when none liked comes within ROUTE.preferSlack of it; among
 * liked ones the highest rated within that slack wins. Two in three attempts
 * start from one of the `anchors` (the feet of the channel's side ramps, say:
 * a path leaving a foot by its ramp can only come back along the channel).
 */
export interface RoutePreference {
  prefer: (nodes: number[]) => boolean;
  anchors: number[];
  /** Graded liking: 0 = not liked, higher = liked more (stands in for `prefer` when given). */
  rate?: (nodes: number[]) => number;
  /** The rating that ends the search once a route is also acceptable (default 1). */
  goal?: number;
  /** A second anchor set: circuits take one far end in three from it, sprints alternate their waypoint between both sets. */
  via?: number[];
  /** Dijkstra weight factor per edge id (below 1 draws routes along it), on top of the kind biases. */
  bias?: (edge: number) => number;
}

/** A preference's grading: `rate`, or `prefer` as 0 / 1. */
function rater(want: RoutePreference | undefined): ((nodes: number[]) => number) | undefined {
  if (!want) return undefined;
  return want.rate ?? ((nodes) => (want.prefer(nodes) ? 1 : 0));
}

/** The highest rated liked route within ROUTE.preferSlack of the best plain score, if any. */
function bestRated(rated: ({ nodes: number[]; score: number } | undefined)[], bestScore: number): number[] | null {
  for (let l = rated.length - 1; l > 0; l--) {
    const r = rated[l];
    if (r && r.score >= bestScore - ROUTE.preferSlack) return r.nodes;
  }
  return null;
}

/** `variant` > 0 draws an alternative circuit from its own random stream (planRoads uses it when a circuit has no room for a shortcut). */
export function findCircuitNodes(g: RoadGraph, seed: number, variant = 0, want?: RoutePreference): number[] {
  const rng = new Rng(deriveSeed(seed, variant ? `circuit:${variant}` : 'circuit'));
  let best: number[] | null = null;
  let bestScore = -Infinity;
  // Best liked route per rating (index = rating, 1 up to the goal).
  const rated: ({ nodes: number[]; score: number } | undefined)[] = [];
  const rate = rater(want);
  const goal = want?.goal ?? 1;
  const anchors = want?.anchors ?? [];
  const via = want?.via ?? [];
  const bias = memoBias(g.edges.length, want?.bias);
  const n = g.nodes.length;
  // Looking for a liked route takes more tries: two in three start from an anchor.
  const attempts = rate ? ROUTE.maxAttempts * 2 : ROUTE.maxAttempts;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // The weights are the first draws of the attempt; most attempts are dropped on the pair's separation,
    // so they are made (from a copy of the stream) only for the ones that go on.
    const weightsAt = rng.getState();
    rng.skip(g.edges.length);
    const a = anchors.length && attempt % 3 ? anchors[rng.int(0, anchors.length - 1)] : rng.int(0, n - 1);
    const b = via.length && attempt % 3 === 2 ? via[rng.int(0, via.length - 1)] : rng.int(0, n - 1);
    const A = g.nodes[a];
    const B = g.nodes[b];
    const sep = sqrt((A.x - B.x) ** 2 + (A.z - B.z) ** 2);
    if (sep < 290 || sep > 940) continue;
    const w = randomWeights(g, new Rng(weightsAt), bias);
    const none = new Uint8Array(n);
    const p1 = dijkstra(g, a, b, w, none, new Uint8Array(g.edges.length));
    if (!p1 || p1.length < 3) continue;
    const blockedN = new Uint8Array(n);
    for (let i = 1; i < p1.length - 1; i++) blockedN[p1[i]] = 1;
    const blockedE = new Uint8Array(g.edges.length);
    for (let i = 0; i + 1 < p1.length; i++) blockedE[edgeBetween(g, p1[i], p1[i + 1])] = 1;
    const p2 = dijkstra(g, b, a, w, blockedN, blockedE);
    if (!p2 || p2.length < 3) continue;
    const cycle = p1.concat(p2.slice(1, -1));
    const len = pathLength(g, cycle, true);
    const stats = cornerStats(g, cycle, true);
    if (stats.maxTurn > ROUTE.maxTurnDeg && best) continue;
    const sc = score(stats, len, ROUTE.circuitMinLength, ROUTE.circuitMaxLength);
    if (sc > bestScore) {
      bestScore = sc;
      best = cycle;
    }
    const level = rate ? Math.min(goal, rate(cycle)) : 0;
    if (level > 0 && !(rated[level] && rated[level]!.score >= sc)) rated[level] = { nodes: cycle, score: sc };
    if (sc >= 0 && (!rate || level >= goal)) break;
  }
  const preferred = bestRated(rated, bestScore);
  if (preferred) return preferred;
  if (!best) throw new Error('could not find a circuit');
  return best;
}

/** `variant` > 0 draws an alternative sprint from its own random stream (see findCircuitNodes). */
export function findSprintNodes(g: RoadGraph, seed: number, variant = 0, want?: RoutePreference): number[] {
  const rng = new Rng(deriveSeed(seed, variant ? `sprint:${variant}` : 'sprint'));
  const n = g.nodes.length;
  const span = sqrt((g.bounds.maxX - g.bounds.minX) ** 2 + (g.bounds.maxZ - g.bounds.minZ) ** 2);
  // A sprint starts and ends at a junction (its closures seal the start, and the end has a cross street
  // to brake toward), never mid-street at a bend node.
  const junctions = g.nodes.filter((nd) => !isBendNode(g, nd.id)).map((nd) => nd.id);
  let best: number[] | null = null;
  let bestScore = -Infinity;
  const rated: ({ nodes: number[]; score: number } | undefined)[] = [];
  const rate = rater(want);
  const goal = want?.goal ?? 1;
  const second = want?.via ?? [];
  const bias = memoBias(g.edges.length, want?.bias);
  const attempts = rate ? ROUTE.maxAttempts * 2 : ROUTE.maxAttempts;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const weightsAt = rng.getState();
    rng.skip(g.edges.length);
    const a = junctions[rng.int(0, junctions.length - 1)];
    const b = junctions[rng.int(0, junctions.length - 1)];
    // Through a ramp foot: the leg in by the ramp forces the leg out along the channel, or vice versa.
    const anchors = second.length && attempt % 3 === 2 ? second : (want?.anchors ?? []);
    const via = anchors.length && attempt % 3 ? anchors[rng.int(0, anchors.length - 1)] : rng.int(0, n - 1);
    const A = g.nodes[a];
    const B = g.nodes[b];
    if (sqrt((A.x - B.x) ** 2 + (A.z - B.z) ** 2) < span * 0.4) continue;
    // Sprints start and end on a street, not in a roundabout.
    if (A.ring || B.ring) continue;
    if (via === a || via === b) continue;
    const w = randomWeights(g, new Rng(weightsAt), bias);
    // Go through a waypoint so sprints wind across town instead of beelining.
    const p1 = dijkstra(g, a, via, w, new Uint8Array(n), new Uint8Array(g.edges.length));
    if (!p1) continue;
    const blocked = new Uint8Array(n);
    for (let i = 0; i < p1.length - 1; i++) blocked[p1[i]] = 1;
    if (blocked[b]) continue;
    const p2 = dijkstra(g, via, b, w, blocked, new Uint8Array(g.edges.length));
    if (!p2) continue;
    const p = p1.concat(p2.slice(1));
    // The first street (its pieces through bend nodes, up to the first junction) hosts the start grid,
    // so it has to be long and straight enough; grid and finish stay on streets, never in the channel
    // channel or on a ramp.
    const edges = polylineFrom(g, p, false);
    const firstRun = routeRuns(g, p, edges, false)[0];
    const first = firstRun.edges.map((e) => g.edges[e]);
    const last = g.edges[edges[edges.length - 1]];
    // Nor across a level crossing's tracks (districts/bluff.ts).
    // Nor on a weekend region's spine (districts/weekendRegion.ts).
    if (firstRun.length < 90 || first.some((e) => isChannelEdge(e) || e.crossing !== undefined || isFeatureEdge(e)) || isChannelEdge(last) || last.crossing !== undefined || isFeatureEdge(last)) continue;
    const len = pathLength(g, p, false);
    const stats = cornerStats(g, p, false);
    if (stats.maxTurn > ROUTE.maxTurnDeg && best) continue;
    const sc = score(stats, len, ROUTE.sprintMinLength, ROUTE.sprintMaxLength);
    if (sc > bestScore) {
      bestScore = sc;
      best = p;
    }
    const level = rate ? Math.min(goal, rate(p)) : 0;
    if (level > 0 && !(rated[level] && rated[level]!.score >= sc)) rated[level] = { nodes: p, score: sc };
    if (sc >= 0 && (!rate || level >= goal)) break;
  }
  const preferred = bestRated(rated, bestScore);
  if (preferred) return preferred;
  if (!best) throw new Error('could not find a sprint');
  return best;
}

/** Through streets a drag strip may run along: no alley, channel floor, ramp or level crossing. */
const DRAG_KINDS = new Set(['street', 'avenue', 'boulevard', 'diagonal']);

/**
 * The drag strip: the widest run of streets straight enough (no node on it
 * bending more than the first of ROUTE.dragBendDeg, no roundabout) and long
 * enough for the start, DRAG_DISTANCE and the runout, cut to just that.
 * `edgeOk` rules out streets the city has put something on (roadworks, the
 * night market, ...); world.ts knows the districts, this module does not. A
 * city with no straight that long allows the next gentler bends, and with
 * none at all the longest run wins (buildRoute then races it to the runout).
 * The seed only breaks ties, so the strip moves between the city's best.
 */
export function findDragNodes(g: RoadGraph, seed: number, edgeOk: (edge: number) => boolean = () => true): number[] {
  let longest: { nodes: number[]; len: number } | null = null;
  for (const bend of ROUTE.dragBendDeg) {
    const best = straightestRun(g, seed, edgeOk, bend);
    if (best && best.len >= DRAG_NEED) return best.nodes;
    if (best && (!longest || best.len > longest.len)) longest = best;
  }
  if (!longest) throw new Error('could not find a drag strip');
  return longest.nodes;
}

/** Straight a drag strip needs (m): the start, the race and the runout. */
const DRAG_NEED = ROUTE.dragStartOffset + DRAG_DISTANCE + ROUTE.dragRunout;

/** The best run of drag streets bending at most `bendDeg` at each node: long enough first, then widest; its nodes and length (m). */
function straightestRun(g: RoadGraph, seed: number, edgeOk: (edge: number) => boolean, bendDeg: number): { nodes: number[]; len: number } | null {
  const rng = new Rng(deriveSeed(seed, 'drag'));
  const need = DRAG_NEED;
  const ok = (eid: number) => {
    const e = g.edges[eid];
    return DRAG_KINDS.has(e.kind) && !e.shortcut && e.crossing === undefined && edgeOk(eid);
  };
  let best: { nodes: number[]; len: number } | null = null;
  let bestScore = -Infinity;
  for (const start of g.nodes) {
    if (start.ring || isBendNode(g, start.id)) continue;
    for (const e0 of start.edges) {
      // The grid stands on the first street (its pieces through bend nodes), clear of the intersection behind it.
      if (!ok(e0) || chainFrom(g, start.id, e0).length < ROUTE.dragStartOffset + 20) continue;
      const nodes = [start.id, otherNode(g.edges[e0], start.id)];
      let len = g.edges[e0].length;
      let width = g.edges[e0].width;
      while (len < need && !g.nodes[nodes[nodes.length - 1]].ring) {
        const a = nodes[nodes.length - 2];
        const b = nodes[nodes.length - 1];
        let next = -1;
        for (const eid of g.nodes[b].edges) {
          const c = otherNode(g.edges[eid], b);
          if (c === a || !ok(eid) || nodes.includes(c)) continue;
          if (abs(turnAngle(g, a, b, c)) <= bendDeg * DEG) next = eid;
        }
        if (next < 0) break;
        nodes.push(otherNode(g.edges[next], b));
        len += g.edges[next].length;
        width = Math.min(width, g.edges[next].width);
      }
      // The strip ends on a street, not in a roundabout.
      if (g.nodes[nodes[nodes.length - 1]].ring) {
        len -= g.edges[edgeBetween(g, nodes[nodes.length - 2], nodes[nodes.length - 1])].length;
        nodes.pop();
      }
      if (nodes.length < 2) continue;
      // Long enough beats everything, then the widest street; the seed's jitter picks among equals.
      const sc = (len >= need ? 1e4 : len) + width * 20 + rng.range(0, 10);
      if (sc > bestScore) {
        bestScore = sc;
        best = { nodes, len };
      }
    }
  }
  return best;
}

/**
 * The waypoint race: ROUTE.waypointCount waypoints (plain intersections, off
 * the channel and the roundabouts) strung across town between a start and a
 * finish, and the suggested route through them, the shortest way leg by leg
 * that never crosses itself. The AI drives the suggestion; the player may take
 * any street (the world is open, see createWorld). Returns the route's nodes
 * and, of those, the waypoints in order. With `prefer` (the route's nodes and
 * its waypoints), an acceptable route it likes ends the search; ones it does
 * not are kept as the fallback for up to ROUTE.waypointPreferTries more.
 * `bias` scales an edge's weight for the legs (a weekend region's spine); `pair`, two junctions the course
 * should pass in turn (that region's entry and exit), is made two consecutive waypoints on two attempts in three.
 */
export function findWaypointNodes(g: RoadGraph, seed: number, prefer?: (nodes: number[], waypoints: number[]) => boolean, bias?: (edge: number) => number, pair?: readonly [number, number]): { nodes: number[]; waypoints: number[] } {
  const rng = new Rng(deriveSeed(seed, 'waypoint'));
  const n = g.nodes.length;
  // Plain distances: the suggestion is the quick way, not the scenic one (`bias` scales an edge's: a weekend region's spine draws it in).
  const w = new Float64Array(g.edges.length);
  g.edges.forEach((e, i) => (w[i] = e.shortcut || e.kind === 'mouth' ? Infinity : bias ? e.length * bias(i) : e.length));
  // Stops are junctions: never a bend node partway along a street (roadGraph.ts).
  const plain = (id: number) => !g.nodes[id].ring && !isChannelNode(g, id) && !isBendNode(g, id);
  const far = (a: number, b: number, lo: number, hi: number) => {
    const d = sqrt((g.nodes[a].x - g.nodes[b].x) ** 2 + (g.nodes[a].z - g.nodes[b].z) ** 2);
    return d >= lo && d <= hi;
  };
  let best: { nodes: number[]; waypoints: number[] } | null = null;
  let bestScore = -Infinity;
  // A region's pair is worth a longer look than a pass: the race is meant to go through it.
  let patience: number = pair ? ROUTE.waypointPreferTries * 5 : ROUTE.waypointPreferTries;
  /** A stop a leg (lo..hi m) from `from` and clear of `taken`, or -1 after 30 draws. */
  const nextStop = (from: number, taken: readonly number[], lo: number, hi: number): number => {
    for (let tries = 0; tries < 30; tries++) {
      const c = rng.int(0, n - 1);
      if (!plain(c) || !far(from, c, lo, hi)) continue;
      if (taken.some((s) => s === c || far(s, c, 0, ROUTE.waypointLegMin * 0.7))) continue;
      return c;
    }
    return -1;
  };
  for (let attempt = 0; attempt < ROUTE.maxAttempts; attempt++) {
    let stops: number[];
    if (pair && attempt % 3) {
      // A pair the course should pass in turn (a weekend region's entry and exit): two in three attempts build the course
      // out from them, consecutive waypoints either way round, the other stops drawn a leg out forward and back.
      const at = rng.int(1, ROUTE.waypointCount - 1);
      const flip = rng.chance(0.5);
      const seq: number[] = new Array(ROUTE.waypointCount + 2).fill(-1);
      seq[at] = flip ? pair[1] : pair[0];
      seq[at + 1] = flip ? pair[0] : pair[1];
      let ok = true;
      for (let k = at + 2; ok && k < seq.length; k++) ok = (seq[k] = nextStop(seq[k - 1], seq.filter((x, j) => x >= 0 && j !== k - 1), ROUTE.waypointLegMin, ROUTE.waypointLegMax)) >= 0;
      for (let k = at - 1; ok && k >= 0; k--) ok = (seq[k] = nextStop(seq[k + 1], seq.filter((x, j) => x >= 0 && j !== k + 1), ROUTE.waypointLegMin, ROUTE.waypointLegMax)) >= 0;
      if (!ok) continue;
      stops = seq;
    } else {
      stops = [rng.int(0, n - 1)];
      // Waypoints, then the finish's node, each a leg away from the last and clear of the earlier ones.
      for (let k = 0; k <= ROUTE.waypointCount && stops.length === k + 1; k++) {
        for (let tries = 0; tries < 30; tries++) {
          const c = rng.int(0, n - 1);
          if (!plain(c) || !far(stops[k], c, ROUTE.waypointLegMin, ROUTE.waypointLegMax)) continue;
          if (stops.slice(0, -1).some((s) => far(s, c, 0, ROUTE.waypointLegMin * 0.7))) continue;
          stops.push(c);
          break;
        }
      }
      if (stops.length !== ROUTE.waypointCount + 2 || !plain(stops[0])) continue;
    }
    const used = new Uint8Array(n);
    let path: number[] = [stops[0]];
    for (let k = 1; k < stops.length && path.length; k++) {
      for (const id of path) used[id] = 1;
      used[stops[k - 1]] = 0;
      const leg = dijkstra(g, stops[k - 1], stops[k], w, used, new Uint8Array(g.edges.length));
      if (!leg || leg.slice(1).some((id) => used[id])) path = [];
      else path = path.concat(leg.slice(1));
    }
    if (path.length < 3) continue;
    // Grid and finish on streets: a long enough first street (its pieces through bend nodes), never on
    // the channel or across the tracks.
    const edges = polylineFrom(g, path, false);
    const runs = routeRuns(g, path, edges, false);
    const first = runs[0].edges.map((e) => g.edges[e]);
    const lastRun = runs[runs.length - 1];
    const last = lastRun.edges.map((e) => g.edges[e]);
    const bad = (es: RoadEdge[]) => es.some((e) => isChannelEdge(e) || e.crossing !== undefined || isFeatureEdge(e));
    if (runs[0].length < 90 || bad(first) || bad(last) || lastRun.length < 60) continue;
    // Never the long way round a route shortcut (districts/alley.ts): a back alley joining two of the
    // suggestion's nodes shorter than the stretch it skips makes the distance by road (World field)
    // climb as a car on the suggestion passes its mouth.
    const pathCum = [0];
    for (let k = 1; k < path.length; k++) pathCum.push(pathCum[k - 1] + g.edges[edges[k - 1]].length);
    const at = new Map(path.map((id, k) => [id, k]));
    const cut = routeChains(g, path).some((c) => {
      const ka = at.get(c.nodes[0]);
      const kb = at.get(c.nodes[c.nodes.length - 1]);
      return ka !== undefined && kb !== undefined && c.length < abs(pathCum[kb] - pathCum[ka]);
    });
    if (cut) continue;
    const len = pathLength(g, path, false);
    const sc = score(cornerStats(g, path, false), len, ROUTE.waypointMinLength, ROUTE.waypointMaxLength);
    const liked = sc >= 0 && !!prefer?.(path, stops.slice(1, -1));
    // The first acceptable route stays the fallback (the one found without a preference); only a liked one replaces it.
    if (liked || (bestScore < 0 && sc > bestScore)) {
      bestScore = sc;
      best = { nodes: path, waypoints: stops.slice(1, -1) };
    }
    if (liked || (sc >= 0 && (!prefer || --patience < 0))) break;
  }
  // The pair can crowd out every acceptable course on a tight city: draw again without it.
  if (!best && pair) return findWaypointNodes(g, seed, prefer, bias);
  if (!best) throw new Error('could not find a waypoint race');
  return best;
}
