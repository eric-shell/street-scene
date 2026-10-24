/**
 * The finish celebration: confetti, spark fountains from the pillar caps and
 * the fireworks (rockets launched from the mortar tubes beside a gantry that
 * burst into colored spheres, rings and willows). Everything is pooled and
 * hidden while idle: one InstancedMesh for the confetti, one Points for the
 * sparks, one Points plus one LineSegments for the fireworks, and a few burst
 * flashes. It runs on the gantries' clock and allocates nothing per frame.
 * Render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { routeSample } from '../../city/route';
import { Disposer } from '../disposer';
import { LINE_Y, UP } from './finishLook';
import type { GateRuntime } from './finishGantry';
import type { FinishLines, FireworkShow } from './finishLine';

const CONFETTI = 720;
const SPARKS = 1100;
const ROCKETS = 32;
const STARS = 2600;
const FW = ROCKETS + STARS;
const FLASHES = 6;
const GRAVITY = 9.8;

/** Firework star colors (HDR, they bloom). */
const FW_COLORS = [
  [4, 0.45, 0.55],
  [0.6, 4, 1.1],
  [0.55, 1.3, 4.6],
  [4.2, 2.6, 0.7],
  [2.9, 0.75, 4.2],
  [0.7, 3.6, 4.2],
  [3.6, 3.4, 3.2],
  [4.2, 0.9, 2.6],
] as const;

const CONFETTI_COLORS = [0xffd23a, 0xff2d7a, 0x2de2ff, 0xffffff, 0xff4b2b, 0x9dff3a, 0xb06bff].map((c) => new THREE.Color(c).multiplyScalar(1.15));

/**
 * The celebration: confetti, spark fountains and fireworks (rockets and stars sharing one Points for the
 * heads and one LineSegments for the trails, plus a few burst flashes). Pooled and hidden while idle;
 * animated on the gantries' clock.
 */
export function createCelebration(world: World, group: THREE.Group, track: Disposer['track'], dot: THREE.Texture) {
  const route = world.route;
  const h = world.heightAt;

  // ---------- Confetti ----------
  const confGeo = track(new THREE.PlaneGeometry(0.16, 0.1));
  const confMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  const confMesh = track(new THREE.InstancedMesh(confGeo, confMat, CONFETTI));
  confMesh.frustumCulled = false;
  confMesh.visible = false;
  const conf = {
    pos: new Float32Array(CONFETTI * 3),
    vel: new Float32Array(CONFETTI * 3),
    rot: new Float32Array(CONFETTI * 3),
    spin: new Float32Array(CONFETTI * 3),
    life: new Float32Array(CONFETTI),
    ground: new Float32Array(CONFETTI),
    next: 0,
  };
  for (let i = 0; i < CONFETTI; i++) confMesh.setColorAt(i, CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
  group.add(confMesh);

  // ---------- Sparks ----------
  const sparkGeo = track(new THREE.BufferGeometry());
  const sparkPos = new Float32Array(SPARKS * 3);
  const sparkCol = new Float32Array(SPARKS * 3);
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3).setUsage(THREE.DynamicDrawUsage));
  const sparkMat = track(
    new THREE.PointsMaterial({ size: 0.32, map: dot, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }),
  );
  const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
  sparkPoints.frustumCulled = false;
  sparkPoints.visible = false;
  group.add(sparkPoints);
  const spark = { vel: new Float32Array(SPARKS * 3), life: new Float32Array(SPARKS), max: new Float32Array(SPARKS), warm: new Uint8Array(SPARKS), next: 0 };
  /** Active spark fountains: world position, direction, until time, rate, hue. */
  const fountains: { at: THREE.Vector3; dir: THREE.Vector3; until: number; rate: number; acc: number; warm: boolean }[] = [];

  // ---------- Fireworks: rockets + stars share one Points (heads) and one LineSegments (trails) ----------
  const fw = {
    pos: new Float32Array(FW * 3),
    vel: new Float32Array(FW * 3),
    col: new Float32Array(FW * 3),
    life: new Float32Array(FW),
    max: new Float32Array(FW),
    drag: new Float32Array(FW),
    grav: new Float32Array(FW),
    /** 0 dead, 1 rocket, 2 star, 3 glitter star (crackles). */
    kind: new Uint8Array(FW),
    /** Rockets: shell size, burst type and palette. */
    size: new Float32Array(ROCKETS),
    type: new Uint8Array(ROCKETS),
    pal: new Uint8Array(ROCKETS),
    nextStar: 0,
    /** Set when a shell burst this frame (its stars may sit behind the loop cursor). */
    spawned: false,
  };
  const headPos = new Float32Array(FW * 3);
  const headCol = new Float32Array(FW * 3);
  const trailPos = new Float32Array(FW * 6);
  const trailCol = new Float32Array(FW * 6);
  const headGeo = track(new THREE.BufferGeometry());
  headGeo.setAttribute('position', new THREE.BufferAttribute(headPos, 3).setUsage(THREE.DynamicDrawUsage));
  headGeo.setAttribute('color', new THREE.BufferAttribute(headCol, 3).setUsage(THREE.DynamicDrawUsage));
  const trailGeo = track(new THREE.BufferGeometry());
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3).setUsage(THREE.DynamicDrawUsage));
  const headMat = track(
    new THREE.PointsMaterial({ size: 0.95, map: dot, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }),
  );
  const trailMat = track(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  const fwHeads = new THREE.Points(headGeo, headMat);
  const fwTrails = new THREE.LineSegments(trailGeo, trailMat);
  for (const o of [fwHeads, fwTrails]) {
    o.frustumCulled = false;
    o.visible = false;
    group.add(o);
  }
  // Burst flashes: a few big additive sprites, hidden when idle.
  const flashes: { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; life: number; size: number }[] = [];
  for (let i = 0; i < FLASHES; i++) {
    const mat = track(new THREE.SpriteMaterial({ map: dot, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    sprite.frustumCulled = false;
    group.add(sprite);
    flashes.push({ sprite, mat, life: 0, size: 1 });
  }
  let nextFlash = 0;
  /** Scheduled launches (event driven; the per frame path never allocates). */
  const pending: { at: number; ox: number; oy: number; oz: number; tx: number; ty: number; tz: number; fuse: number; size: number; type: number; pal: number }[] = [];
  let onFirework: FinishLines['onFirework'] = null;

  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const dummy = new THREE.Object3D();
  let now = 0;

  function spawnSpark(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, warm: boolean): void {
    const i = spark.next;
    spark.next = (spark.next + 1) % SPARKS;
    sparkPos[i * 3] = x;
    sparkPos[i * 3 + 1] = y;
    sparkPos[i * 3 + 2] = z;
    spark.vel[i * 3] = vx;
    spark.vel[i * 3 + 1] = vy;
    spark.vel[i * 3 + 2] = vz;
    spark.max[i] = spark.life[i] = life;
    spark.warm[i] = warm ? 1 : 0;
    sparkPoints.visible = true;
  }

  function emitConfetti(rt: GateRuntime, strength: number): void {
    const g = rt.gate;
    const sy = Math.sin(g.yaw);
    const cy = Math.cos(g.yaw);
    const n = Math.round(CONFETTI * Math.min(1, strength));
    for (let k = 0; k < n; k++) {
      const i = conf.next;
      conf.next = (conf.next + 1) % CONFETTI;
      // Two cannons on the pillar caps plus a drop from the whole truss.
      const cannon = k % 3 !== 0;
      const side = k % 2 ? 1 : -1;
      const lx = cannon ? side * g.halfSpan : rand(-g.halfSpan, g.halfSpan);
      const ly = cannon ? (rt.full ? 11.8 : 8.8) : g.signHeight - 1.8;
      const lz = rand(-0.4, 0.4);
      const vlx = cannon ? -side * rand(2, 7) : rand(-1.5, 1.5);
      const vly = cannon ? rand(8, 15) : rand(-1, 3);
      const vlz = rand(-3.5, 3.5);
      // Local (x left, z forward) to world.
      conf.pos[i * 3] = g.position.x + lx * cy + lz * sy;
      conf.pos[i * 3 + 1] = g.position.y + ly;
      conf.pos[i * 3 + 2] = g.position.z - lx * sy + lz * cy;
      conf.vel[i * 3] = vlx * cy + vlz * sy;
      conf.vel[i * 3 + 1] = vly;
      conf.vel[i * 3 + 2] = -vlx * sy + vlz * cy;
      for (let a = 0; a < 3; a++) {
        conf.rot[i * 3 + a] = rand(0, 6.28);
        conf.spin[i * 3 + a] = rand(-9, 9);
      }
      conf.life[i] = rand(5.5, 8);
      conf.ground[i] = g.position.y + LINE_Y + 0.02;
    }
    confMesh.visible = true;
  }

  function emitSparks(dt: number): void {
    for (let f = fountains.length - 1; f >= 0; f--) {
      const fo = fountains[f];
      if (now > fo.until) {
        fountains.splice(f, 1);
        continue;
      }
      fo.acc += fo.rate * dt;
      while (fo.acc >= 1) {
        fo.acc -= 1;
        const sp = rand(7, 13);
        spawnSpark(fo.at.x, fo.at.y, fo.at.z, fo.dir.x * sp + rand(-2.2, 2.2), fo.dir.y * sp + rand(-1, 1.5), fo.dir.z * sp + rand(-2.2, 2.2), rand(0.7, 1.5), fo.warm);
      }
    }
  }

  // ---------- Fireworks ----------

  function fireworks(rt: GateRuntime, show: FireworkShow, strength = 1): void {
    if (!rt.tubes.length) return;
    const g = rt.gate;
    const cy = Math.cos(g.yaw);
    const sy = Math.sin(g.yaw);
    const n = Math.round((show === 'finish' ? 16 : show === 'start' ? 7 : 3) * Math.max(0.3, strength));
    for (let k = 0; k < n; k++) {
      const [lx, lz] = rt.tubes[(k * 5 + Math.floor(Math.random() * 2)) % rt.tubes.length];
      const ox = g.position.x + lx * cy + lz * sy;
      const oz = g.position.z - lx * sy + lz * cy;
      // Bursts land ahead of the line, where a driver looking down the road (or the finish shot) sees them.
      const ahead = show === 'finish' ? rand(-25, 95) : show === 'start' ? rand(35, 95) : rand(55, 100);
      const p = routeSample(route, g.s + ahead);
      const lat = rand(-26, 26);
      const tx = p.x + p.tz * lat;
      const tz = p.z - p.tx * lat;
      const big = show === 'finish' ? rand(0.85, 1.25) : show === 'start' ? rand(0.7, 0.95) : rand(0.5, 0.7);
      const height = show === 'lap' ? rand(18, 30) : show === 'start' ? rand(24, 40) : rand(26, 52);
      const delay = show === 'finish' ? (k < 4 ? k * 0.09 : 0.5 + (k - 4) * 0.28 + rand(0, 0.12)) : show === 'start' ? k * 0.2 + rand(0, 0.1) : k * 0.16;
      // Willows and double shells are saved for the bigger shows.
      const type = show === 'lap' ? Math.floor(rand(0, 2)) : Math.floor(rand(0, 5));
      pending.push({ at: now + delay, ox, oy: h(ox, oz) + 0.9, oz, tx, ty: h(tx, tz) + height, tz, fuse: rand(1.2, 1.55), size: big, type, pal: Math.floor(rand(0, FW_COLORS.length)) });
    }
  }

  function launch(L: (typeof pending)[number]): void {
    let i = -1;
    for (let r = 0; r < ROCKETS; r++) {
      if (fw.kind[r] === 0) {
        i = r;
        break;
      }
    }
    if (i < 0) return;
    const o = i * 3;
    fw.kind[i] = 1;
    fw.pos[o] = L.ox;
    fw.pos[o + 1] = L.oy;
    fw.pos[o + 2] = L.oz;
    // Ballistic: reach the burst point exactly when the fuse runs out.
    const T = L.fuse;
    fw.vel[o] = (L.tx - L.ox) / T;
    fw.vel[o + 1] = (L.ty - L.oy) / T + 0.5 * GRAVITY * T;
    fw.vel[o + 2] = (L.tz - L.oz) / T;
    fw.life[i] = fw.max[i] = T;
    fw.drag[i] = 0;
    fw.grav[i] = GRAVITY;
    fw.size[i] = L.size;
    fw.type[i] = L.type;
    fw.pal[i] = L.pal;
    fw.col[o] = 3.2;
    fw.col[o + 1] = 1.9;
    fw.col[o + 2] = 0.9;
    fwHeads.visible = fwTrails.visible = true;
    // Muzzle flash sparks.
    for (let k = 0; k < 14; k++) spawnSpark(L.ox, L.oy + 0.3, L.oz, rand(-2, 2), rand(3, 9), rand(-2, 2), rand(0.25, 0.6), true);
  }

  function addStar(x: number, y: number, z: number, vx: number, vy: number, vz: number, c: readonly number[], life: number, drag: number, grav: number, glitter: boolean): void {
    const i = ROCKETS + fw.nextStar;
    fw.nextStar = (fw.nextStar + 1) % STARS;
    const o = i * 3;
    fw.spawned = true;
    fw.kind[i] = glitter ? 3 : 2;
    fw.pos[o] = x;
    fw.pos[o + 1] = y;
    fw.pos[o + 2] = z;
    fw.vel[o] = vx;
    fw.vel[o + 1] = vy;
    fw.vel[o + 2] = vz;
    fw.col[o] = c[0];
    fw.col[o + 1] = c[1];
    fw.col[o + 2] = c[2];
    fw.life[i] = fw.max[i] = life;
    fw.drag[i] = drag;
    fw.grav[i] = grav;
  }

  /** A shell bursts: peony (0), ring (1), double (2), willow (3) or glitter crackle (4). */
  function explode(r: number): void {
    const o = r * 3;
    const x = fw.pos[o];
    const y = fw.pos[o + 1];
    const z = fw.pos[o + 2];
    const size = fw.size[r];
    const type = fw.type[r];
    const c1 = FW_COLORS[fw.pal[r]];
    const c2 = FW_COLORS[(fw.pal[r] + 3) % FW_COLORS.length];
    const gold = FW_COLORS[3];
    const n = Math.round((type === 1 ? 90 : 150) * size);
    const speed = 15 * size;
    // Ring plane: a random tilt.
    const ax = rand(-1, 1);
    const az = rand(-1, 1);
    const al = Math.hypot(ax, 1, az);
    const nx = ax / al;
    const ny = 1 / al;
    const nz = az / al;
    // Two axes in the plane.
    let ux = ny;
    let uy = -nx;
    let uz = 0;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const wx = ny * uz - nz * uy;
    const wy = nz * ux - nx * uz;
    const wz = nx * uy - ny * ux;
    for (let k = 0; k < n; k++) {
      let dx: number, dy: number, dz: number;
      if (type === 1) {
        const a = (k / n) * Math.PI * 2;
        dx = Math.cos(a) * ux + Math.sin(a) * wx;
        dy = Math.cos(a) * uy + Math.sin(a) * wy;
        dz = Math.cos(a) * uz + Math.sin(a) * wz;
      } else {
        // Uniform on the sphere (Fibonacci spiral with jitter keeps the shell round).
        const t = (k + 0.5) / n;
        const inc = Math.acos(1 - 2 * t);
        const az2 = k * 2.39996 + rand(-0.05, 0.05);
        dx = Math.sin(inc) * Math.cos(az2);
        dy = Math.cos(inc);
        dz = Math.sin(inc) * Math.sin(az2);
      }
      const inner = type === 2 && k % 2 === 1;
      const sp = speed * (inner ? 0.55 : 1) * rand(0.92, 1.06);
      if (type === 3) addStar(x, y, z, dx * sp * 0.8, dy * sp * 0.8 + 1, dz * sp * 0.8, gold, rand(2.6, 3.4), 1.9, 2.2, true);
      else addStar(x, y, z, dx * sp, dy * sp, dz * sp, inner ? c2 : c1, rand(1.5, 2.2), 1.45, 3.2, type === 4);
    }
    const f = flashes[nextFlash];
    nextFlash = (nextFlash + 1) % FLASHES;
    f.life = 0.35;
    f.size = 16 * size;
    f.sprite.position.set(x, y, z);
    f.sprite.visible = true;
    f.mat.color.setRGB(c1[0] * 0.45, c1[1] * 0.45, c1[2] * 0.45);
    onFirework?.(x, y, z, size);
  }

  function updateFireworks(dt: number): void {
    for (let k = pending.length - 1; k >= 0; k--) {
      if (now >= pending[k].at) {
        launch(pending[k]);
        pending.splice(k, 1);
      }
    }
    for (const f of flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const k = Math.max(0, f.life / 0.35);
      f.sprite.scale.setScalar(f.size * (1.2 - 0.4 * k));
      f.mat.opacity = k * k;
      if (f.life <= 0) f.sprite.visible = false;
    }
    if (!fwHeads.visible) return;
    let alive = 0;
    fw.spawned = false;
    for (let i = 0; i < FW; i++) {
      const o = i * 3;
      const o2 = i * 6;
      const kind = fw.kind[i];
      if (kind === 0) continue;
      fw.life[i] -= dt;
      if (fw.life[i] <= 0) {
        if (kind === 1) explode(i);
        fw.kind[i] = 0;
        headCol[o] = headCol[o + 1] = headCol[o + 2] = 0;
        for (let a = 0; a < 6; a++) trailCol[o2 + a] = 0;
        continue;
      }
      alive++;
      const drag = fw.drag[i] > 0 ? Math.exp(-dt * fw.drag[i]) : 1;
      fw.vel[o] *= drag;
      fw.vel[o + 1] = fw.vel[o + 1] * drag - fw.grav[i] * dt;
      fw.vel[o + 2] *= drag;
      const x = (fw.pos[o] += fw.vel[o] * dt);
      const y = (fw.pos[o + 1] += fw.vel[o + 1] * dt);
      const z = (fw.pos[o + 2] += fw.vel[o + 2] * dt);
      let b: number;
      let tail: number;
      if (kind === 1) {
        // Rocket: steady hot head, long streak, a stream of embers.
        b = 1;
        tail = 0.11;
        if (Math.random() < dt * 70) spawnSpark(x, y, z, -fw.vel[o] * 0.1 + rand(-0.8, 0.8), -fw.vel[o + 1] * 0.1 + rand(-0.8, 0.4), -fw.vel[o + 2] * 0.1 + rand(-0.8, 0.8), rand(0.3, 0.7), true);
      } else {
        const k = fw.life[i] / fw.max[i];
        const age = fw.max[i] - fw.life[i];
        // Pop on the burst, then a slow fade; the last 20% fades out fully.
        b = (age < 0.08 ? 1.8 : 1) * (0.4 + 0.6 * k) * Math.min(1, k / 0.2);
        if (kind === 3) b *= Math.random() < 0.45 ? 1.7 : 0.15;
        tail = 0.075;
      }
      headPos[o] = x;
      headPos[o + 1] = y;
      headPos[o + 2] = z;
      const r = fw.col[o] * b;
      const g = fw.col[o + 1] * b;
      const bl = fw.col[o + 2] * b;
      headCol[o] = r;
      headCol[o + 1] = g;
      headCol[o + 2] = bl;
      // Trail: from the head (lit) back along the velocity to black.
      trailPos[o2] = x;
      trailPos[o2 + 1] = y;
      trailPos[o2 + 2] = z;
      trailPos[o2 + 3] = x - fw.vel[o] * tail;
      trailPos[o2 + 4] = y - fw.vel[o + 1] * tail;
      trailPos[o2 + 5] = z - fw.vel[o + 2] * tail;
      trailCol[o2] = r * 0.7;
      trailCol[o2 + 1] = g * 0.7;
      trailCol[o2 + 2] = bl * 0.7;
      trailCol[o2 + 3] = trailCol[o2 + 4] = trailCol[o2 + 5] = 0;
    }
    headGeo.attributes.position.needsUpdate = true;
    headGeo.attributes.color.needsUpdate = true;
    trailGeo.attributes.position.needsUpdate = true;
    trailGeo.attributes.color.needsUpdate = true;
    if (!alive && !fw.spawned) fwHeads.visible = fwTrails.visible = false;
  }

  function updateParticles(dt: number): void {
    if (confMesh.visible) {
      let alive = 0;
      for (let i = 0; i < CONFETTI; i++) {
        if (conf.life[i] <= 0) {
          dummy.position.set(0, -1e4, 0);
          dummy.scale.setScalar(0);
          dummy.updateMatrix();
          confMesh.setMatrixAt(i, dummy.matrix);
          continue;
        }
        alive++;
        conf.life[i] -= dt;
        const o = i * 3;
        const onGround = conf.pos[o + 1] <= conf.ground[i];
        if (!onGround) {
          // Paper flutter: heavy drag, a sideways wobble and a low terminal speed.
          const drag = Math.exp(-dt * 1.9);
          conf.vel[o] = conf.vel[o] * drag + Math.sin(now * 6 + i) * 3 * dt;
          conf.vel[o + 1] = conf.vel[o + 1] * drag - 9.8 * dt;
          conf.vel[o + 2] = conf.vel[o + 2] * drag + Math.cos(now * 5 + i * 1.7) * 3 * dt;
          conf.pos[o] += conf.vel[o] * dt;
          conf.pos[o + 1] = Math.max(conf.ground[i], conf.pos[o + 1] + conf.vel[o + 1] * dt);
          conf.pos[o + 2] += conf.vel[o + 2] * dt;
          for (let a = 0; a < 3; a++) conf.rot[o + a] += conf.spin[o + a] * dt;
        } else {
          // Lie flat on the road.
          conf.rot[o] = -Math.PI / 2;
          conf.rot[o + 1] = 0;
        }
        dummy.position.set(conf.pos[o], conf.pos[o + 1], conf.pos[o + 2]);
        dummy.rotation.set(conf.rot[o], conf.rot[o + 1], conf.rot[o + 2]);
        dummy.scale.setScalar(Math.min(1, conf.life[i]));
        dummy.updateMatrix();
        confMesh.setMatrixAt(i, dummy.matrix);
      }
      confMesh.instanceMatrix.needsUpdate = true;
      if (!alive) confMesh.visible = false;
    }
    if (sparkPoints.visible) {
      emitSparks(dt);
      let alive = fountains.length;
      for (let i = 0; i < SPARKS; i++) {
        const o = i * 3;
        if (spark.life[i] <= 0) {
          sparkCol[o] = sparkCol[o + 1] = sparkCol[o + 2] = 0;
          continue;
        }
        alive++;
        spark.life[i] -= dt;
        const drag = Math.exp(-dt * 0.8);
        spark.vel[o] *= drag;
        spark.vel[o + 1] = spark.vel[o + 1] * drag - 9.8 * dt;
        spark.vel[o + 2] *= drag;
        sparkPos[o] += spark.vel[o] * dt;
        sparkPos[o + 1] += spark.vel[o + 1] * dt;
        sparkPos[o + 2] += spark.vel[o + 2] * dt;
        // Hot white cooling to dim orange (or green for the start); additive, so dark = gone.
        const k = Math.max(0, spark.life[i] / spark.max[i]);
        const heat = (0.4 + 3.6 * k * k) * Math.min(1, k * 4);
        if (spark.warm[i]) {
          sparkCol[o] = heat;
          sparkCol[o + 1] = heat * (0.3 + 0.6 * k);
          sparkCol[o + 2] = heat * k * k;
        } else {
          sparkCol[o] = heat * (0.2 + 0.7 * k * k);
          sparkCol[o + 1] = heat;
          sparkCol[o + 2] = heat * (0.45 + 0.4 * k);
        }
      }
      sparkGeo.attributes.position.needsUpdate = true;
      sparkGeo.attributes.color.needsUpdate = true;
      if (!alive) sparkPoints.visible = false;
    }
  }

  /** A gate's burst: spark fountains from both pillar caps, and confetti at the finish. */
  function burst(rt: GateRuntime, kind: 'finish' | 'start', strength: number): void {
    const g = rt.gate;
    const top = rt.full ? 11.9 : 8.9;
    for (const side of [-1, 1]) {
      const at = new THREE.Vector3(side * g.halfSpan, top, 0).applyAxisAngle(UP, g.yaw).add(g.position);
      const inward = new THREE.Vector3(-side * 0.35, 1, 0).applyAxisAngle(UP, g.yaw).normalize();
      fountains.push({ at, dir: inward, until: now + (kind === 'finish' ? 1.8 : 0.8), rate: (kind === 'finish' ? 260 : 160) * strength, acc: 0, warm: kind === 'finish' });
    }
    sparkPoints.visible = true;
    if (kind === 'finish') emitConfetti(rt, strength);
  }

  return {
    burst,
    fireworks,
    update(time: number, dt: number): void {
      now = time;
      updateParticles(dt);
      updateFireworks(dt);
    },
    get onFirework() {
      return onFirework;
    },
    set onFirework(f: FinishLines['onFirework']) {
      onFirework = f;
    },
  };
}
