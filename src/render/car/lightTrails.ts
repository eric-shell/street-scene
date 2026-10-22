/**
 * Nitrous light trails: two glowing ribbons that stream from the taillights
 * while boosting and shrink away when the boost ends. Camera facing, tapered,
 * additive so they bloom. Render only.
 */
import * as THREE from 'three';

const N = 56;

export class LightTrails {
  readonly mesh: THREE.Mesh;
  private history: THREE.Vector3[][] = [[], []];
  private positions: Float32Array;
  private colors: Float32Array;
  private geo: THREE.BufferGeometry;
  private strength = 0;
  private local: THREE.Vector3[];
  private color = new THREE.Color(0xff1a2a);

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

  setColor(c: string): void {
    this.color.set(c);
  }

  update(carRoot: THREE.Object3D, camera: THREE.Camera, active: boolean, dt: number): void {
    this.strength += ((active ? 1 : 0) - this.strength) * (1 - Math.exp(-dt * (active ? 8 : 3)));
    carRoot.updateMatrixWorld();
    for (let t = 0; t < 2; t++) {
      const h = this.history[t];
      const p = this.local[t].clone().applyMatrix4(carRoot.matrixWorld);
      if (active || this.strength > 0.02) {
        if (!h.length || h[0].distanceToSquared(p) > 0.04) h.unshift(p);
        else h[0].copy(p);
        if (h.length > N) h.length = N;
        if (!active && h.length > 2) h.length = Math.max(2, h.length - 2); // retract when the boost ends
      } else h.length = 0;
    }
    this.writeGeometry(camera);
    this.mesh.visible = this.strength > 0.02;
  }

  private writeGeometry(camera: THREE.Camera): void {
    const cam = camera.getWorldPosition(new THREE.Vector3());
    const tan = new THREE.Vector3();
    const view = new THREE.Vector3();
    const side = new THREE.Vector3();
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
        const w = 0.055 * (0.3 + 0.7 * k);
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
