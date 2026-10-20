/**
 * Race HUD in plain DOM plus small canvases (tachometer, boost gauge, minimap).
 * Reads a snapshot each frame; never touches the sim.
 */
import type { World } from '../city/world';
import { AREA_MAP_STYLE, AreaKind, AreaMapStyle } from '../city/districts/types';
import { FlagTriangleRight, Timer, Trophy, TriangleAlert, Zap, Award, Ghost, icon, Compass, Hammer } from './icons';
import { formatTime } from './format';

export interface HudCar {
  x: number;
  z: number;
  yaw: number;
  isPlayer: boolean;
  isGhost?: boolean;
}

export interface HudData {
  mode: 'circuit' | 'sprint' | 'drift';
  position: number;
  carCount: number;
  lap: number;
  laps: number;
  raceTime: number;
  bestLap: number | null;
  lastLap: number | null;
  speedKmh: number;
  rpm: number;
  redline: number;
  gear: number;
  manual: boolean;
  nitro: number;
  nitroActive: boolean;
  /** Throttle 0..1, drives the boost gauge (vacuum off throttle). */
  throttle?: number;
  countdown: number | null;
  wrongWay: boolean;
  progress: number;
  drift?: { total: number; current: number; multiplier: number };
  cars: HudCar[];
  ghost: boolean;
  /** Open world (free roam, test drive): the district under the car and how much the player smashed. */
  openWorld?: { area: string; smashed: number; topKmh: number };
}

export class Hud {
  readonly root: HTMLDivElement;
  private posEl: HTMLElement;
  private lapEl: HTMLElement;
  private timeEl: HTMLElement;
  private bestEl: HTMLElement;
  private centerEl: HTMLElement;
  private msgEl: HTMLElement;
  private wrongEl: HTMLElement;
  private nitroFill: HTMLElement;
  private nitroBox: HTMLElement;
  private tach: HTMLCanvasElement;
  private boostCv: HTMLCanvasElement;
  /** Boost pressure in bar (negative = vacuum), simulated render side with spool lag. */
  private boost = -0.6;
  private boostNeedle = -0.6;
  private lastThrottle = 0;
  private bov = 0;
  private nitroGlow = 0;
  private map: HTMLCanvasElement;
  private driftEl: HTMLElement;
  private progressFill: HTMLElement;
  private ghostEl: HTMLElement;
  private areaEl: HTMLElement;
  private smashEl: HTMLElement;
  private msgTimer = 0;
  private lastCountdown: number | null = null;
  private roads: Path2D;
  private routePath: Path2D;
  private closed: { x: number; z: number }[];
  /** District layers: polygon fills and line strokes, in draw order. */
  private areaFills: { path: Path2D; style: AreaMapStyle }[] = [];
  private areaLines: { path: Path2D; style: AreaMapStyle }[] = [];

  constructor(parent: HTMLElement, world: World) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-tl">
        <div class="hud-chip hud-pos"><span class="ic"></span><b class="v"></b></div>
        <div class="hud-chip hud-lap"><span class="ic"></span><b class="v"></b></div>
        <div class="hud-chip hud-time"><span class="ic"></span><b class="v"></b></div>
        <div class="hud-chip hud-best"><span class="ic"></span><b class="v"></b></div>
        <div class="hud-chip hud-ghost"><span class="ic"></span><b class="v">Ghost</b></div>
        <div class="hud-chip hud-area"><span class="ic"></span><b class="v"></b></div>
        <div class="hud-chip hud-smash"><span class="ic"></span><b class="v"></b></div>
      </div>
      <div class="hud-progress"><div class="fill"></div></div>
      <div class="hud-center"></div>
      <div class="hud-msg"></div>
      <div class="hud-wrong"><span class="ic"></span>WRONG WAY</div>
      <div class="hud-drift"></div>
      <div class="hud-br">
        <div class="hud-dials">
          <canvas class="hud-boost" width="132" height="132"></canvas>
          <canvas class="hud-tach" width="220" height="220"></canvas>
        </div>
        <div class="hud-nitro"><span class="ic"></span><div class="bar"><div class="fill"></div></div></div>
      </div>
      <canvas class="hud-map" width="200" height="200"></canvas>
    `;
    parent.appendChild(this.root);
    const q = (s: string) => this.root.querySelector(s) as HTMLElement;
    q('.hud-pos .ic').appendChild(icon(Trophy, { size: 16 }));
    q('.hud-lap .ic').appendChild(icon(FlagTriangleRight, { size: 16 }));
    q('.hud-time .ic').appendChild(icon(Timer, { size: 16 }));
    q('.hud-best .ic').appendChild(icon(Award, { size: 16 }));
    q('.hud-ghost .ic').appendChild(icon(Ghost, { size: 16 }));
    q('.hud-area .ic').appendChild(icon(Compass, { size: 16 }));
    q('.hud-smash .ic').appendChild(icon(Hammer, { size: 16 }));
    this.areaEl = q('.hud-area .v');
    this.smashEl = q('.hud-smash .v');
    q('.hud-wrong .ic').appendChild(icon(TriangleAlert, { size: 28 }));
    q('.hud-nitro .ic').appendChild(icon(Zap, { size: 18 }));
    this.posEl = q('.hud-pos .v');
    this.lapEl = q('.hud-lap .v');
    this.timeEl = q('.hud-time .v');
    this.bestEl = q('.hud-best .v');
    this.ghostEl = q('.hud-ghost');
    this.centerEl = q('.hud-center');
    this.msgEl = q('.hud-msg');
    this.wrongEl = q('.hud-wrong');
    this.nitroFill = q('.hud-nitro .fill');
    this.nitroBox = q('.hud-nitro');
    this.driftEl = q('.hud-drift');
    this.progressFill = q('.hud-progress .fill');
    this.tach = q('.hud-tach') as HTMLCanvasElement;
    this.boostCv = q('.hud-boost') as HTMLCanvasElement;
    this.map = q('.hud-map') as HTMLCanvasElement;

    const g = world.graph;
    this.roads = new Path2D();
    for (const e of g.edges) {
      // Alleys and shortcuts are drawn by their district layers (narrow, dimmed).
      if (e.shortcut || e.kind === 'alley') continue;
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      this.roads.moveTo(a.x, a.z);
      this.roads.lineTo(b.x, b.z);
    }
    this.buildAreaLayers(world);
    this.routePath = new Path2D();
    world.route.points.forEach((p, i) => (i ? this.routePath.lineTo(p.x, p.z) : this.routePath.moveTo(p.x, p.z)));
    this.closed = world.walls.filter((w) => w.kind === 'barrier').map((w) => ({ x: (w.ax + w.bx) / 2, z: (w.az + w.bz) / 2 }));
  }

  /** Minimap layers per district kind (styles from AREA_MAP_STYLE). */
  private buildAreaLayers(world: World): void {
    const g = world.graph;
    const fills = new Map<AreaKind, Path2D>();
    const lines = new Map<AreaKind, Path2D>();
    const get = (m: Map<AreaKind, Path2D>, k: AreaKind) => {
      let p = m.get(k);
      if (!p) m.set(k, (p = new Path2D()));
      return p;
    };
    for (const a of world.areas) {
      const st = AREA_MAP_STYLE[a.kind];
      if (st.fill && a.polygon.length > 2 && a.kind !== 'roundabout') {
        const p = get(fills, a.kind);
        a.polygon.forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
        p.closePath();
      }
      if (!st.stroke) continue;
      const p = get(lines, a.kind);
      if (a.kind === 'roundabout') {
        p.moveTo(a.params.x + a.params.outer, a.params.z);
        p.arc(a.params.x, a.params.z, a.params.outer, 0, Math.PI * 2);
        p.moveTo(a.params.x + a.params.island, a.params.z);
        p.arc(a.params.x, a.params.z, a.params.island, 0, Math.PI * 2);
      } else if (a.kind === 'subway') {
        a.path.forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
      } else {
        for (const eid of a.edges) {
          const e = g.edges[eid];
          p.moveTo(g.nodes[e.a].x, g.nodes[e.a].z);
          p.lineTo(g.nodes[e.b].x, g.nodes[e.b].z);
        }
      }
    }
    for (const [k, path] of fills) this.areaFills.push({ path, style: AREA_MAP_STYLE[k] });
    // Order: alleys and shortcuts under the subway and roundabout outlines.
    const order: AreaKind[] = ['backAlley', 'alley', 'roundabout', 'subway'];
    for (const k of order) {
      const path = lines.get(k);
      if (path) this.areaLines.push({ path, style: AREA_MAP_STYLE[k] });
    }
  }

  message(text: string, seconds = 2.2): void {
    this.msgEl.textContent = text;
    this.msgEl.classList.add('show');
    this.msgTimer = seconds;
  }

  update(d: HudData, dt: number): void {
    this.root.classList.toggle('open-world', !!d.openWorld);
    if (d.openWorld) {
      if (this.areaEl.textContent !== d.openWorld.area) this.areaEl.textContent = d.openWorld.area;
      const smash = `${d.openWorld.smashed} smashed · top ${Math.round(d.openWorld.topKmh)}`;
      if (this.smashEl.textContent !== smash) this.smashEl.textContent = smash;
    }
    const racingMode = d.mode !== 'drift';
    this.posEl.textContent = racingMode ? `${d.position}/${d.carCount}` : 'Drift';
    this.lapEl.textContent = d.mode === 'sprint' ? `${Math.round(d.progress * 100)}%` : `${Math.max(1, Math.min(d.lap, d.laps))}/${d.laps}`;
    this.timeEl.textContent = formatTime(d.raceTime);
    this.bestEl.textContent = d.bestLap ? formatTime(d.bestLap) : '--:--.--';
    this.ghostEl.style.display = d.ghost ? '' : 'none';
    this.progressFill.style.width = `${Math.max(0, Math.min(1, d.progress)) * 100}%`;
    this.nitroFill.style.width = `${d.nitro * 100}%`;
    this.nitroBox.classList.toggle('active', d.nitroActive);
    this.wrongEl.classList.toggle('show', d.wrongWay);

    if (d.countdown !== this.lastCountdown) {
      this.lastCountdown = d.countdown;
      if (d.countdown !== null) {
        this.centerEl.textContent = d.countdown > 0 ? String(d.countdown) : 'GO!';
        this.centerEl.classList.remove('pop');
        void this.centerEl.offsetWidth;
        this.centerEl.classList.add('pop');
      } else {
        this.centerEl.textContent = '';
      }
    }
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.msgEl.classList.remove('show');
    }
    if (d.drift) {
      this.driftEl.style.display = '';
      this.driftEl.innerHTML = `<div class="total">${Math.round(d.drift.total).toLocaleString()}</div>${
        d.drift.current > 0 ? `<div class="cur">+${Math.round(d.drift.current).toLocaleString()} <span>x${d.drift.multiplier}</span></div>` : ''
      }`;
    } else this.driftEl.style.display = 'none';
    this.drawTach(d);
    this.updateBoost(d, dt);
    this.drawBoost();
    this.drawMap(d);
  }

  /**
   * Turbo boost from rpm and throttle: manifold vacuum when off throttle,
   * pressure building with rpm under load with spool lag, a blow-off dump when
   * lifting at boost, and an extra spike while nitrous is on.
   */
  private updateBoost(d: HudData, dt: number): void {
    const load = Math.max(0, Math.min(1, d.throttle ?? (d.rpm > d.redline * 0.3 ? 1 : 0)));
    const r = Math.max(0, d.rpm / Math.max(1000, d.redline));
    const spool = Math.max(0, Math.min(1, (r - 0.22) / 0.5));
    const vacuum = -0.68 * (1 - load) ** 1.5;
    let target = vacuum + load * (spool * spool * (3 - 2 * spool)) * 1.25 + (d.nitroActive ? 0.55 : 0);
    if (d.countdown !== null && d.countdown > 0) target = vacuum + load * 0.35 * Math.min(1, r * 1.6);
    // Blow-off valve: lifting sharply at boost dumps the pressure at once.
    if (this.lastThrottle > 0.6 && load < 0.25 && this.boost > 0.35) this.bov = 0.35;
    this.lastThrottle = load;
    this.bov = Math.max(0, this.bov - dt);
    const tau = this.bov > 0 ? 0.05 : target > this.boost ? 0.55 : 0.16;
    this.boost += (target - this.boost) * (1 - Math.exp(-dt / tau));
    this.boostNeedle += (this.boost - this.boostNeedle) * (1 - Math.exp(-dt / 0.05));
    this.nitroGlow += ((d.nitroActive ? 1 : 0) - this.nitroGlow) * (1 - Math.exp(-dt / 0.12));
  }

  private drawBoost(): void {
    const c = this.boostCv.getContext('2d')!;
    const W = this.boostCv.width;
    const cx = W / 2;
    const cy = W / 2;
    const R = W * 0.4;
    const lo = -1;
    const hi = 2;
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    const ang = (bar: number) => a0 + (a1 - a0) * Math.max(0, Math.min(1, (bar - lo) / (hi - lo)));
    const v = this.boostNeedle;
    const glow = this.nitroGlow;
    const accent = glow > 0.05 ? '#ffffff' : '#19e6ff';
    c.clearRect(0, 0, W, W);
    c.lineCap = 'butt';
    c.fillStyle = 'rgba(6,10,24,0.62)';
    c.beginPath();
    c.arc(cx, cy, R + 9, 0, Math.PI * 2);
    c.fill();
    if (glow > 0.01) {
      c.strokeStyle = `rgba(79,168,255,${0.75 * glow})`;
      c.lineWidth = 3;
      c.shadowColor = '#4fa8ff';
      c.shadowBlur = 16 * glow;
      c.beginPath();
      c.arc(cx, cy, R + 8, 0, Math.PI * 2);
      c.stroke();
      c.shadowBlur = 0;
    }
    // Track: vacuum side dim, boost side lit up to the needle, overboost red.
    c.lineWidth = 6;
    c.strokeStyle = 'rgba(120,200,255,0.18)';
    c.beginPath();
    c.arc(cx, cy, R, a0, a1);
    c.stroke();
    c.strokeStyle = '#ff2e5b';
    c.beginPath();
    c.arc(cx, cy, R, ang(1.6), a1);
    c.stroke();
    if (v > 0) {
      c.strokeStyle = accent;
      c.shadowColor = glow > 0.05 ? '#4fa8ff' : '#19e6ff';
      c.shadowBlur = 8 + 10 * glow;
      c.beginPath();
      c.arc(cx, cy, R, ang(0), ang(v));
      c.stroke();
      c.shadowBlur = 0;
    } else {
      c.strokeStyle = 'rgba(143,179,255,0.55)';
      c.beginPath();
      c.arc(cx, cy, R, ang(v), ang(0));
      c.stroke();
    }
    c.font = '600 10px Rajdhani, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let k = lo * 2; k <= hi * 2; k++) {
      const a = ang(k / 2);
      const major = k % 2 === 0;
      c.strokeStyle = 'rgba(200,220,255,0.7)';
      c.lineWidth = major ? 2 : 1;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * (R - (major ? 10 : 7)), cy + Math.sin(a) * (R - (major ? 10 : 7)));
      c.lineTo(cx + Math.cos(a) * (R - 3), cy + Math.sin(a) * (R - 3));
      c.stroke();
      if (major) {
        c.fillStyle = '#c7d6ff';
        c.fillText(String(k / 2), cx + Math.cos(a) * (R - 19), cy + Math.sin(a) * (R - 19));
      }
    }
    const na = ang(v);
    c.strokeStyle = '#ff3df2';
    c.lineWidth = 2.5;
    c.shadowColor = '#ff3df2';
    c.shadowBlur = 6;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(na) * (R - 5), cy + Math.sin(na) * (R - 5));
    c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = '#ff3df2';
    c.beginPath();
    c.arc(cx, cy, 3.5, 0, Math.PI * 2);
    c.fill();
    c.font = '700 17px Orbitron, Rajdhani, system-ui, sans-serif';
    c.fillStyle = v > 1.6 ? '#ff2e5b' : glow > 0.05 ? '#fff' : v > 0 ? '#19e6ff' : '#8fb3ff';
    const shown = Math.abs(v) < 0.05 ? 0 : v;
    c.fillText((shown > 0 ? '+' : '') + shown.toFixed(1), cx, cy + 26);
    c.font = '600 9px Rajdhani, system-ui, sans-serif';
    c.fillStyle = '#8fb3ff';
    c.fillText(this.bov > 0.1 ? 'BLOW OFF' : 'BOOST BAR', cx, cy + 42);
  }

  private drawTach(d: HudData): void {
    const c = this.tach.getContext('2d')!;
    const W = this.tach.width;
    const cx = W / 2;
    const cy = W / 2;
    const R = W * 0.44;
    c.clearRect(0, 0, W, W);
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    const maxRpm = Math.ceil((d.redline + 500) / 1000) * 1000;
    const ang = (rpm: number) => a0 + (a1 - a0) * Math.min(1, rpm / maxRpm);
    c.lineCap = 'butt';
    c.fillStyle = 'rgba(6,10,24,0.62)';
    c.beginPath();
    c.arc(cx, cy, R + 8, 0, Math.PI * 2);
    c.fill();
    c.lineWidth = 8;
    c.strokeStyle = 'rgba(120,200,255,0.18)';
    c.beginPath();
    c.arc(cx, cy, R, a0, a1);
    c.stroke();
    c.strokeStyle = '#ff2e5b';
    c.beginPath();
    c.arc(cx, cy, R, ang(d.redline), a1);
    c.stroke();
    c.strokeStyle = '#19e6ff';
    c.shadowColor = '#19e6ff';
    c.shadowBlur = 10;
    c.beginPath();
    c.arc(cx, cy, R, a0, ang(d.rpm));
    c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = '#c7d6ff';
    c.font = '600 12px Rajdhani, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let k = 0; k <= maxRpm / 1000; k++) {
      const a = ang(k * 1000);
      c.strokeStyle = 'rgba(200,220,255,0.7)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * (R - 12), cy + Math.sin(a) * (R - 12));
      c.lineTo(cx + Math.cos(a) * (R - 4), cy + Math.sin(a) * (R - 4));
      c.stroke();
      c.fillText(String(k), cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24));
    }
    const na = ang(d.rpm);
    c.strokeStyle = '#ff3df2';
    c.lineWidth = 3;
    c.shadowColor = '#ff3df2';
    c.shadowBlur = 8;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(na) * (R - 6), cy + Math.sin(na) * (R - 6));
    c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = '#fff';
    c.font = '700 44px Orbitron, Rajdhani, system-ui, sans-serif';
    c.fillText(String(Math.round(d.speedKmh)), cx, cy + 40);
    c.font = '600 12px Rajdhani, system-ui, sans-serif';
    c.fillStyle = '#8fb3ff';
    c.fillText('KM/H', cx, cy + 66);
    c.font = '700 26px Orbitron, Rajdhani, system-ui, sans-serif';
    c.fillStyle = d.rpm > d.redline * 0.95 ? '#ff2e5b' : '#19e6ff';
    c.fillText(d.gear < 0 ? 'R' : String(d.gear), cx, cy - 6);
    if (d.manual) {
      c.font = '600 10px Rajdhani, system-ui, sans-serif';
      c.fillStyle = '#8fb3ff';
      c.fillText('MANUAL', cx, cy - 30);
    }
  }

  private drawMap(d: HudData): void {
    const c = this.map.getContext('2d')!;
    const W = this.map.width;
    const player = d.cars.find((x) => x.isPlayer);
    c.clearRect(0, 0, W, W);
    c.save();
    c.beginPath();
    c.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2);
    c.fillStyle = 'rgba(6,10,24,0.66)';
    c.fill();
    c.clip();
    if (player) {
      const scale = 0.38;
      c.translate(W / 2, W / 2 + 26);
      // Heading up: forward (sin yaw, cos yaw) maps to screen up.
      c.rotate(player.yaw - Math.PI);
      c.scale(scale, scale);
      c.translate(-player.x, -player.z);
      c.lineCap = 'round';
      c.lineJoin = 'round';
      for (const f of this.areaFills) {
        c.fillStyle = f.style.fill!;
        c.fill(f.path);
      }
      c.strokeStyle = 'rgba(140,160,220,0.22)';
      c.lineWidth = 9;
      c.stroke(this.roads);
      for (const l of this.areaLines) {
        c.strokeStyle = l.style.stroke!;
        c.lineWidth = l.style.width ?? 4;
        c.setLineDash(l.style.dash ?? []);
        c.stroke(l.path);
      }
      c.setLineDash([]);
      c.strokeStyle = '#19e6ff';
      c.shadowColor = '#19e6ff';
      c.shadowBlur = 6;
      c.lineWidth = 7;
      c.stroke(this.routePath);
      c.shadowBlur = 0;
      c.fillStyle = '#ff9d1a';
      for (const p of this.closed) c.fillRect(p.x - 4, p.z - 4, 8, 8);
      for (const car of d.cars) {
        if (car.isPlayer) continue;
        c.fillStyle = car.isGhost ? 'rgba(190,140,255,0.8)' : '#ff2e5b';
        c.beginPath();
        c.arc(car.x, car.z, 9, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();
    // player arrow
    c.fillStyle = '#fff';
    c.beginPath();
    c.moveTo(W / 2, W / 2 + 14);
    c.lineTo(W / 2 - 8, W / 2 + 34);
    c.lineTo(W / 2 + 8, W / 2 + 34);
    c.closePath();
    c.fill();
    c.strokeStyle = 'rgba(25,230,255,0.5)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2);
    c.stroke();
  }

  dispose(): void {
    this.root.remove();
  }
}
