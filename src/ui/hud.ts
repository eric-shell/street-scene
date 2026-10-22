/**
 * Race HUD in plain DOM plus small canvases (tachometer, boost gauge, and the
 * minimap from minimap.ts, which the drone shares). The nitrous bar shows the
 * tank's three stages, each in its own color, and the callouts over the dial
 * cluster (boostCallouts.ts) name the style that fills it.
 * Reads a snapshot each frame; never touches the sim.
 */
import type { World } from '../city/world';
import type { RaceMode } from '../sim/race';
import { nitroFullStages } from '../sim/car';
import { NITRO_STAGES } from '../sim/tuning';
import { BoostCallouts } from './boostCallouts';
import { FlagTriangleRight, Timer, Trophy, TriangleAlert, Zap, Award, Ghost, icon, Compass, Disc3, MapPin, Navigation2 } from './icons';
import { formatTime } from './format';
import type { HudCard } from './hudCard';
import { MapCar, Minimap } from './minimap';
import { NITRO_STAGE_COLORS, PALETTE, rgb, rgba } from './palette';
import { formatDistance } from './places';

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
  /** Nitrous glow in the burning stage's color (cyan, purple, pink). */
  nitro: NITRO_STAGE_COLORS.map((c) => PALETTE[c]),
  nitroRgb: NITRO_STAGE_COLORS.map((c) => rgb(c)),
  vacuum: rgba('muted', 0.6),
  text: PALETTE.text,
  font: '"Google Sans Flex", system-ui, sans-serif',
  digits: '"Google Sans Flex", system-ui, sans-serif',
} as const;

export type HudCar = MapCar;

export interface HudData {
  mode: RaceMode;
  position: number;
  carCount: number;
  lap: number;
  laps: number;
  raceTime: number;
  bestLap: number | null;
  lastLap: number | null;
  speedMph: number;
  rpm: number;
  redline: number;
  gear: number;
  manual: boolean;
  /** Nitrous in stages, 0..NITRO_STAGES. */
  nitro: number;
  nitroActive: boolean;
  /** The stage burning (1..NITRO_STAGES), 0 when not boosting. */
  nitroStage: number;
  /** Throttle 0..1, drives the boost gauge (vacuum off throttle). */
  throttle?: number;
  countdown: number | null;
  wrongWay: boolean;
  progress: number;
  drift?: { total: number; current: number; multiplier: number; zoneBonus?: number };
  /**
   * Inside a drift zone (sim/driftZones.ts): the multiplier it pays (drift points in drift mode,
   * the nitrous refill otherwise), the share of the visit's bonus left (0..1) and whether it rests.
   */
  zone?: { mul: number; nitro: boolean; left: number; resting: boolean };
  cars: HudCar[];
  ghost: boolean;
  /** Open world (free roam): the district under the car and how much the player smashed. */
  openWorld?: { area: string; smashed: number; topMph: number };
  /** Free roam waypoint set on the city map (render only, m), or the waypoint race's next target: the chip and the minimap point to it. */
  waypoint?: { x: number; z: number };
  /** What the waypoint chip calls it (default Waypoint): the waypoint race says which of how many. */
  waypointLabel?: string;
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
  private nitroPips: HTMLElement[];
  /** What the nitrous bar shows, so its attributes are written only on a change: the stage filling, full stages, the stage burning. */
  private nitroTop = 0;
  private nitroFull = -1;
  private nitroBurn = -1;
  /** Callouts for the style that fills the tank, over the dial cluster; the session feeds them each tick. */
  readonly callouts = new BoostCallouts();
  private tach: HTMLCanvasElement;
  private boostCv: HTMLCanvasElement;
  /** Boost pressure in bar (negative = vacuum), simulated render side with spool lag. */
  private boost = -0.6;
  private boostNeedle = -0.6;
  private lastThrottle = 0;
  private bov = 0;
  private nitroGlow = 0;
  /** Stage whose color the glow takes: the burning one, kept while it fades. */
  private glowStage = 1;
  private map: Minimap;
  private driftEl: HTMLElement;
  private progressFill: HTMLElement;
  private ghostEl: HTMLElement;
  /** Free roam: the HUD card the drone shares (ui/hudCard.ts) on top of the chips, with the district and readouts. */
  private card: HudCard | null = null;
  private zoneEl: HTMLElement;
  private zoneText: HTMLElement;
  private zoneLeft: HTMLElement;
  /** The waypoint chip, its text and its arrow, and the arrow's last angle (rad). */
  private wpEl: HTMLElement;
  private wpText: HTMLElement;
  private wpDir: HTMLElement;
  private wpAngle = NaN;
  private msgTimer = 0;
  private lastCountdown: number | null = null;
  /** A click on the minimap opens the full city map (the session sets this). */
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
        <div class="hud-chip hud-zone"><span class="ic"></span><b class="v"></b><span class="left"><i></i></span></div>
        <div class="hud-chip hud-waypoint"><span class="ic"></span><b class="v"></b><span class="dir"></span></div>
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
        <div class="hud-nitro"><span class="ic"></span><div class="bar"><div class="fill"></div></div><span class="pips">${'<i></i>'.repeat(NITRO_STAGES)}</span></div>
      </div>
    `;
    parent.appendChild(this.root);
    const q = (s: string) => this.root.querySelector(s) as HTMLElement;
    q('.hud-pos .ic').appendChild(icon(Trophy, { size: 16 }));
    q('.hud-lap .ic').appendChild(icon(FlagTriangleRight, { size: 16 }));
    q('.hud-time .ic').appendChild(icon(Timer, { size: 16 }));
    q('.hud-best .ic').appendChild(icon(Award, { size: 16 }));
    q('.hud-ghost .ic').appendChild(icon(Ghost, { size: 16 }));
    q('.hud-zone .ic').appendChild(icon(Disc3, { size: 16 }));
    this.zoneEl = q('.hud-zone');
    this.zoneText = q('.hud-zone .v');
    this.zoneLeft = q('.hud-zone .left i');
    q('.hud-waypoint .ic').appendChild(icon(MapPin, { size: 16 }));
    q('.hud-waypoint .dir').appendChild(icon(Navigation2, { size: 15 }));
    this.wpEl = q('.hud-waypoint');
    this.wpText = q('.hud-waypoint .v');
    this.wpDir = q('.hud-waypoint .dir');
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
    this.nitroPips = [...this.root.querySelectorAll<HTMLElement>('.hud-nitro .pips i')];
    q('.hud-br').append(this.callouts.el);
    this.driftEl = q('.hud-drift');
    this.progressFill = q('.hud-progress .fill');
    this.tach = q('.hud-tach') as HTMLCanvasElement;
    this.boostCv = q('.hud-boost') as HTMLCanvasElement;
    this.map = new Minimap(world);
    this.root.append(this.map.canvas);
    // Clickable in every race and free roam, with a hint (free roam's) that it opens.
    this.map.canvas.title = 'City map (Tab)';
    this.map.canvas.addEventListener('click', () => this.onMapClick?.());
    const hint = document.createElement('div');
    hint.className = 'hud-map-hint';
    hint.append(icon(Compass, { size: 13 }), 'Map · Tab');
    this.root.append(hint);

  }

  /** Puts the HUD card (free roam's) on top of the chips; update() fills it while the world is open. */
  setCard(card: HudCard): void {
    this.card = card;
    this.root.querySelector('.hud-tl')?.prepend(card.el);
  }

  message(text: string, seconds = 2.2): void {
    this.msgEl.textContent = text;
    this.msgEl.classList.add('show');
    this.msgTimer = seconds;
  }

  update(d: HudData, dt: number): void {
    this.root.classList.toggle('open-world', !!d.openWorld);
    this.root.classList.toggle('waypoint-race', d.mode === 'waypoint' && !d.openWorld);
    if (d.openWorld && this.card) {
      this.card.setStatus(d.openWorld.area);
      this.card.setStat(0, formatTime(d.raceTime));
      this.card.setStat(1, String(d.openWorld.smashed));
      this.card.setStat(2, `${Math.round(d.openWorld.topMph)} mph`);
    }
    const racingMode = d.mode !== 'drift';
    this.posEl.textContent = racingMode ? `${d.position}/${d.carCount}` : 'Drift';
    this.lapEl.textContent = d.mode === 'sprint' || d.mode === 'drag' || d.mode === 'waypoint' ? `${Math.round(d.progress * 100)}%` : `${Math.max(1, Math.min(d.lap, d.laps))}/${d.laps}`;
    this.timeEl.textContent = formatTime(d.raceTime);
    this.bestEl.textContent = d.bestLap ? formatTime(d.bestLap) : '--:--.--';
    this.ghostEl.style.display = d.ghost ? '' : 'none';
    this.progressFill.style.width = `${Math.max(0, Math.min(1, d.progress)) * 100}%`;
    this.updateNitro(d);
    this.callouts.update(dt);
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
    this.updateZone(d);
    this.updateWaypoint(d);
    if (d.drift) {
      this.driftEl.style.display = '';
      this.driftEl.innerHTML = `<div class="total">${Math.round(d.drift.total).toLocaleString()}</div>${
        d.drift.current > 0 ? `<div class="cur">+${Math.round(d.drift.current).toLocaleString()} <span>x${d.drift.multiplier}</span>${(d.drift.zoneBonus ?? 0) > 0 ? ' <em>ZONE</em>' : ''}</div>` : ''
      }`;
    } else this.driftEl.style.display = 'none';
    this.drawTach(d);
    this.updateBoost(d, dt);
    this.drawBoost();
    this.drawMap(d);
  }

  /**
   * The nitrous bar: the stage being filled, in its color, over the full
   * stage below it, and a pip per full stage; boosting, it glows in the
   * burning stage's color (hud/_nitro.scss reads the data attributes).
   */
  private updateNitro(d: HudData): void {
    const full = nitroFullStages(d.nitro);
    const top = Math.min(NITRO_STAGES, full + 1);
    this.nitroFill.style.width = `${(full >= NITRO_STAGES ? 1 : Math.max(0, d.nitro - full)) * 100}%`;
    if (top !== this.nitroTop) {
      this.nitroTop = top;
      this.nitroBox.dataset.top = String(top);
    }
    if (full !== this.nitroFull) {
      this.nitroFull = full;
      this.nitroPips.forEach((p, i) => p.classList.toggle('on', i < full));
    }
    const burn = d.nitroActive ? d.nitroStage : 0;
    if (burn !== this.nitroBurn) {
      this.nitroBurn = burn;
      this.nitroBox.dataset.burn = String(burn);
      this.nitroBox.classList.toggle('active', burn > 0);
    }
  }

  /** The drift zone chip: shown while inside one, the bar is the visit's bonus left; a resting zone reads dim. */
  private updateZone(d: HudData): void {
    const z = d.zone;
    this.zoneEl.classList.toggle('show', !!z);
    if (!z) return;
    const text = z.resting ? 'Drift zone · resting' : `Drift zone x${z.mul}${z.nitro ? ' nitro' : ''}`;
    if (this.zoneText.textContent !== text) this.zoneText.textContent = text;
    this.zoneEl.classList.toggle('resting', z.resting || z.left <= 0);
    this.zoneLeft.style.width = `${Math.round(Math.max(0, Math.min(1, z.left)) * 100)}%`;
  }

  /**
   * The waypoint chip: how far, and an arrow turned heading up like the
   * minimap (the waypoint's bearing less the car's heading). Writes the DOM
   * only when the text or the angle changes.
   */
  private updateWaypoint(d: HudData): void {
    const w = d.waypoint;
    const me = w ? d.cars.find((c) => c.isPlayer) : undefined;
    this.wpEl.classList.toggle('show', !!me);
    if (!w || !me) return;
    const dx = w.x - me.x;
    const dz = w.z - me.z;
    const text = `${d.waypointLabel ?? 'Waypoint'} · ${formatDistance(Math.hypot(dx, dz))}`;
    if (this.wpText.textContent !== text) this.wpText.textContent = text;
    const a = Math.atan2(-dx, dz) + me.yaw;
    if (!(Math.abs(Math.atan2(Math.sin(a - this.wpAngle), Math.cos(a - this.wpAngle))) < 0.01)) {
      this.wpAngle = a;
      this.wpDir.style.transform = `rotate(${a.toFixed(3)}rad)`;
    }
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
    // Each nitrous stage spikes it a little harder.
    let target = vacuum + load * (spool * spool * (3 - 2 * spool)) * 1.25 + (d.nitroActive ? 0.55 + 0.1 * (d.nitroStage - 1) : 0);
    if (d.countdown !== null && d.countdown > 0) target = vacuum + load * 0.35 * Math.min(1, r * 1.6);
    // Blow-off valve: lifting sharply at boost dumps the pressure at once.
    if (this.lastThrottle > 0.6 && load < 0.25 && this.boost > 0.35) this.bov = 0.35;
    this.lastThrottle = load;
    this.bov = Math.max(0, this.bov - dt);
    const tau = this.bov > 0 ? 0.05 : target > this.boost ? 0.55 : 0.16;
    this.boost += (target - this.boost) * (1 - Math.exp(-dt / tau));
    this.boostNeedle += (this.boost - this.boostNeedle) * (1 - Math.exp(-dt / 0.05));
    this.nitroGlow += ((d.nitroActive ? 1 : 0) - this.nitroGlow) * (1 - Math.exp(-dt / 0.12));
    if (d.nitroActive && d.nitroStage > 0) this.glowStage = d.nitroStage;
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
    const nitro = INK.nitro[this.glowStage - 1];
    const accent = glow > 0.05 ? INK.text : INK.fill;
    c.clearRect(0, 0, W, W);
    c.lineCap = 'butt';
    c.fillStyle = INK.face;
    c.beginPath();
    c.arc(cx, cy, R + 9, 0, Math.PI * 2);
    c.fill();
    if (glow > 0.01) {
      c.strokeStyle = `rgba(${INK.nitroRgb[this.glowStage - 1]},${0.75 * glow})`;
      c.lineWidth = 3;
      c.shadowColor = nitro;
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
      c.shadowColor = glow > 0.05 ? nitro : INK.fill;
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
    c.fillText(String(Math.round(d.speedMph)), cx, cy + 40);
    c.font = `600 12px ${INK.font}`;
    c.fillStyle = INK.caption;
    c.fillText('MPH', cx, cy + 66);
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
    if (player) this.map.draw({ x: player.x, z: player.z, yaw: player.yaw }, d.cars, d.waypoint);
  }

  dispose(): void {
    this.root.remove();
  }
}
