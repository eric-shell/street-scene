/**
 * Pooled debris for broken street furniture: small rigid bodies (boxes,
 * cylinders, glass shards, glowing bits) with ballistic motion, a single
 * point ground contact with restitution and friction (so long pieces topple
 * and settle), and short-lived sparks. Everything lives in preallocated typed
 * arrays and draws as one InstancedMesh per piece type. Visual only: never
 * reads or writes sim state, and is free to use Math.random.
 */
import * as THREE from 'three';

export type DebrisType = 0 | 1 | 2 | 3;
/** Opaque box (unit cube scaled to the half extents). */
export const D_BOX: DebrisType = 0;
/** Opaque cylinder along local Y (radius hx, half height hy). */
export const D_CYL: DebrisType = 1;
/** Translucent glass shard. */
export const D_GLASS: DebrisType = 2;
/** Emissive piece (lens, ad panel) that cools down over its first second. */
export const D_GLOW: DebrisType = 3;
const TYPES = 4;

const GRAVITY = 9.81;
const FADE = 0.8;

export interface DebrisBody {
  type: DebrisType;
  x: number;
  y: number;
  z: number;
  /** Orientation (yaw about Y, then optional pitch about the local X axis). */
  yaw: number;
  pitch?: number;
  hx: number;
  hy: number;
  hz: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
  color: THREE.Color;
  life: number;
  /** Emits sparks on hard ground contact (metal). */
  sparky?: boolean;
  bounce?: number;
}

export class Debris {
  readonly group = new THREE.Group();
  private readonly n: number;
  private readonly sparkN: number;
  // Rigid bodies (structure of arrays).
  private alive: Uint8Array;
  private type: Uint8Array;
  private sleep: Uint8Array;
  private sparky: Uint8Array;
  private still: Uint8Array;
  private p: Float32Array;
  private v: Float32Array;
  private q: Float32Array;
  private w: Float32Array;
  private h: Float32Array;
  private col: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private invI: Float32Array;
  private bounce: Float32Array;
  // Sparks.
  private sAlive: Uint8Array;
  private sp: Float32Array;
  private sv: Float32Array;
  private sAge: Float32Array;
  private sLife: Float32Array;
  private meshes: THREE.InstancedMesh[] = [];
  private sparks: THREE.InstancedMesh;
  private disposables: { dispose(): void }[] = [];
  private counts = new Int32Array(TYPES);
  private active = 0;
  private sActive = 0;
  // Scratch (no per-frame allocation).
  private m = new THREE.Matrix4();
  private tq = new THREE.Quaternion();
  private tp = new THREE.Vector3();
  private ts = new THREE.Vector3();
  private tc = new THREE.Color();
  private zAxis = new THREE.Vector3(0, 0, 1);
  private dir = new THREE.Vector3();

  constructor(
    private readonly heightAt: (x: number, z: number) => number,
    maxBodies = 180,
    maxSparks = 260,
  ) {
    this.group.name = 'debris';
    const n = (this.n = maxBodies);
    const sn = (this.sparkN = maxSparks);
    this.alive = new Uint8Array(n);
    this.type = new Uint8Array(n);
    this.sleep = new Uint8Array(n);
    this.sparky = new Uint8Array(n);
    this.still = new Uint8Array(n);
    this.p = new Float32Array(n * 3);
    this.v = new Float32Array(n * 3);
    this.q = new Float32Array(n * 4);
    this.w = new Float32Array(n * 3);
    this.h = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.invI = new Float32Array(n);
    this.bounce = new Float32Array(n);
    this.sAlive = new Uint8Array(sn);
    this.sp = new Float32Array(sn * 3);
    this.sv = new Float32Array(sn * 3);
    this.sAge = new Float32Array(sn);
    this.sLife = new Float32Array(sn);

    const box = new THREE.BoxGeometry(1, 1, 1);
    const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
    const solid = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.45 });
    const glass = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.6, depthWrite: false, envMapIntensity: 2 });
    const glow = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const spark = new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    this.disposables.push(box, cyl, solid, glass, glow, spark);
    const geos = [box, cyl, box, box];
    const mats = [solid, solid, glass, glow];
    for (let t = 0; t < TYPES; t++) {
      const mesh = new THREE.InstancedMesh(geos[t], mats[t], n);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, this.tc.setRGB(1, 1, 1));
      mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.name = `debris${t}`;
      if (t === D_GLASS) mesh.renderOrder = 4;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    this.sparks = new THREE.InstancedMesh(box, spark, sn);
    this.sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparks.setColorAt(0, this.tc.setRGB(1, 1, 1));
    this.sparks.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.sparks.count = 0;
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 6;
    this.sparks.name = 'sparks';
    this.group.add(this.sparks);
  }

  /** Free slot, or the body closest to expiring when the pool is full. */
  private slot(): number {
    let best = 0;
    let bestLeft = Infinity;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) return i;
      const left = this.life[i] - this.age[i];
      if (left < bestLeft) {
        bestLeft = left;
        best = i;
      }
    }
    return best;
  }

  spawn(b: DebrisBody): void {
    const i = this.slot();
    if (!this.alive[i]) this.active++;
    this.alive[i] = 1;
    this.type[i] = b.type;
    this.sleep[i] = 0;
    this.still[i] = 0;
    this.sparky[i] = b.sparky ? 1 : 0;
    const i3 = i * 3;
    this.p[i3] = b.x;
    this.p[i3 + 1] = b.y;
    this.p[i3 + 2] = b.z;
    this.v[i3] = b.vx;
    this.v[i3 + 1] = b.vy;
    this.v[i3 + 2] = b.vz;
    this.w[i3] = b.wx;
    this.w[i3 + 1] = b.wy;
    this.w[i3 + 2] = b.wz;
    this.h[i3] = b.hx;
    this.h[i3 + 1] = b.hy;
    this.h[i3 + 2] = b.hz;
    this.col[i3] = b.color.r;
    this.col[i3 + 1] = b.color.g;
    this.col[i3 + 2] = b.color.b;
    // yaw about Y then pitch about local X
    const cy = Math.cos(b.yaw / 2);
    const sy = Math.sin(b.yaw / 2);
    const pa = b.pitch ?? 0;
    const cp = Math.cos(pa / 2);
    const spp = Math.sin(pa / 2);
    const i4 = i * 4;
    this.q[i4] = cy * spp;
    this.q[i4 + 1] = sy * cp;
    this.q[i4 + 2] = -sy * spp;
    this.q[i4 + 3] = cy * cp;
    // Scalar inverse inertia of a uniform box with unit mass.
    this.invI[i] = 3 / Math.max(0.002, b.hx * b.hx + b.hy * b.hy + b.hz * b.hz);
    this.bounce[i] = b.bounce ?? 0.25;
    this.age[i] = 0;
    this.life[i] = b.life;
  }

  spark(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number): void {
    let i = -1;
    for (let k = 0; k < this.sparkN; k++) {
      if (!this.sAlive[k]) {
        i = k;
        break;
      }
    }
    if (i < 0) return; // sparks are cheap to lose
    this.sAlive[i] = 1;
    this.sActive++;
    const i3 = i * 3;
    this.sp[i3] = x;
    this.sp[i3 + 1] = y;
    this.sp[i3 + 2] = z;
    this.sv[i3] = vx;
    this.sv[i3 + 1] = vy;
    this.sv[i3 + 2] = vz;
    this.sAge[i] = 0;
    this.sLife[i] = life;
  }

  /** A spray of sparks around (x, y, z), biased along (dx, dz). */
  burst(x: number, y: number, z: number, dx: number, dz: number, speed: number, count: number): void {
    for (let k = 0; k < count; k++) {
      const s = speed * (0.3 + Math.random() * 0.9);
      this.spark(
        x,
        y,
        z,
        dx * s + (Math.random() - 0.5) * 9,
        1.5 + Math.random() * 6,
        dz * s + (Math.random() - 0.5) * 9,
        0.35 + Math.random() * 0.6,
      );
    }
  }

  clear(): void {
    this.alive.fill(0);
    this.sAlive.fill(0);
    this.active = 0;
    this.sActive = 0;
    for (const m of this.meshes) m.count = 0;
    this.sparks.count = 0;
  }

  update(dtIn: number): void {
    if (this.active === 0 && this.sActive === 0) return;
    const dt = Math.min(dtIn, 1 / 30);
    if (dt <= 0) return;
    const { p, q, h, counts } = this;
    counts.fill(0);
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.alive[i] = 0;
        this.active--;
        continue;
      }
      const i3 = i * 3;
      const i4 = i * 4;
      if (!this.sleep[i]) this.integrate(i, i3, i4, dt);
      // Draw: unit geometry scaled to the full extents, shrinking away at the end of its life.
      const left = this.life[i] - this.age[i];
      const f = left < FADE ? left / FADE : 1;
      const t = this.type[i];
      const mesh = this.meshes[t];
      const k = counts[t]++;
      this.tq.set(q[i4], q[i4 + 1], q[i4 + 2], q[i4 + 3]);
      this.tp.set(p[i3], p[i3 + 1] - (1 - f) * h[i3 + 1], p[i3 + 2]);
      this.ts.set(h[i3] * 2 * f, h[i3 + 1] * 2 * f, h[i3 + 2] * 2 * f);
      this.m.compose(this.tp, this.tq, this.ts);
      mesh.setMatrixAt(k, this.m);
      let c = 1;
      if (t === D_GLOW) c = Math.max(0.06, 1 - this.age[i] * 0.9) * (0.75 + Math.random() * 0.5 * (this.age[i] < 0.8 ? 1 : 0));
      this.tc.setRGB(this.col[i3] * c, this.col[i3 + 1] * c, this.col[i3 + 2] * c);
      mesh.setColorAt(k, this.tc);
    }
    for (let t = 0; t < TYPES; t++) {
      const mesh = this.meshes[t];
      if (counts[t] === 0 && mesh.count === 0) continue;
      mesh.count = counts[t];
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
    }
    this.updateSparks(dt);
  }

  private integrate(i: number, i3: number, i4: number, dt: number): void {
    const { p, v, q, w, h } = this;
    v[i3 + 1] -= GRAVITY * dt;
    p[i3] += v[i3] * dt;
    p[i3 + 1] += v[i3 + 1] * dt;
    p[i3 + 2] += v[i3 + 2] * dt;
    // q += 0.5 * (0, w) * q * dt
    let qx = q[i4];
    let qy = q[i4 + 1];
    let qz = q[i4 + 2];
    let qw = q[i4 + 3];
    const wx = w[i3];
    const wy = w[i3 + 1];
    const wz = w[i3 + 2];
    const hd = 0.5 * dt;
    qx += hd * (wx * qw + wy * qz - wz * qy);
    qy += hd * (wy * qw + wz * qx - wx * qz);
    qz += hd * (wz * qw + wx * qy - wy * qx);
    qw += hd * (-wx * qx - wy * qy - wz * qz);
    const ql = 1 / Math.hypot(qx, qy, qz, qw);
    qx *= ql;
    qy *= ql;
    qz *= ql;
    qw *= ql;
    q[i4] = qx;
    q[i4 + 1] = qy;
    q[i4 + 2] = qz;
    q[i4 + 3] = qw;
    // Local axes in world space (rotation matrix columns).
    const ax = 1 - 2 * (qy * qy + qz * qz), ay = 2 * (qx * qy + qw * qz), az = 2 * (qx * qz - qw * qy);
    const bx = 2 * (qx * qy - qw * qz), by = 1 - 2 * (qx * qx + qz * qz), bz = 2 * (qy * qz + qw * qx);
    const cx = 2 * (qx * qz + qw * qy), cy = 2 * (qy * qz - qw * qx), cz = 1 - 2 * (qx * qx + qy * qy);
    // Lowest corner of the box relative to its center.
    const sa = ay > 0 ? -h[i3] : h[i3];
    const sb = by > 0 ? -h[i3 + 1] : h[i3 + 1];
    const sc = cy > 0 ? -h[i3 + 2] : h[i3 + 2];
    const rx = ax * sa + bx * sb + cx * sc;
    const ry = ay * sa + by * sb + cy * sc;
    const rz = az * sa + bz * sb + cz * sc;
    const ground = this.heightAt(p[i3], p[i3 + 2]) + 0.03;
    const pen = ground - (p[i3 + 1] + ry);
    if (pen <= 0) {
      this.still[i] = 0;
      return;
    }
    p[i3 + 1] += pen;
    const invI = this.invI[i];
    // Contact point velocity v + w x r.
    const vpx = v[i3] + (wy * rz - wz * ry);
    const vpy = v[i3 + 1] + (wz * rx - wx * rz);
    const vpz = v[i3 + 2] + (wx * ry - wy * rx);
    if (vpy < 0) {
      if (this.sparky[i] && vpy < -3.5) this.burst(p[i3] + rx, ground, p[i3 + 2] + rz, 0, 0, 0, Math.min(8, (-vpy * 1.2) | 0));
      const kn = 1 + invI * (rx * rx + rz * rz);
      const j = (-(1 + this.bounce[i]) * vpy) / kn;
      v[i3 + 1] += j;
      // w += invI * (r x (0, j, 0))
      w[i3] += invI * -rz * j;
      w[i3 + 2] += invI * rx * j;
      // Coulomb friction on the sliding contact.
      const vt = Math.hypot(vpx, vpz);
      if (vt > 1e-4) {
        const kt = 1 + invI * (rx * rx + ry * ry + rz * rz) * 0.66;
        const jt = Math.min(0.55 * j, vt / kt);
        const jx = (-vpx / vt) * jt;
        const jz = (-vpz / vt) * jt;
        v[i3] += jx;
        v[i3 + 2] += jz;
        // w += invI * (r x (jx, 0, jz))
        w[i3] += invI * ry * jz;
        w[i3 + 1] += invI * (rz * jx - rx * jz);
        w[i3 + 2] += invI * -ry * jx;
      }
    }
    // Rolling resistance while touching the ground, then sleep once settled.
    const damp = Math.max(0, 1 - 2.5 * dt);
    w[i3] *= damp;
    w[i3 + 1] *= damp;
    w[i3 + 2] *= damp;
    const vd = Math.max(0, 1 - 1.2 * dt);
    v[i3] *= vd;
    v[i3 + 2] *= vd;
    const e = v[i3] * v[i3] + v[i3 + 1] * v[i3 + 1] + v[i3 + 2] * v[i3 + 2] + w[i3] * w[i3] + w[i3 + 1] * w[i3 + 1] + w[i3 + 2] * w[i3 + 2];
    if (e < 0.05 && this.age[i] > 0.4) {
      if (++this.still[i] > 12) this.sleep[i] = 1;
    } else this.still[i] = 0;
  }

  private updateSparks(dt: number): void {
    if (this.sActive === 0 && this.sparks.count === 0) return;
    const { sp, sv } = this;
    let k = 0;
    for (let i = 0; i < this.sparkN; i++) {
      if (!this.sAlive[i]) continue;
      this.sAge[i] += dt;
      const left = this.sLife[i] - this.sAge[i];
      if (left <= 0) {
        this.sAlive[i] = 0;
        this.sActive--;
        continue;
      }
      const i3 = i * 3;
      sv[i3 + 1] -= GRAVITY * dt;
      sp[i3] += sv[i3] * dt;
      sp[i3 + 1] += sv[i3 + 1] * dt;
      sp[i3 + 2] += sv[i3 + 2] * dt;
      const g = this.heightAt(sp[i3], sp[i3 + 2]) + 0.03;
      if (sp[i3 + 1] < g) {
        sp[i3 + 1] = g;
        sv[i3 + 1] = Math.abs(sv[i3 + 1]) * 0.35;
        sv[i3] *= 0.6;
        sv[i3 + 2] *= 0.6;
      }
      const speed = Math.hypot(sv[i3], sv[i3 + 1], sv[i3 + 2]);
      if (speed > 1e-3) this.dir.set(sv[i3] / speed, sv[i3 + 1] / speed, sv[i3 + 2] / speed);
      else this.dir.set(0, 1, 0);
      this.tq.setFromUnitVectors(this.zAxis, this.dir);
      this.tp.set(sp[i3], sp[i3 + 1], sp[i3 + 2]);
      this.ts.set(0.035, 0.035, Math.min(0.55, 0.04 + speed * 0.025));
      this.m.compose(this.tp, this.tq, this.ts);
      this.sparks.setMatrixAt(k, this.m);
      // White hot to orange to dull red.
      const f = left / this.sLife[i];
      this.tc.setRGB(3 * Math.min(1, f * 1.6 + 0.2), 2.2 * f * f + 0.25 * f, 0.9 * f * f * f);
      this.sparks.setColorAt(k, this.tc);
      k++;
    }
    this.sparks.count = k;
    this.sparks.instanceMatrix.needsUpdate = true;
    this.sparks.instanceColor!.needsUpdate = true;
  }

  dispose(): void {
    for (const m of this.meshes) m.dispose();
    this.sparks.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
