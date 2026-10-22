/**
 * Nitrous light trails: two glowing ribbons that stream from the taillights
 * while boosting and shrink away when the boost ends; each nitrous stage
 * burns them brighter and a little wider. Camera facing, tapered, additive so
 * they bloom. Render only.
 */
import * as THREE from 'three';

const N = 56;
/**
 * Trail strength per nitrous stage (1..3): brightness, and width past 1. Kept
 * small: the trails are long and HDR, so a little more of them blooms over the
 * whole frame.
 */
const STAGE_STRENGTH = [1, 1.1, 1.2] as const;
/** How fast a trail retracts once the boost ends (history points per second; two a frame at 60 fps). */
const RETRACT_RATE = 120;

/** Scratch for update and writeGeometry. */
const TAIL = new THREE.Vector3();
const CAM = new THREE.Vector3();
const TAN = new THREE.Vector3();
const VIEW = new THREE.Vector3();
const SIDE = new THREE.Vector3();

export class LightTrails {
  readonly mesh: THREE.Mesh;
  private history: THREE.Vector3[][] = [[], []];
  private positions: Float32Array;
  private colors: Float32Array;
  private geo: THREE.BufferGeometry;
  private strength = 0;
  private local: THREE.Vector3[];
  /** History points dropped off the trails, reused for new ones. */
  private spare: THREE.Vector3[] = [];
  /** Retraction owed but not yet a whole point (points). */
  private retractCarry = 0;
  /** The buffers hold nothing to draw (skip rewriting them while the trails stay empty). */
  private cleared = false;
  /** The taillight red (carMaterials' TailLight emissive). */
  private readonly color = new THREE.Color(0xff1a2a);

  constructor(width: number, length: number) {
    this.local = [new THREE.Vector3(width * 0.32, 0.55, -length / 2 - 0.05), new THREE.Vector3(-width * 0.32, 0.55, -length / 2 - 0.05)];
    this.geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(2 * N * 2 * 3);
    this.colors = new Float32Array(2 * N * 2 * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < N - 1; i++) {
        const a = (t * N + i) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  /** `stage` is the nitrous stage burning (1..3), 0 when off. */
  update(carRoot: THREE.Object3D, camera: THREE.Camera, stage: number, dt: number): void {
    const active = stage > 0;
    const target = active ? STAGE_STRENGTH[Math.min(3, stage) - 1] : 0;
    this.strength += (target - this.strength) * (1 - Math.exp(-dt * (active ? 8 : 3)));
    carRoot.updateMatrixWorld();
    // Retract when the boost ends, at a rate in time so every frame rate looks the same.
    let retract = 0;
    if (active) this.retractCarry = 0;
    else {
      this.retractCarry += dt * RETRACT_RATE;
      retract = Math.floor(this.retractCarry + 1e-9);
      this.retractCarry -= retract;
    }
    for (let t = 0; t < 2; t++) {
      const h = this.history[t];
      const p = TAIL.copy(this.local[t]).applyMatrix4(carRoot.matrixWorld);
      if (active || this.strength > 0.02) {
        if (!h.length || h[0].distanceToSquared(p) > 0.04) h.unshift((this.spare.pop() ?? new THREE.Vector3()).copy(p));
        else h[0].copy(p);
        if (h.length > N) this.truncate(h, N);
        if (!active && h.length > 2) this.truncate(h, Math.max(2, h.length - retract));
      } else this.truncate(h, 0);
    }
    const empty = !this.history[0].length && !this.history[1].length;
    if (!empty || !this.cleared) this.writeGeometry(camera);
    this.cleared = empty;
    this.mesh.visible = this.strength > 0.02;
  }

  /** Cut a trail's history to `n` points, keeping the dropped ones for reuse. */
  private truncate(h: THREE.Vector3[], n: number): void {
    while (h.length > n) this.spare.push(h.pop()!);
  }

  private writeGeometry(camera: THREE.Camera): void {
    const cam = camera.getWorldPosition(CAM);
    const tan = TAN;
    const view = VIEW;
    const side = SIDE;
    const widen = 1 + 0.8 * Math.max(0, this.strength - 1);
    for (let t = 0; t < 2; t++) {
      const h = this.history[t];
      for (let i = 0; i < N; i++) {
        const o = (t * N + i) * 2 * 3;
        const p = h[Math.min(i, h.length - 1)];
        if (!p) {
          this.positions.fill(0, o, o + 6);
          this.colors.fill(0, o, o + 6);
          continue;
        }
        const last = h.length - 1;
        const a = h[Math.min(last, Math.max(0, i - 1))];
        const b = h[Math.min(last, i + 1)];
        tan.subVectors(a, b);
        if (tan.lengthSq() < 1e-8) tan.set(0, 0, 1);
        view.subVectors(cam, p);
        side.crossVectors(tan, view).normalize();
        const k = 1 - i / (N - 1);
        const w = 0.055 * (0.3 + 0.7 * k) * widen;
        side.multiplyScalar(w);
        this.positions[o] = p.x + side.x;
        this.positions[o + 1] = p.y + side.y;
        this.positions[o + 2] = p.z + side.z;
        this.positions[o + 3] = p.x - side.x;
        this.positions[o + 4] = p.y - side.y;
        this.positions[o + 5] = p.z - side.z;
        const fade = i < h.length ? Math.pow(k, 1.4) * this.strength * 3.2 : 0;
        for (let v = 0; v < 2; v++) {
          this.colors[o + v * 3] = this.color.r * fade;
          this.colors[o + v * 3 + 1] = this.color.g * fade;
          this.colors[o + v * 3 + 2] = this.color.b * fade;
        }
      }
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
