/**
 * Drone flyover mode: a camera drone with inertia and banking to explore the
 * city. Keyboard + mouse, gamepad and touch (left stick move, right drag
 * look). "Tour" flies the event route automatically. Render only.
 *
 * Used on its own from the menu (it renders the backdrop city) and inside a
 * race or free roam as a photo mode (0 key): the session starts it from its
 * current camera, renders its own scene through the drone's camera and keeps
 * Escape for itself (DroneOptions). A heading-up minimap (ui/hud/minimap.ts) rides
 * along, centred on the drone with its view cone, zooming out as it climbs.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import type { NightScene } from '../render/scene';
import type { GameRenderer } from '../render/scene';
import { routeSample } from '../city/route';
import { h, btn } from '../ui/kit/dom';
import { HudCard } from '../ui/hud/hudCard';
import { Help, MUSIC_KEYS, helpOpen } from '../ui/panels/help';
import { ArrowDown, ArrowUp, Drone, Route, icon } from '../ui/kit/icons';
import { MAP, MapCar, Minimap } from '../ui/hud/minimap';
import { feetLabel, speedLabel } from '../ui/kit/units';
import { bearingDeg, compassPoint } from '../ui/map/places';
import { clamp, wrapAngle } from '../sim/math';
import { damp } from '../shared/anim';

export interface DroneOptions {
  /** Start pose (world position, yaw and pitch in rad); default behind and above the grid. */
  start?: { x: number; y: number; z: number; yaw: number; pitch: number };
  /** Escape exits (default true); a session handles Escape itself. */
  escape?: boolean;
  /** The card's title (default Explore, the menu's name for it). */
  title?: string;
  /** What the exit keys do, for the help panel (default Exit). */
  exitLabel?: string;
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

/** How the drone flies: speeds (m/s), rates (1/s), angles (rad), heights (m). */
const DRONE = {
  /** Free flight: top speed, Shift's multiple of it, the push toward it (per s, as a share of top speed) and the air's drag. */
  maxSpeed: 28,
  boost: 3,
  accel: 4,
  drag: 2.2,
  /** The wheel scales the top speed by these steps, within this range. */
  wheelUp: 1.1,
  wheelDown: 0.9,
  speedMul: [0.25, 4],
  /** Looking: rad per px dragged, a gamepad stick's px per s at full tilt and its deadzone, and the pitch range. */
  lookPerPx: 0.004,
  padLook: 600,
  deadzone: 0.15,
  pitch: [-1.45, 1.2],
  /** A touch drag this long (px) is the move stick at full tilt. */
  touchReach: 60,
  /** It banks this far per share of top speed moving sideways, at this rate. */
  bank: 0.35,
  bankRate: 4,
  /** It keeps this far over the ground and under this height. */
  clearance: 1.5,
  ceiling: 400,
  /** Hover bob: its rate (rad/s) and height. */
  bobRate: 1.7,
  bob: 0.06,
  /** How fast the minimap's zoom follows the height. */
  mapZoomRate: 3,
} as const;

/**
 * Touring the route: its speed, how far ahead it looks, its height over the
 * road with a slow sway, how far right of the line it flies, how fast it
 * closes on its spot and turns to look ahead, the pitch it settles at, and
 * how much it banks into the turn.
 */
const TOUR = { speed: 16, lookAhead: 60, height: 26, sway: 8, swayRate: 0.3, side: 8, follow: 1.5, turn: 1.2, pitch: -0.35, pitchRate: 1, bank: 0.4, bankRate: 2 } as const;

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
  private card: HudCard;
  /** The flying keys and tips behind the ? beside the minimap (ui/panels/help.ts); nothing flies while it is open. */
  private help: Help;
  private tourBtn: HTMLButtonElement;
  private map: Minimap;
  private mapZoom: number = MAP.scale;
  private cars: (() => readonly MapCar[]) | undefined;
  private drive: DroneOptions['drive'];
  // touch
  private moveTouch: { id: number; x0: number; y0: number; x: number; y: number } | null = null;
  private lookTouch: { id: number; x: number; y: number } | null = null;
  private touchUp = 0;
  /** Scratch for update(): nothing allocated per frame. */
  private readonly target = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly wish = new THREE.Vector3();

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
      this.pitch = clamp(opts.start.pitch, DRONE.pitch[0], DRONE.pitch[1]);
    } else {
      this.pos.set(g0.x - Math.sin(g0.yaw) * 30, world.heightAt(g0.x, g0.z) + 30, g0.z - Math.cos(g0.yaw) * 30);
      this.yaw = g0.yaw;
    }
    const o = { signal: this.abort.signal };
    window.addEventListener(
      'keydown',
      (e) => {
        // Nothing flies under a help panel (it closes on Escape before this sees it).
        if (helpOpen()) return;
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
        this.speedMul = clamp(this.speedMul * (e.deltaY > 0 ? DRONE.wheelDown : DRONE.wheelUp), DRONE.speedMul[0], DRONE.speedMul[1]);
        e.preventDefault();
      },
      { passive: false, signal: this.abort.signal },
    );

    // HUD
    this.tourBtn = btn(Route, 'Tour', () => this.setTour(!this.tour), '--small');
    const hold = (iconNode: typeof ArrowUp, dir: number) => {
      const b = h('button', { class: 'btn btn--icon drone-hud__lift-button', type: 'button', 'aria-label': dir > 0 ? 'Up' : 'Down' });
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
    // The HUD card free roam shares (ui/hud/hudCard.ts), in the Explore row's cyan.
    const title = opts.title ?? 'Explore';
    const exitLabel = opts.exitLabel ?? 'Exit';
    this.card = new HudCard({
      hue: 'cyan',
      icon: Drone,
      title,
      status: 'Free flight',
      stats: ['Altitude', 'Speed', 'Heading'],
      actions: [this.tourBtn],
      onExit,
      exitTitle: exitLabel,
    });
    this.help = new Help({
      title,
      sections: () => [
        {
          title: 'Flying',
          keys: [
            { keys: ['W', 'A', 'S', 'D'], label: 'Fly (or the arrow keys)' },
            { keys: ['Drag'], label: 'Look around' },
            { keys: ['Space', 'Ctrl'], label: 'Climb, descend (or E, Q)' },
            { keys: ['Shift'], label: 'Boost' },
            { keys: ['Wheel'], label: 'Cruise speed' },
          ],
        },
        {
          title: 'Keys',
          keys: [
            { keys: ['T'], label: 'Tour the route' },
            { keys: ['H'], label: 'Hide the HUD' },
            { keys: ['0', 'Esc'], label: exitLabel },
          ],
        },
        { title: 'Music', keys: MUSIC_KEYS },
        { title: 'Tips', tips: ['Gamepad: the left stick flies, the right stick looks, the triggers climb and descend.', 'Touch: drag the left half to fly and the right half to look; the arrows climb and descend.'] },
      ],
    });
    // The card stands in the race HUD's top left column (.hud__top-left, ui/hud/_hud.scss), which casts its shadow; the help beside the minimap.
    this.root = h('div', { class: 'drone-hud' }, h('div', { class: 'hud__top-left' }, this.card.el), this.help.el, h('div', { class: 'drone-hud__lift' }, hold(ArrowUp, 1), hold(ArrowDown, -1)));
    this.map = new Minimap(world, 'hud__minimap');
    this.root.append(this.map.canvas);
    this.cars = opts.cars;
    this.drive = opts.drive;
    uiRoot.append(this.root);
  }

  private look(dx: number, dy: number): void {
    this.yaw -= dx * DRONE.lookPerPx;
    this.pitch = clamp(this.pitch - dy * DRONE.lookPerPx, DRONE.pitch[0], DRONE.pitch[1]);
  }

  private setTour(on: boolean): void {
    this.tour = on;
    this.tourBtn.classList.toggle('btn--primary', on);
    this.card.setStatus(on ? 'Touring the route' : 'Free flight');
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
      this.tourS += dt * TOUR.speed;
      const p = routeSample(this.world.route, this.tourS);
      const ahead = routeSample(this.world.route, this.tourS + TOUR.lookAhead);
      const alt = this.world.heightAt(p.x, p.z) + TOUR.height + Math.sin(this.time * TOUR.swayRate) * TOUR.sway;
      this.pos.lerp(this.target.set(p.x - p.tz * TOUR.side, alt, p.z + p.tx * TOUR.side), damp(TOUR.follow, dt));
      const d = wrapAngle(Math.atan2(ahead.x - this.pos.x, ahead.z - this.pos.z) - this.yaw);
      this.yaw += d * damp(TOUR.turn, dt);
      this.pitch += (TOUR.pitch - this.pitch) * damp(TOUR.pitchRate, dt);
      this.roll += (-d * TOUR.bank - this.roll) * damp(TOUR.bankRate, dt);
      this.vel.set(0, 0, 0);
    } else {
      const fwd = this.fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const right = this.right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
      const wish = this.wish.set(0, 0, 0);
      if (k('KeyW') || k('ArrowUp')) wish.add(fwd);
      if (k('KeyS') || k('ArrowDown')) wish.sub(fwd);
      if (k('KeyD') || k('ArrowRight')) wish.add(right);
      if (k('KeyA') || k('ArrowLeft')) wish.sub(right);
      if (k('Space') || k('KeyE')) wish.y += 1;
      if (k('ControlLeft') || k('ControlRight') || k('KeyQ') || k('KeyC')) wish.y -= 1;
      wish.y += this.touchUp;
      if (this.moveTouch) {
        const mx = clamp((this.moveTouch.x - this.moveTouch.x0) / DRONE.touchReach, -1, 1);
        const my = clamp((this.moveTouch.y - this.moveTouch.y0) / DRONE.touchReach, -1, 1);
        wish.addScaledVector(right, mx).addScaledVector(fwd, -my);
      }
      const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
      for (const pad of pads) {
        if (!pad?.connected) continue;
        const dz = (v: number) => (Math.abs(v) > DRONE.deadzone ? v : 0);
        wish.addScaledVector(right, dz(pad.axes[0] ?? 0)).addScaledVector(fwd, -dz(pad.axes[1] ?? 0));
        this.look(dz(pad.axes[2] ?? 0) * DRONE.padLook * dt, dz(pad.axes[3] ?? 0) * DRONE.padLook * dt);
        wish.y += (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
        break;
      }
      const boost = k('ShiftLeft') || k('ShiftRight') ? DRONE.boost : 1;
      const max = DRONE.maxSpeed * this.speedMul * boost;
      if (wish.lengthSq() > 1) wish.normalize();
      this.vel.addScaledVector(wish, max * DRONE.accel * dt);
      this.vel.multiplyScalar(Math.exp(-DRONE.drag * dt));
      if (this.vel.length() > max) this.vel.setLength(max);
      this.pos.addScaledVector(this.vel, dt);
      // Bank into turns and strafes like a real quad.
      const lateral = this.vel.dot(right) / Math.max(1, max);
      this.roll += (-lateral * DRONE.bank - this.roll) * damp(DRONE.bankRate, dt);
    }
    // Stay above ground.
    const floor = this.world.heightAt(this.pos.x, this.pos.z) + DRONE.clearance;
    if (this.pos.y < floor) {
      this.pos.y = floor;
      if (this.vel.y < 0) this.vel.y = 0;
    }
    this.pos.y = Math.min(this.pos.y, DRONE.ceiling);
    // Gentle hover bob.
    const bob = Math.sin(this.time * DRONE.bobRate) * DRONE.bob;
    this.camera.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw + Math.PI, 0, 'YXZ');
    this.camera.rotateZ(-this.roll);

    const alt = this.pos.y - this.world.heightAt(this.pos.x, this.pos.z);
    this.card.setStat(0, feetLabel(alt));
    this.card.setStat(1, speedLabel(this.tour ? TOUR.speed : this.vel.length()));
    // The heading the drone looks along, on the maps' compass.
    const hx = Math.sin(this.yaw);
    const hz = Math.cos(this.yaw);
    this.card.setStat(2, `${compassPoint(hx, hz)} ${Math.round(bearingDeg(hx, hz))}°`);
    this.mapZoom += (mapScale(alt) - this.mapZoom) * damp(DRONE.mapZoomRate, dt);
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
    this.card.dispose();
    this.help.dispose();
    this.root.remove();
  }
}
