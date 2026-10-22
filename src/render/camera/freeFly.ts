/** Debug free fly camera: WASD to move, drag to look, Q/E down/up, Shift fast. */
import * as THREE from 'three';

export class FreeFlyCamera {
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.1, 2500);
  private yaw = 0;
  private pitch = -0.2;
  private keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private abort = new AbortController();

  constructor(target: HTMLElement) {
    const opts = { signal: this.abort.signal };
    window.addEventListener('keydown', (e) => this.keys.add(e.code), opts);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code), opts);
    window.addEventListener('blur', () => this.keys.clear(), opts);
    target.addEventListener(
      'pointerdown',
      (e) => {
        this.dragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      },
      opts,
    );
    window.addEventListener('pointerup', () => (this.dragging = false), opts);
    window.addEventListener(
      'pointermove',
      (e) => {
        if (!this.dragging) return;
        this.yaw -= (e.clientX - this.lastX) * 0.004;
        this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - (e.clientY - this.lastY) * 0.004));
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      },
      opts,
    );
  }

  set(pos: THREE.Vector3, yaw: number, pitch: number): void {
    this.camera.position.copy(pos);
    this.yaw = yaw;
    this.pitch = pitch;
    this.apply();
  }

  update(dt: number): void {
    const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 120 : 30) * dt;
    const fwd = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const p = this.camera.position;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) p.addScaledVector(fwd, speed);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) p.addScaledVector(fwd, -speed);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) p.addScaledVector(right, speed);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) p.addScaledVector(right, -speed);
    if (this.keys.has('KeyE')) p.y += speed;
    if (this.keys.has('KeyQ')) p.y -= speed;
    this.apply();
  }

  private apply(): void {
    const fwd = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    this.camera.lookAt(this.camera.position.clone().add(fwd));
  }

  dispose(): void {
    this.abort.abort();
  }
}
