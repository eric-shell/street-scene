/**
 * Drone flyover mode: a camera drone with inertia and banking to explore the
 * city. Keyboard + mouse, gamepad and touch (left stick move, right drag
 * look). "Tour" flies the event route automatically. Render only.
 *
 * Used on its own from the menu (it renders the backdrop city) and inside a
 * race or free roam as a photo mode (0 key): the session starts it from its
 * current camera, renders its own scene through the drone's camera and keeps
 * Escape for itself (DroneOptions). A heading-up minimap (ui/minimap.ts) rides
 * along, centred on the drone with its view cone, zooming out as it climbs.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import type { NightScene } from '../render/scene';
import type { GameRenderer } from '../render/scene';
import { routeSample } from '../city/route';
import { h, btn } from '../ui/dom';
import { ArrowDown, ArrowUp, Compass, Drone, Gauge, Mountain, Route, X, icon } from '../ui/icons';
import { MAP, MapCar, Minimap } from '../ui/minimap';

export interface DroneOptions {
  /** Start pose (world position, yaw and pitch in rad); default behind and above the grid. */
  start?: { x: number; y: number; z: number; yaw: number; pitch: number };
  /** Escape exits (default true); a session handles Escape itself. */
  escape?: boolean;
  /** Controls hint line. */
  hint?: string;
  /** Cars to mark on the minimap (a race's field, frozen or replaying); none from the menu. */
  cars?: () => readonly MapCar[];
  /**
   * Advances the scene the drone flies over (render() calls it with dt and the
   * drone's position for the real lights to follow): the menu's street stage,
   * whose clock the car, the gates and the trains share. Without it render()
   * runs the scene on the drone's own clock.
   */
  drive?: (dt: number, focus: THREE.Vector3) => void;
}

const MAX_SPEED = 28;
const BOOST = 3;
const ACCEL = 4;
const DAMP = 2.2;

/**
 * Minimap zoom (px per m) for a height above ground (m): street detail near the
 * ground, a whole district at the 400 m ceiling.
 */
function mapScale(alt: number): number {
  return Math.max(0.07, Math.min(MAP.scale, (MAP.scale * 70) / (alt + 40)));
}

export class DroneMode {
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2500);
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private yaw = 0;
  private pitch = -0.25;
  private roll = 0;
  private keys = new Set<string>();
  private abort = new AbortController();
  private dragging = false;
  private lx = 0;
  private ly = 0;
  private speedMul = 1;
  private tour = false;
  private tourS = 0;
  private time = 0;
  private root: HTMLElement;
  private altEl: HTMLElement;
  private spdEl: HTMLElement;
  private hdgEl: HTMLElement;
  private tourBtn: HTMLButtonElement;
  private map: Minimap;
  private mapZoom: number = MAP.scale;
  private cars: (() => readonly MapCar[]) | undefined;
  private drive: DroneOptions['drive'];
  // touch
  private moveTouch: { id: number; x0: number; y0: number; x: number; y: number } | null = null;
  private lookTouch: { id: number; x: number; y: number } | null = null;
  private touchUp = 0;

  constructor(
    private readonly gr: GameRenderer,
    private readonly night: NightScene,
    private readonly world: World,
    uiRoot: HTMLElement,
    onExit: () => void,
    opts: DroneOptions = {},
  ) {
    const g0 = world.route.grid[0];
    if (opts.start) {
      this.pos.set(opts.start.x, opts.start.y, opts.start.z);
      this.yaw = opts.start.yaw;
      this.pitch = Math.max(-1.45, Math.min(1.2, opts.start.pitch));
    } else {
      this.pos.set(g0.x - Math.sin(g0.yaw) * 30, world.heightAt(g0.x, g0.z) + 30, g0.z - Math.cos(g0.yaw) * 30);
      this.yaw = g0.yaw;
    }
    const o = { signal: this.abort.signal };
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Escape' && opts.escape !== false) onExit();
        if (e.code === 'KeyT' && !e.repeat) this.setTour(!this.tour);
        this.keys.add(e.code);
        if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      },
      o,
    );
    window.addEventListener('keyup', (e) => this.keys.delete(e.code), o);
    window.addEventListener('blur', () => this.keys.clear(), o);
    const canvas = gr.canvas;
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType === 'touch') {
          if (e.clientX < window.innerWidth / 2 && !this.moveTouch) this.moveTouch = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY };
          else if (!this.lookTouch) this.lookTouch = { id: e.pointerId, x: e.clientX, y: e.clientY };
          return;
        }
        this.dragging = true;
        this.lx = e.clientX;
        this.ly = e.clientY;
      },
      o,
    );
    window.addEventListener(
      'pointermove',
      (e) => {
        if (this.moveTouch && e.pointerId === this.moveTouch.id) {
          this.moveTouch.x = e.clientX;
          this.moveTouch.y = e.clientY;
        } else if (this.lookTouch && e.pointerId === this.lookTouch.id) {
          this.look(e.clientX - this.lookTouch.x, e.clientY - this.lookTouch.y);
          this.lookTouch.x = e.clientX;
          this.lookTouch.y = e.clientY;
        } else if (this.dragging) {
          this.look(e.clientX - this.lx, e.clientY - this.ly);
          this.lx = e.clientX;
          this.ly = e.clientY;
        }
      },
      o,
    );
    const end = (e: PointerEvent) => {
      if (this.moveTouch?.id === e.pointerId) this.moveTouch = null;
      if (this.lookTouch?.id === e.pointerId) this.lookTouch = null;
      this.dragging = false;
    };
    window.addEventListener('pointerup', end, o);
    window.addEventListener('pointercancel', end, o);
    canvas.addEventListener(
      'wheel',
      (e) => {
        this.speedMul = Math.max(0.25, Math.min(4, this.speedMul * (e.deltaY > 0 ? 0.9 : 1.1)));
        e.preventDefault();
      },
      { passive: false, signal: this.abort.signal },
    );

    // HUD
    this.altEl = h('b', {}, '0 m');
    this.spdEl = h('b', {}, '0');
    this.hdgEl = h('b', {}, 'N');
    this.tourBtn = btn(Route, 'Tour', () => this.setTour(!this.tour), 'small');
    const hold = (iconNode: typeof ArrowUp, dir: number) => {
      const b = h('button', { class: 'btn icon-only drone-touch', type: 'button', 'aria-label': dir > 0 ? 'Up' : 'Down' });
      b.append(icon(iconNode, { size: 20 }));
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.touchUp = dir;
      });
      const stop = () => (this.touchUp = 0);
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointercancel', stop);
      b.addEventListener('pointerleave', stop);
      return b;
    };
    this.root = h(
      'div',
      { class: 'drone-ui' },
      h(
        'div',
        { class: 'drone-top' },
        h('div', { class: 'hud-chip' }, h('span', { class: 'ic' }, icon(Drone, { size: 16 })), h('b', {}, 'DRONE')),
        h('div', { class: 'hud-chip' }, h('span', { class: 'ic' }, icon(Mountain, { size: 16 })), this.altEl),
        h('div', { class: 'hud-chip' }, h('span', { class: 'ic' }, icon(Gauge, { size: 16 })), this.spdEl),
        h('div', { class: 'hud-chip' }, h('span', { class: 'ic' }, icon(Compass, { size: 16 })), this.hdgEl),
      ),
      h('div', { class: 'drone-actions' }, this.tourBtn, btn(X, 'Exit', onExit, 'small')),
      h('div', { class: 'drone-updown' }, hold(ArrowUp, 1), hold(ArrowDown, -1)),
      h('div', { class: 'drone-hint muted' }, opts.hint ?? 'WASD fly · drag to look · Space / Ctrl up / down · Shift boost · wheel speed · T tour · 0 or Esc exit'),
    );
    this.map = new Minimap(world, 'hud-map drone-map');
    this.root.append(this.map.canvas);
    this.cars = opts.cars;
    this.drive = opts.drive;
    uiRoot.append(this.root);
  }

  private look(dx: number, dy: number): void {
    this.yaw -= dx * 0.004;
    this.pitch = Math.max(-1.45, Math.min(1.2, this.pitch - dy * 0.004));
  }

  private setTour(on: boolean): void {
    this.tour = on;
    this.tourBtn.classList.toggle('primary', on);
    if (on) {
      const p = this.world.routeProgress(this.pos.x, this.pos.z);
      this.tourS = p.s;
    }
  }

  update(dt: number): void {
    this.time += dt;
    const k = (c: string) => this.keys.has(c);
    if (this.tour) {
      // Glide along the route, looking ahead.
      this.tourS += dt * 16;
      const p = routeSample(this.world.route, this.tourS);
      const ahead = routeSample(this.world.route, this.tourS + 60);
      const alt = this.world.heightAt(p.x, p.z) + 26 + Math.sin(this.time * 0.3) * 8;
      const target = new THREE.Vector3(p.x - p.tz * 8, alt, p.z + p.tx * 8);
      this.pos.lerp(target, 1 - Math.exp(-dt * 1.5));
      const lookYaw = Math.atan2(ahead.x - this.pos.x, ahead.z - this.pos.z);
      let d = lookYaw - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * (1 - Math.exp(-dt * 1.2));
      this.pitch += (-0.35 - this.pitch) * (1 - Math.exp(-dt));
      this.roll += (-d * 0.4 - this.roll) * (1 - Math.exp(-dt * 2));
      this.vel.set(0, 0, 0);
    } else {
      const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
      const wish = new THREE.Vector3();
      if (k('KeyW') || k('ArrowUp')) wish.add(fwd);
      if (k('KeyS') || k('ArrowDown')) wish.sub(fwd);
      if (k('KeyD') || k('ArrowRight')) wish.add(right);
      if (k('KeyA') || k('ArrowLeft')) wish.sub(right);
      if (k('Space') || k('KeyE')) wish.y += 1;
      if (k('ControlLeft') || k('ControlRight') || k('KeyQ') || k('KeyC')) wish.y -= 1;
      wish.y += this.touchUp;
      if (this.moveTouch) {
        const mx = Math.max(-1, Math.min(1, (this.moveTouch.x - this.moveTouch.x0) / 60));
        const my = Math.max(-1, Math.min(1, (this.moveTouch.y - this.moveTouch.y0) / 60));
        wish.addScaledVector(right, mx).addScaledVector(fwd, -my);
      }
      const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
      for (const pad of pads) {
        if (!pad?.connected) continue;
        const dz = (v: number) => (Math.abs(v) > 0.15 ? v : 0);
        wish.addScaledVector(right, dz(pad.axes[0] ?? 0)).addScaledVector(fwd, -dz(pad.axes[1] ?? 0));
        this.look(dz(pad.axes[2] ?? 0) * 600 * dt, dz(pad.axes[3] ?? 0) * 600 * dt);
        wish.y += (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
        break;
      }
      const boost = k('ShiftLeft') || k('ShiftRight') ? BOOST : 1;
      const max = MAX_SPEED * this.speedMul * boost;
      if (wish.lengthSq() > 1) wish.normalize();
      this.vel.addScaledVector(wish, max * ACCEL * dt);
      this.vel.multiplyScalar(Math.exp(-DAMP * dt));
      if (this.vel.length() > max) this.vel.setLength(max);
      this.pos.addScaledVector(this.vel, dt);
      // Bank into turns and strafes like a real quad.
      const lateral = this.vel.dot(right) / Math.max(1, max);
      this.roll += (-lateral * 0.35 - this.roll) * (1 - Math.exp(-dt * 4));
    }
    // Stay above ground.
    const floor = this.world.heightAt(this.pos.x, this.pos.z) + 1.5;
    if (this.pos.y < floor) {
      this.pos.y = floor;
      if (this.vel.y < 0) this.vel.y = 0;
    }
    this.pos.y = Math.min(this.pos.y, 400);
    // Gentle hover bob.
    const bob = Math.sin(this.time * 1.7) * 0.06;
    this.camera.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw + Math.PI, 0, 'YXZ');
    this.camera.rotateZ(-this.roll);

    const alt = this.pos.y - this.world.heightAt(this.pos.x, this.pos.z);
    this.altEl.textContent = `${Math.round(alt)} m`;
    this.spdEl.textContent = `${Math.round((this.tour ? 16 : this.vel.length()) * 3.6)} km/h`;
    const deg = ((((-this.yaw * 180) / Math.PI) % 360) + 360) % 360;
    this.hdgEl.textContent = `${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]} ${Math.round(deg)}°`;
    this.mapZoom += (mapScale(alt) - this.mapZoom) * (1 - Math.exp(-dt * 3));
    const fov = 2 * Math.atan(Math.tan((this.camera.fov * Math.PI) / 360) * this.gr.aspect);
    this.map.draw({ x: this.pos.x, z: this.pos.z, yaw: this.yaw, scale: this.mapZoom, marker: 'drone', fov }, this.cars?.() ?? []);
  }

  render(dt: number): void {
    this.update(dt);
    if (this.drive) this.drive(dt, this.camera.position);
    else {
      this.night.lighting.update(this.camera.position);
      this.night.update(this.time);
    }
    this.gr.post.setSpeedBlur(0);
    this.gr.render(this.night.scene, this.camera, dt);
  }

  dispose(): void {
    this.abort.abort();
    this.root.remove();
  }
}
