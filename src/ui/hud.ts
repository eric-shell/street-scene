/**
 * Race HUD in plain DOM plus small canvases (tachometer, boost gauge, and the
 * minimap from minimap.ts, which the drone shares).
 * Reads a snapshot each frame; never touches the sim.
 */
import type { World } from '../city/world';
import { FlagTriangleRight, Timer, Trophy, TriangleAlert, Zap, Award, Ghost, icon, Compass, Hammer } from './icons';
import { formatTime } from './format';
import { MapCar, Minimap } from './minimap';
import { PALETTE, rgb, rgba } from './palette';

/** Canvas inks for the dials, built once (they redraw every frame); the minimap has its own in minimap.ts. */
const INK = {
  face: rgba('bg0', 0.72),
  track: rgba('muted', 0.2),
  tick: rgba('soft', 0.75),
  numeral: PALETTE.soft,
  caption: PALETTE.muted,
  /** RPM and boost fill: orange, the primary accent. */
  fill: PALETTE.orange,
  /** Needles and the gear: yellow, the secondary accent. */
  needle: PALETTE.yellow,
  red: PALETTE.red,
  /** Nitrous glow keeps its cyan. */
  nitro: PALETTE.cyan,
  nitroRgb: rgb('cyan'),
  vacuum: rgba('muted', 0.6),
  text: PALETTE.text,
  font: '"Google Sans Flex", system-ui, sans-serif',
  digits: '"Google Sans Flex", system-ui, sans-serif',
} as const;

export type HudCar = MapCar;

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
  private map: Minimap;
  private driftEl: HTMLElement;
  private progressFill: HTMLElement;
  private ghostEl: HTMLElement;
  private areaEl: HTMLElement;
  private smashEl: HTMLElement;
  private msgTimer = 0;
  private lastCountdown: number | null = null;
  /** Free roam: a click on the minimap opens the full city map (the session sets this). */
  onMapClick: (() => void) | null = null;

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
    this.map = new Minimap(world);
    this.root.append(this.map.canvas);
    // Only in the open world (CSS makes the map clickable there), with a hint that it opens.
    this.map.canvas.title = 'City map (Tab)';
    this.map.canvas.addEventListener('click', () => {
      if (this.root.classList.contains('open-world')) this.onMapClick?.();
    });
    const hint = document.createElement('div');
    hint.className = 'hud-map-hint';
    hint.append(icon(Compass, { size: 13 }), 'Map · Tab');
    this.root.append(hint);

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
    const accent = glow > 0.05 ? INK.text : INK.fill;
    c.clearRect(0, 0, W, W);
    c.lineCap = 'butt';
    c.fillStyle = INK.face;
    c.beginPath();
    c.arc(cx, cy, R + 9, 0, Math.PI * 2);
    c.fill();
    if (glow > 0.01) {
      c.strokeStyle = `rgba(${INK.nitroRgb},${0.75 * glow})`;
      c.lineWidth = 3;
      c.shadowColor = INK.nitro;
      c.shadowBlur = 16 * glow;
      c.beginPath();
      c.arc(cx, cy, R + 8, 0, Math.PI * 2);
      c.stroke();
      c.shadowBlur = 0;
    }
    // Track: vacuum side dim, boost side lit up to the needle, overboost red.
    c.lineWidth = 6;
    c.strokeStyle = INK.track;
    c.beginPath();
    c.arc(cx, cy, R, a0, a1);
    c.stroke();
    c.strokeStyle = INK.red;
    c.beginPath();
    c.arc(cx, cy, R, ang(1.6), a1);
    c.stroke();
    if (v > 0) {
      c.strokeStyle = accent;
      c.shadowColor = glow > 0.05 ? INK.nitro : INK.fill;
      c.shadowBlur = 4 + 12 * glow;
      c.beginPath();
      c.arc(cx, cy, R, ang(0), ang(v));
      c.stroke();
      c.shadowBlur = 0;
    } else {
      c.strokeStyle = INK.vacuum;
      c.beginPath();
      c.arc(cx, cy, R, ang(v), ang(0));
      c.stroke();
    }
    c.font = `600 10px ${INK.font}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let k = lo * 2; k <= hi * 2; k++) {
      const a = ang(k / 2);
      const major = k % 2 === 0;
      c.strokeStyle = INK.tick;
      c.lineWidth = major ? 2 : 1;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * (R - (major ? 10 : 7)), cy + Math.sin(a) * (R - (major ? 10 : 7)));
      c.lineTo(cx + Math.cos(a) * (R - 3), cy + Math.sin(a) * (R - 3));
      c.stroke();
      if (major) {
        c.fillStyle = INK.numeral;
        c.fillText(String(k / 2), cx + Math.cos(a) * (R - 19), cy + Math.sin(a) * (R - 19));
      }
    }
    const na = ang(v);
    c.strokeStyle = INK.needle;
    c.lineWidth = 2.5;
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = 4;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(na) * (R - 5), cy + Math.sin(na) * (R - 5));
    c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = INK.needle;
    c.beginPath();
    c.arc(cx, cy, 3.5, 0, Math.PI * 2);
    c.fill();
    c.font = `800 20px ${INK.digits}`;
    c.fillStyle = v > 1.6 ? INK.red : glow > 0.05 ? INK.text : v > 0 ? INK.fill : INK.caption;
    const shown = Math.abs(v) < 0.05 ? 0 : v;
    c.fillText((shown > 0 ? '+' : '') + shown.toFixed(1), cx, cy + 26);
    c.font = `600 9px ${INK.font}`;
    c.fillStyle = INK.caption;
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
    c.fillStyle = INK.face;
    c.beginPath();
    c.arc(cx, cy, R + 8, 0, Math.PI * 2);
    c.fill();
    c.lineWidth = 8;
    c.strokeStyle = INK.track;
    c.beginPath();
    c.arc(cx, cy, R, a0, a1);
    c.stroke();
    c.strokeStyle = INK.red;
    c.beginPath();
    c.arc(cx, cy, R, ang(d.redline), a1);
    c.stroke();
    c.strokeStyle = INK.fill;
    c.shadowColor = INK.fill;
    c.shadowBlur = 6;
    c.beginPath();
    c.arc(cx, cy, R, a0, ang(d.rpm));
    c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = INK.numeral;
    c.font = `600 13px ${INK.font}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let k = 0; k <= maxRpm / 1000; k++) {
      const a = ang(k * 1000);
      c.strokeStyle = INK.tick;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * (R - 12), cy + Math.sin(a) * (R - 12));
      c.lineTo(cx + Math.cos(a) * (R - 4), cy + Math.sin(a) * (R - 4));
      c.stroke();
      c.fillText(String(k), cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24));
    }
    const na = ang(d.rpm);
    c.strokeStyle = INK.needle;
    c.lineWidth = 3;
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = 5;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(na) * (R - 6), cy + Math.sin(na) * (R - 6));
    c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = INK.text;
    c.font = `900 52px ${INK.digits}`;
    c.fillText(String(Math.round(d.speedKmh)), cx, cy + 40);
    c.font = `600 12px ${INK.font}`;
    c.fillStyle = INK.caption;
    c.fillText('KM/H', cx, cy + 66);
    c.font = `900 30px ${INK.digits}`;
    c.fillStyle = d.rpm > d.redline * 0.95 ? INK.red : INK.needle;
    c.fillText(d.gear < 0 ? 'R' : String(d.gear), cx, cy - 6);
    if (d.manual) {
      c.font = `600 10px ${INK.font}`;
      c.fillStyle = INK.caption;
      c.fillText('MANUAL', cx, cy - 30);
    }
  }

  private drawMap(d: HudData): void {
    const player = d.cars.find((x) => x.isPlayer);
    if (player) this.map.draw({ x: player.x, z: player.z, yaw: player.yaw }, d.cars);
  }

  dispose(): void {
    this.root.remove();
  }
}
