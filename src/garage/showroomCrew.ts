/**
 * The garage's night shift: a handful of mechanics pretending to work and
 * talk. One at the bench working a ratchet, one under the high car with his
 * arms up, one running the dyno with an eye on its screen, two talking over
 * a coffee and a beer, one carrying a box between the cabs and the bench, and
 * the lift operator, who raises the fourth lift, works under it, lowers it and
 * goes back to its wheel on a minute's cycle (liftHeight drives the lift to
 * match).
 *
 * They are the game's people (render/people/person.ts): one draw call for
 * the crew, one for their shadows and one each for the boxes and cylinders
 * they hold. Each script turns the showroom's clock into a pose (position,
 * heading and the person's 16 joint values), so the crew keeps no state of
 * its own. Render only.
 */
import * as THREE from 'three';
import { clamp, lerp, smoothstep, wrapAngle } from '../sim/math';
import { BODY, People, WEAR, personFrame, plantFeet, standingPose } from '../render/people/person';
import type { PersonLook, PersonPose } from '../render/people/person';
import type { Disposable } from '../render/disposer';

type V3 = [number, number, number];

/** Something held: a box or a cylinder of `size` (m) in a hand (0 left, 1 right) or in front of the chest, at `offset` in that frame. */
interface Hold {
  at: 0 | 1 | 'spine';
  kind: 'box' | 'cyl';
  size: V3;
  offset: V3;
  color: THREE.Color;
}

/** A worker's pose for one frame: where they stand and face, the person's joints, planted feet (m forward of each hip) unless walking, what they hold. */
interface Pose extends PersonPose {
  x: number;
  z: number;
  yaw: number;
  feet: [number, number] | null;
  holds: Hold[];
}

/** The fourth lift as the operator works it: where it stands and faces, the post spacing, its car's front left wheel, its low and high ground (m). */
export interface CrewLift {
  x: number;
  z: number;
  yaw: number;
  /** Half the distance between the posts (m). */
  px: number;
  /** The car's front left wheel in lift space: across (x) and along (z), m. */
  wheel: [number, number];
  low: number;
  high: number;
}

/** The places the scripted workers use, from the showroom's layout (room space, m). */
export interface CrewSpots {
  lift: CrewLift;
  /** Under the high car on the first lift. */
  overhead: { x: number; z: number; yaw: number };
  /** At the bench under the OPEN LATE sign, facing it. */
  bench: { x: number; z: number; yaw: number };
  /** By the dyno's pendant, and the screen and car it watches. */
  dyno: { x: number; z: number; screen: [number, number]; car: [number, number] };
  /** The two talkers' spots. */
  talk: [[number, number], [number, number]];
  /** The carrier's path, end to end. */
  carry: [[number, number], [number, number]];
}

/** The lift's cycle (s): its length, and when it starts up, is up, starts down and is down. */
const LIFT_CYCLE = { period: 60, upStart: 4, upEnd: 10, downStart: 31.5, downEnd: 37.5 } as const;

/** Things held at once, across the crew. */
const MAX_HOLDS = 12;

/** The crew's clothes, in script order: dark work shirts and trousers, most with the hi-vis stripe, caps, beanies and gloves mixed. */
const LOOKS: PersonLook[] = [
  { skin: 0xc68e6a, shirt: 0x1c2a44, pants: 0x22252b, shoes: 0x1a1410, hair: 0x2a1e14, cap: 0x9a1b25, wear: WEAR.cap | WEAR.stripe | WEAR.gloves },
  { skin: 0x8a5a3c, shirt: 0x2b2d31, pants: 0x1c2233, shoes: 0x101012, hair: 0x101012, cap: 0x101012, wear: WEAR.hair | WEAR.stripe | WEAR.gloves },
  { skin: 0xe0b394, shirt: 0x6b2a1c, pants: 0x2a2a2e, shoes: 0x2a1e14, hair: 0x5a3a1e, cap: 0x101012, wear: WEAR.beanie },
  { skin: 0x5e3a26, shirt: 0x1c2a44, pants: 0x3a3426, shoes: 0xd8d8d4, hair: 0x101012, cap: 0x101012, wear: WEAR.hair | WEAR.stripe },
  { skin: 0xd8a37f, shirt: 0x3a3d44, pants: 0x22252b, shoes: 0x1a1410, hair: 0x8a5a2a, cap: 0x1d4f9a, wear: WEAR.cap },
  { skin: 0xa8714e, shirt: 0x1c2a44, pants: 0x22252b, shoes: 0x101012, hair: 0x101012, cap: 0xc8541c, wear: WEAR.beanie | WEAR.stripe | WEAR.gloves },
  { skin: 0xf0c8a8, shirt: 0x2b2d31, pants: 0x1c2233, shoes: 0x2a1e14, hair: 0xb08a50, cap: 0x101012, wear: WEAR.hair | WEAR.stripe | WEAR.gloves },
];

/** A slow wandering value in -1..1 from a few sines, so idle motion never visibly loops. */
function drift(t: number, seed: number): number {
  return (Math.sin(t * 0.37 + seed * 1.7) + Math.sin(t * 0.61 + seed * 4.1) * 0.6 + Math.sin(t * 1.13 + seed * 2.3) * 0.3) / 1.9;
}

/** The yaw that faces from (x0, z0) toward (x1, z1). */
function facing(x0: number, z0: number, x1: number, z1: number): number {
  return Math.atan2(x1 - x0, z1 - z0);
}

/** Turn from a toward b by k (0..1) the short way round. */
function turn(a: number, b: number, k: number): number {
  return a + wrapAngle(b - a) * k;
}

function standing(x: number, z: number, yaw: number): Pose {
  return { ...standingPose(), x, z, yaw, feet: [0.03, -0.03], holds: [] };
}

/** Walking from a to b, `d` m along it: the legs and arms on their cycle, the hips' bob. */
function walking(a: [number, number], b: [number, number], d: number): Pose {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const f = clamp(d / len, 0, 1);
  const p = standing(lerp(a[0], b[0], f), lerp(a[1], b[1], f), facing(a[0], a[1], b[0], b[1]));
  const phase = (d / 1.3) * Math.PI * 2;
  const swing = Math.sin(phase) * 0.42;
  p.feet = null;
  p.legs = [
    [swing, Math.max(0, Math.sin(phase + Math.PI / 2)) * 0.7 + 0.08],
    [-swing, Math.max(0, Math.sin(phase - Math.PI / 2)) * 0.7 + 0.08],
  ];
  p.hipY = BODY.hip - 0.035 + Math.abs(Math.cos(phase)) * 0.03;
  p.arms = [
    { raise: -swing * 0.7, out: 0.1, elbow: 0.35 },
    { raise: swing * 0.7, out: 0.1, elbow: 0.35 },
  ];
  p.lean = 0.06;
  return p;
}

/** A ratchet in the hand: a short chrome bar along the forearm's reach. */
function ratchet(at: 0 | 1, color: THREE.Color): Hold {
  return { at, kind: 'box', size: [0.025, 0.02, 0.22], offset: [0, -0.09, 0.08], color };
}

/** Arms up working overhead, the right hand on a ratchet in bursts. */
function overhead(p: Pose, t: number, seed: number, wrench: THREE.Color): Pose {
  const burst = Math.sin(t * 0.8 + seed) > -0.2 ? Math.sin(t * 9) * 0.35 : 0;
  p.headPitch = -0.95 + drift(t, seed) * 0.08;
  p.lean = -0.08;
  p.arms = [
    { raise: 2.75, out: 0.15, elbow: 0.45 },
    { raise: 2.6 + burst * 0.2, out: 0.1, elbow: 0.5 + burst },
  ];
  p.feet = [0.12, -0.1];
  p.holds.push(ratchet(1, wrench));
  return p;
}

/** Crouched at a wheel, reaching in with a ratchet. */
function crouched(p: Pose, t: number, seed: number, wrench: THREE.Color): Pose {
  p.hipY = 0.5;
  p.feet = [0.28, -0.12];
  p.lean = 0.45;
  p.headPitch = 0.2;
  const burst = Math.sin(t * 0.6 + seed) > 0 ? Math.sin(t * 8) * 0.3 : 0;
  p.arms = [
    { raise: 0.9, out: 0.25, elbow: 0.5 },
    { raise: 1.05, out: 0.05, elbow: 0.7 + burst },
  ];
  p.holds.push(ratchet(1, wrench));
  return p;
}

/** The ground the lift's car sits at, time t (s) into the showroom: low, up over six seconds, held, down again. */
export function liftHeight(lift: CrewLift, t: number): number {
  const c = LIFT_CYCLE;
  const u = t % c.period;
  const k = u < c.downStart ? smoothstep(c.upStart, c.upEnd, u) : 1 - smoothstep(c.downStart, c.downEnd, u);
  return lerp(lift.low, lift.high, k);
}

export class Crew {
  readonly group = new THREE.Group();
  private readonly people: People;
  private readonly props: { box: THREE.InstancedMesh; cyl: THREE.InstancedMesh };
  private readonly scripts: ((t: number) => Pose)[];
  private readonly c = {
    wrench: new THREE.Color(0xb8bcc6),
    mug: new THREE.Color(0xe9e7e0),
    can: new THREE.Color(0xb3121e),
    box: new THREE.Color(0x7a5d3f),
  };
  // Scratch, reused every frame.
  private readonly root = new THREE.Matrix4();
  private readonly frame = new THREE.Matrix4();
  private readonly m4 = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    private readonly spots: CrewSpots,
    track: <T extends Disposable>(x: T) => T,
    shadowMap: THREE.Texture,
  ) {
    this.scripts = this.makeScripts();
    this.people = new People(this.scripts.length, track, shadowMap);
    LOOKS.forEach((look, i) => this.people.setLook(i, look));
    const mat = track(new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.3 }));
    const held = (geo: THREE.BufferGeometry) => {
      const mesh = new THREE.InstancedMesh(track(geo), mat, MAX_HOLDS);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      for (let i = 0; i < MAX_HOLDS; i++) {
        mesh.setMatrixAt(i, this.zero);
        mesh.setColorAt(i, this.c.wrench);
      }
      return mesh;
    };
    this.props = { box: held(new THREE.BoxGeometry(1, 1, 1)), cyl: held(new THREE.CylinderGeometry(0.5, 0.5, 1, 12)) };
    this.group.add(this.people.group, this.props.box, this.props.cyl);
  }

  /** Pose every worker for time t (s). */
  update(t: number): void {
    let n = 0;
    this.scripts.forEach((script, i) => {
      const p = script(t);
      if (p.feet) plantFeet(p, p.feet[0], p.feet[1]);
      this.root.makeRotationY(p.yaw).setPosition(p.x, 0, p.z);
      this.people.set(i, this.root, p);
      for (const h of p.holds) if (n < MAX_HOLDS) this.hold(n++, p, h);
    });
    for (let i = n; i < MAX_HOLDS; i++) {
      this.props.box.setMatrixAt(i, this.zero);
      this.props.cyl.setMatrixAt(i, this.zero);
    }
    this.people.commit();
    for (const mesh of [this.props.box, this.props.cyl]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Place held thing n from its hand (or the chest) in the pose just set. */
  private hold(n: number, p: Pose, h: Hold): void {
    const f = personFrame(this.root, p, h.at, this.frame).multiply(this.m4.makeTranslation(...h.offset));
    if (h.at !== 'spine') {
      // Held upright whatever the forearm's angle: the hand's position, the worker's heading.
      this.v.setFromMatrixPosition(f);
      this.q.setFromRotationMatrix(this.root);
      f.compose(this.v, this.q, this.one);
    }
    f.multiply(this.m4.makeScale(...h.size));
    const [use, skip] = h.kind === 'box' ? [this.props.box, this.props.cyl] : [this.props.cyl, this.props.box];
    use.setMatrixAt(n, f);
    use.setColorAt(n, h.color);
    skip.setMatrixAt(n, this.zero);
  }

  /** The scripted workers, in the order of LOOKS. */
  private makeScripts(): ((t: number) => Pose)[] {
    const s = this.spots;
    const c = this.c;
    const L = s.lift;
    const toWorld = (lx: number, lz: number): [number, number] => [L.x + lx * Math.cos(L.yaw) + lz * Math.sin(L.yaw), L.z - lx * Math.sin(L.yaw) + lz * Math.cos(L.yaw)];
    // The operator's three places: at the power unit's button, under the car, at the front wheel.
    const button = toWorld(L.px + 0.3, 0.75);
    const under = toWorld(0.35, 0);
    const wheel = toWorld(L.wheel[0] + 0.55, L.wheel[1]);
    const atButton = L.yaw + Math.PI;
    const atUnder = L.yaw + Math.PI / 2;
    const atWheel = L.yaw - Math.PI / 2;
    const cy = LIFT_CYCLE;
    /** A walk from a to b over [t0, t1], arriving facing `end` (turned over the last part of the way). */
    const leg = (a: [number, number], b: [number, number], u: number, t0: number, t1: number, end: number) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const p = walking(a, b, ((u - t0) / (t1 - t0)) * len);
      p.yaw = turn(p.yaw, end, smoothstep(t1 - 0.5, t1, u));
      return p;
    };
    return [
      // The bench: a ratchet in bursts, looking up at the board now and then.
      (t) => {
        const p = standing(s.bench.x, s.bench.z, s.bench.yaw);
        const look = Math.sin(t * 0.19) > 0.85;
        const burst = Math.sin(t * 0.7) > -0.3 && !look ? Math.sin(t * 7) * 0.35 : 0;
        p.lean = look ? 0.08 : 0.3;
        p.headPitch = look ? -0.35 : 0.55 + drift(t, 1) * 0.08;
        p.arms = [
          { raise: 0.8, out: -0.15, elbow: 1.0 },
          { raise: 0.75 + burst * 0.15, out: 0.05, elbow: 0.95 + burst },
        ];
        p.side = drift(t, 2) * 0.03;
        p.holds.push(ratchet(1, c.wrench));
        return p;
      },
      // Under the high car on the first lift.
      (t) => overhead(standing(s.overhead.x, s.overhead.z, s.overhead.yaw), t, 3, c.wrench),
      // The dyno: a hand on the pendant, watching the screen through a pull, the car between.
      (t) => {
        const p = standing(s.dyno.x, s.dyno.z, facing(s.dyno.x, s.dyno.z, s.dyno.car[0], s.dyno.car[1]));
        const pull = t % 9 < 6;
        const toScreen = wrapAngle(facing(s.dyno.x, s.dyno.z, s.dyno.screen[0], s.dyno.screen[1]) - p.yaw);
        p.headYaw = pull ? toScreen * 0.9 : drift(t, 5) * 0.3;
        p.twist = pull ? toScreen * 0.2 : 0;
        p.headPitch = -0.05;
        p.arms = [
          { raise: 0.1, out: 0.35, elbow: 1.7 },
          { raise: 0.55, out: -0.05, elbow: 1.1 },
        ];
        p.side = drift(t, 6) * 0.04;
        return p;
      },
      // The talkers: taking turns, one with a mug and one with a beer, a sip now and then.
      ...[0, 1].map((who) => (t: number) => {
        const me = s.talk[who];
        const you = s.talk[1 - who];
        const p = standing(me[0], me[1], facing(me[0], me[1], you[0], you[1]));
        const speaking = Math.floor((t + who * 1.7) / 3.6) % 2 === who;
        const sip = (t + who * 4) % 11 < 1.6;
        const cup = who === 0 ? 0 : 1;
        const free = 1 - cup;
        p.arms[cup] = sip ? { raise: 1.0, out: 0.1, elbow: 2.0 } : { raise: 0.3, out: 0.12, elbow: 1.35 };
        p.arms[free] = speaking ? { raise: 0.55 + Math.sin(t * 2.3 + who) * 0.25, out: 0.2 + Math.sin(t * 1.7) * 0.1, elbow: 1.3 + Math.sin(t * 3.1) * 0.25 } : { raise: 0.05, out: 0.12, elbow: 0.25 };
        p.headPitch = sip ? -0.25 : speaking ? Math.sin(t * 3) * 0.08 : 0.05 + Math.max(0, Math.sin(t * 1.3 + who)) * 0.1;
        p.headYaw = drift(t, 7 + who) * 0.15;
        p.side = drift(t * 0.6, 9 + who) * 0.05;
        p.feet = who ? [0.1, -0.08] : [-0.05, 0.12];
        p.holds.push(
          who === 0
            ? { at: cup, kind: 'cyl', size: [0.085, 0.1, 0.085], offset: [0, -0.1, 0.04], color: c.mug }
            : { at: cup, kind: 'cyl', size: [0.066, 0.12, 0.066], offset: [0, -0.1, 0.04], color: c.can },
        );
        return p;
      }),
      // The carrier: a box from the cabs to the bench and back, a pause and a turn at each end.
      (t) => {
        const [a, b] = s.carry;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const walk = len / 1.1;
        const rest = 2.6;
        const u = t % (2 * (walk + rest));
        const there = u < walk + rest;
        const v = there ? u : u - walk - rest;
        const [from, to] = there ? [a, b] : [b, a];
        let p: Pose;
        if (v < walk) p = walking(from, to, (v / walk) * len);
        else {
          p = standing(to[0], to[1], turn(facing(from[0], from[1], to[0], to[1]), facing(to[0], to[1], from[0], from[1]), smoothstep(walk + rest - 0.9, walk + rest, v)));
          p.headPitch = 0.3;
        }
        p.arms = [
          { raise: 0.65, out: -0.02, elbow: 0.95 },
          { raise: 0.65, out: -0.02, elbow: 0.95 },
        ];
        p.holds.push({ at: 'spine', kind: 'box', size: [0.44, 0.3, 0.34], offset: [0, 0.18, 0.36], color: c.box });
        return p;
      },
      // The lift operator on the lift's cycle.
      (t) => {
        const u = t % cy.period;
        if (u < 2.5) return leg(wheel, button, u, 0, 2.5, atButton);
        if (u < cy.upEnd || (u >= cy.downStart - 1.5 && u < cy.downEnd)) {
          // At the button, holding it while the lift moves, watching the car.
          const p = standing(button[0], button[1], atButton);
          const pressing = (u > 2.8 && u < cy.upEnd) || (u > cy.downStart - 0.3 && u < cy.downEnd);
          p.arms[1] = pressing ? { raise: 1.25, out: -0.05, elbow: 0.35 } : { raise: 0.2, out: 0.1, elbow: 0.3 };
          p.headPitch = pressing ? -0.45 : 0;
          p.headYaw = pressing ? 0.6 : 0;
          return p;
        }
        if (u < cy.upEnd + 2) return leg(button, under, u, cy.upEnd, cy.upEnd + 2, atUnder);
        if (u < cy.downStart - 3.5) return overhead(standing(under[0], under[1], atUnder), t, 11, c.wrench);
        if (u < cy.downStart - 1.5) return leg(under, button, u, cy.downStart - 3.5, cy.downStart - 1.5, atButton);
        if (u < cy.downEnd + 2.5) return leg(button, wheel, u, cy.downEnd, cy.downEnd + 2.5, atWheel);
        return crouched(standing(wheel[0], wheel[1], atWheel), t, 13, c.wrench);
      },
    ];
  }
}
