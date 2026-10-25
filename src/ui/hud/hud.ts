/**
 * Race HUD in plain DOM plus small canvases (the tachometer and speedometer
 * and the boost gauge, both in dials.ts, and the minimap from minimap.ts,
 * which the drone shares). Every mode leads with the HUD card the drone
 * shares (hudCard.ts): free roam's district and readouts, a race's place, lap
 * or progress, time and best in its type's hue; the ghost, drift zone and
 * waypoint chips stand under it (a waypoint race points the way with the
 * compass at the top center instead: an arrow to the player's target). The dial cluster in the bottom right is the
 * tachometer with the speed in it, the boost gauge beside it (a naturally
 * aspirated car has none, so it is hidden and the cluster closes up) and the
 * nitrous gauge under them: one bar where each stage fills in its own color
 * over the full one below, and a pip per full stage, while the callouts over
 * the cluster (boostCallouts.ts) name the style that fills it.
 * Reads a snapshot each frame; never touches the sim.
 */
import type { World } from '../../city/world';
import type { RaceMode } from '../../sim/race';
import { nitroFullStages, nitroTopStage } from '../../sim/car';
import { NITRO_STAGES } from '../../sim/tuning';
import { BoostCallouts } from './boostCallouts';
import { damp } from '../../shared/anim';
import type { Aspiration } from '../../shared/carSpec';
import { clamp01 } from '../../sim/math';
import { BoostGauge, Tachometer } from './dials';
import { TriangleAlert, Zap, Ghost, icon, Disc3, MapPin, Navigation2, RotateCcw, Route, ChevronsRight, MapPinned, Wind, type IconNode } from '../kit/icons';
import { formatTime } from '../kit/format';
import { prefersReducedMotion } from '../kit/dom';
import type { HudCard } from './hudCard';
import type { Help } from '../panels/help';
import type { Hue } from '../rail/rail';
import { MapCar, Minimap } from './minimap';
import { formatDistance } from '../map/places';

export type HudCar = MapCar;

/** Each race type's card: the menu's name and icon (ui/menu/menu.ts TYPE_INFO) in its hue (palette.$modes). */
export const RACE_CARD: Record<RaceMode, { title: string; icon: IconNode; hue: Hue }> = {
  circuit: { title: 'Circuit', icon: RotateCcw, hue: 'orange' },
  sprint: { title: 'Sprint', icon: Route, hue: 'yellow' },
  drag: { title: 'Drag', icon: ChevronsRight, hue: 'purple' },
  waypoint: { title: 'Waypoint', icon: MapPinned, hue: 'cyan' },
  drift: { title: 'Drift', icon: Wind, hue: 'red' },
};

/** The races run point to point: their card reads progress instead of laps. */
const POINT_TO_POINT: ReadonlySet<RaceMode> = new Set(['sprint', 'drag', 'waypoint']);

/**
 * A race card's readouts, in the order Hud.update fills them: place (drift
 * runs solo, so none), lap or how much of the course is behind (short labels:
 * four share a phone's card), time and best. Its own drift score stays on the
 * right.
 */
export function raceReadouts(mode: RaceMode): string[] {
  const along = POINT_TO_POINT.has(mode) ? 'Course' : 'Lap';
  const best = POINT_TO_POINT.has(mode) ? 'Best' : 'Best lap';
  return mode === 'drift' ? [along, 'Time', best] : ['Place', along, 'Time', best];
}

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
  /** Overdrive banked past a full tank, as a share of its cap (0..1). */
  nitroOver: number;
  /** Throttle 0..1, drives the boost gauge (vacuum off throttle). */
  throttle?: number;
  /** The build's launch rpm (the two-step's set point), marked on the tach; missing when off. */
  launchRpm?: number;
  /**
   * The car's engine aspiration (its engine spec in carManifest.json): a naturally aspirated car has no
   * boost to show, so its gauge is hidden; turbo and supercharged cars wear it.
   */
  aspiration: Aspiration;
  /** Turbo cars: the sim's boost (0..1, CarState.boost) drives the gauge instead of the guess from rpm and throttle. */
  boost?: number;
  /** Rolling antilag is holding boost this frame (the boost gauge says so). */
  antilag?: boolean;
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
  private centerEl: HTMLElement;
  private msgEl: HTMLElement;
  private wrongEl: HTMLElement;
  private nitroBox: HTMLElement;
  private nitroBar: HTMLElement;
  private nitroFills: HTMLElement[];
  private nitroPips: HTMLElement[];
  /** What the nitrous gauge shows, so its DOM is written only on a change: each stage's fill (hundredths), the top stage, the full stages, the stage burning, the state. */
  private nitroShown: number[] = Array.from({ length: NITRO_STAGES }, () => -1);
  private nitroTop = -1;
  private nitroFull = -1;
  private nitroBurn = -1;
  private nitroState = '';
  /** Overdrive's strip, its fill shown (hundredths), its data-over level and whether a burn has it. */
  private nitroOverEl: HTMLElement;
  private nitroOverShown = -1;
  private nitroOverLevel = -1;
  private nitroOverBurn = false;
  /** Callouts for the style that fills the tank, over the dial cluster; the session feeds them each tick. */
  readonly callouts = new BoostCallouts();
  /** Antilag is holding boost (the gauge's caption). */
  private antilag = false;
  private tach: Tachometer;
  private boostGauge: BoostGauge;
  private boostCv: HTMLCanvasElement;
  /** The boost gauge is up: the car is turbocharged or supercharged (a naturally aspirated one has none to show). */
  private boostShown = true;
  /** Boost pressure in bar (negative = vacuum), simulated render side with spool lag. */
  private boost = -0.6;
  private boostNeedle = -0.6;
  private lastThrottle = 0;
  private bov = 0;
  private nitroGlow = 0;
  /** Stage whose color the glow takes: the burning one, kept while it fades. */
  private glowStage = 1;
  /** Seconds of HUD time, for the limiter's flash; reduced motion (read live) holds it steady instead of blinking. */
  private clock = 0;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private map: Minimap;
  private driftEl: HTMLElement;
  private progressFill: HTMLElement;
  private ghostEl: HTMLElement;
  /** The HUD card the drone shares (hudCard.ts) on top of the chips: free roam's district or the race's readouts. */
  private card: HudCard | null = null;
  private zoneEl: HTMLElement;
  private zoneText: HTMLElement;
  private zoneLeft: HTMLElement;
  /** The waypoint chip, its text and its arrow, and the arrow's last angle (rad). */
  private wpEl: HTMLElement;
  private wpText: HTMLElement;
  private wpDir: HTMLElement;
  private wpAngle = NaN;
  /** The waypoint race's compass, its label and distance, its arrow, and the arrow's smoothed angle (rad). */
  private compassEl: HTMLElement;
  private compassLabel: HTMLElement;
  private compassDistance: HTMLElement;
  private compassArrow: HTMLElement;
  private compassAngle = NaN;
  private msgTimer = 0;
  private lastCountdown: number | null = null;
  /** A click on the minimap opens the full city map (the session sets this). */
  onMapClick: (() => void) | null = null;

  constructor(parent: HTMLElement, world: World) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud__top-left">
        <div class="hud-chip hud-chip--ghost"><span class="hud-chip__icon"></span><b class="hud-chip__value">Ghost</b></div>
        <div class="hud-chip hud-chip--zone"><span class="hud-chip__icon"></span><b class="hud-chip__value"></b><span class="hud-chip__meter"><i class="hud-chip__meter-fill"></i></span></div>
        <div class="hud-chip hud-chip--waypoint"><span class="hud-chip__icon"></span><b class="hud-chip__value"></b><span class="hud-chip__arrow"></span></div>
      </div>
      <div class="hud__progress"><div class="hud__progress-fill"></div></div>
      <div class="hud-compass"><span class="hud-compass__arrow"></span><span class="hud-compass__label"></span><b class="hud-compass__distance"></b></div>
      <div class="hud__countdown"></div>
      <div class="hud__message"></div>
      <div class="hud__wrong-way"><span class="hud__wrong-way-icon"></span>WRONG WAY</div>
      <div class="drift-score"></div>
      <div class="hud__bottom-right">
        <div class="hud__dials">
          <canvas class="hud__boost" width="120" height="120"></canvas>
          <canvas class="hud__tach" width="220" height="220"></canvas>
        </div>
        <div class="nitro-gauge"><span class="nitro-gauge__icon"></span><span class="nitro-gauge__bar">${'<i class="nitro-gauge__fill"></i>'.repeat(NITRO_STAGES)}<i class="nitro-gauge__over"></i></span><span class="nitro-gauge__pips">${'<i class="nitro-gauge__pip"></i>'.repeat(NITRO_STAGES)}</span></div>
      </div>
    `;
    parent.appendChild(this.root);
    const q = (s: string) => this.root.querySelector(s) as HTMLElement;
    q('.hud-chip--ghost .hud-chip__icon').appendChild(icon(Ghost, { size: 16 }));
    q('.hud-chip--zone .hud-chip__icon').appendChild(icon(Disc3, { size: 16 }));
    this.zoneEl = q('.hud-chip--zone');
    this.zoneText = q('.hud-chip--zone .hud-chip__value');
    this.zoneLeft = q('.hud-chip__meter-fill');
    q('.hud-chip--waypoint .hud-chip__icon').appendChild(icon(MapPin, { size: 16 }));
    q('.hud-chip__arrow').appendChild(icon(Navigation2, { size: 15 }));
    this.wpEl = q('.hud-chip--waypoint');
    this.wpText = q('.hud-chip--waypoint .hud-chip__value');
    this.wpDir = q('.hud-chip__arrow');
    this.compassEl = q('.hud-compass');
    this.compassLabel = q('.hud-compass__label');
    this.compassDistance = q('.hud-compass__distance');
    this.compassArrow = q('.hud-compass__arrow');
    this.compassArrow.appendChild(icon(Navigation2, { size: 44 }));
    q('.hud__wrong-way-icon').appendChild(icon(TriangleAlert, { size: 28 }));
    q('.nitro-gauge__icon').appendChild(icon(Zap, { size: 18 }));
    this.ghostEl = q('.hud-chip--ghost');
    this.centerEl = q('.hud__countdown');
    this.msgEl = q('.hud__message');
    this.wrongEl = q('.hud__wrong-way');
    this.nitroBox = q('.nitro-gauge');
    this.nitroBar = q('.nitro-gauge__bar');
    this.nitroFills = [...this.root.querySelectorAll<HTMLElement>('.nitro-gauge__fill')];
    this.nitroPips = [...this.root.querySelectorAll<HTMLElement>('.nitro-gauge__pip')];
    this.nitroOverEl = q('.nitro-gauge__over');
    q('.hud__bottom-right').append(this.callouts.el);
    this.driftEl = q('.drift-score');
    this.progressFill = q('.hud__progress-fill');
    this.tach = new Tachometer(q('.hud__tach') as HTMLCanvasElement);
    this.boostCv = q('.hud__boost') as HTMLCanvasElement;
    this.boostGauge = new BoostGauge(this.boostCv);
    this.map = new Minimap(world);
    this.root.append(this.map.canvas);
    // Clickable in every race and free roam (the help panel says so, and Tab does the same).
    this.map.canvas.title = 'City map (Tab)';
    this.map.canvas.addEventListener('click', () => this.onMapClick?.());

  }

  /** The help button (ui/panels/help.ts) beside the minimap, with the session's keys and tips. */
  setHelp(help: Help): void {
    this.root.append(help.el);
  }

  /** Puts the HUD card on top of the chips; update() fills its readouts (free roam's, or raceReadouts' for a race). */
  setCard(card: HudCard): void {
    this.card = card;
    this.root.querySelector('.hud__top-left')?.prepend(card.el);
  }

  message(text: string, seconds = 2.2): void {
    this.msgEl.textContent = text;
    this.msgEl.classList.add('is-visible');
    this.msgTimer = seconds;
  }

  update(d: HudData, dt: number): void {
    this.root.classList.toggle('hud--open-world', !!d.openWorld);
    const card = this.card;
    if (card && d.openWorld) {
      card.setStatus(d.openWorld.area);
      card.setStat(0, formatTime(d.raceTime));
      card.setStat(1, String(d.openWorld.smashed));
      card.setStat(2, `${Math.round(d.openWorld.topMph)} mph`);
    } else if (card) {
      // raceReadouts' order: place (not in drift), lap or progress, time, best.
      let i = 0;
      if (d.mode !== 'drift') card.setStat(i++, `${d.position}/${d.carCount}`);
      card.setStat(i++, POINT_TO_POINT.has(d.mode) ? `${Math.round(d.progress * 100)}%` : `${Math.max(1, Math.min(d.lap, d.laps))}/${d.laps}`);
      card.setStat(i++, formatTime(d.raceTime));
      card.setStat(i, d.bestLap ? formatTime(d.bestLap) : '--:--.--');
    }
    this.ghostEl.style.display = d.ghost ? '' : 'none';
    this.progressFill.style.width = `${Math.max(0, Math.min(1, d.progress)) * 100}%`;
    this.updateNitro(d);
    this.callouts.update(dt);
    this.wrongEl.classList.toggle('is-visible', d.wrongWay);

    if (d.countdown !== this.lastCountdown) {
      this.lastCountdown = d.countdown;
      if (d.countdown !== null) {
        this.centerEl.textContent = d.countdown > 0 ? String(d.countdown) : 'GO!';
        this.centerEl.classList.remove('is-popping');
        void this.centerEl.offsetWidth;
        this.centerEl.classList.add('is-popping');
      } else {
        this.centerEl.textContent = '';
      }
    }
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.msgEl.classList.remove('is-visible');
    }
    this.updateZone(d);
    this.updateWaypoint(d, dt);
    if (d.drift) {
      this.driftEl.style.display = '';
      this.driftEl.innerHTML = `<div class="drift-score__total">${Math.round(d.drift.total).toLocaleString()}</div>${
        d.drift.current > 0
          ? `<div class="drift-score__current">+${Math.round(d.drift.current).toLocaleString()} <span class="drift-score__multiplier">x${d.drift.multiplier}</span>${(d.drift.zoneBonus ?? 0) > 0 ? ' <em class="drift-score__zone">ZONE</em>' : ''}</div>`
          : ''
      }`;
    } else this.driftEl.style.display = 'none';
    this.clock += dt;
    this.updateDials(d, dt);
    this.drawMap(d);
  }

  /**
   * The nitrous gauge: one bar where each stage fills in its own color (cyan, purple, then the hot pink
   * red) over the full stage below it, so the color on top is the stage the tank is in and a burn drains
   * it back to the one under it. Each fill slides in from the left (a translate, so its bright leading
   * edge keeps its width); the pips count the full stages, and a stage coming full flashes the bar and pops
   * its pip (skipped under reduced motion). Overdrive is a gold strip along the bar's foot that a full tank
   * spills into, flashing the bar gold when it banks full. _nitro-gauge.scss reads the data attributes.
   * Writes the DOM only when a fill (in hundredths), the top or full stages, the burning stage, overdrive or
   * the state changes.
   */
  private updateNitro(d: HudData): void {
    const full = nitroFullStages(d.nitro);
    const top = nitroTopStage(d.nitro);
    const burn = d.nitroActive ? d.nitroStage : 0;
    for (let i = 0; i < NITRO_STAGES; i++) {
      const fill = Math.round(clamp01(d.nitro - i) * 100);
      if (fill !== this.nitroShown[i]) {
        this.nitroShown[i] = fill;
        this.nitroFills[i].style.transform = `translateX(${fill - 100}%)`;
      }
    }
    if (top !== this.nitroTop) {
      this.nitroTop = top;
      this.nitroBox.dataset.top = String(top);
    }
    if (full !== this.nitroFull) {
      // A stage just came full (not the first draw, not a drain): flash the bar and pop its pip.
      if (this.nitroFull >= 0 && full > this.nitroFull && !prefersReducedMotion()) {
        this.nitroBar.animate([{ filter: 'brightness(2.2)' }, { filter: 'brightness(1)' }], { duration: 520, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
        this.nitroPips[full - 1].animate([{ transform: 'skewX(-14deg) scale(1.9)' }, { transform: 'skewX(-14deg) scale(1)' }], { duration: 420, easing: 'cubic-bezier(0.3, 1.6, 0.5, 1)' });
      }
      this.nitroFull = full;
      this.nitroBox.dataset.full = String(full);
      this.nitroPips.forEach((pip, i) => pip.classList.toggle('is-full', i < full));
    }
    if (burn !== this.nitroBurn) {
      this.nitroBurn = burn;
      this.nitroBox.dataset.burn = String(burn);
      this.nitroFills.forEach((fill, i) => fill.classList.toggle('is-burning', i === burn - 1));
      this.nitroPips.forEach((pip, i) => pip.classList.toggle('is-burning', i === burn - 1));
    }
    const over = Math.round(clamp01(d.nitroOver) * 100);
    if (over !== this.nitroOverShown) {
      this.nitroOverShown = over;
      this.nitroOverEl.style.transform = `translateX(${over - 100}%)`;
    }
    const overLevel = over >= 100 ? 2 : over > 0 ? 1 : 0;
    if (overLevel !== this.nitroOverLevel) {
      if (overLevel === 2 && this.nitroOverLevel >= 0 && !prefersReducedMotion()) {
        this.nitroBar.animate([{ filter: 'brightness(2.6) saturate(1.4)' }, { filter: 'none' }], { duration: 700, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
      }
      this.nitroOverLevel = overLevel;
      this.nitroBox.dataset.over = String(overLevel);
    }
    const overBurn = burn > 0 && over > 0;
    if (overBurn !== this.nitroOverBurn) {
      this.nitroOverBurn = overBurn;
      this.nitroBox.classList.toggle('is-overdrive', overBurn);
    }
    const state = burn > 0 ? 'burning' : d.nitro < 0.02 ? 'empty' : full >= 1 ? 'ready' : 'charging';
    if (state !== this.nitroState) {
      this.nitroState = state;
      this.nitroBox.dataset.state = state;
    }
  }

  /** The drift zone chip: shown while inside one, the bar is the visit's bonus left; a resting zone reads dim. */
  private updateZone(d: HudData): void {
    const z = d.zone;
    this.zoneEl.classList.toggle('is-visible', !!z);
    if (!z) return;
    const text = z.resting ? 'Drift zone · resting' : `Drift zone x${z.mul}${z.nitro ? ' nitro' : ''}`;
    if (this.zoneText.textContent !== text) this.zoneText.textContent = text;
    this.zoneEl.classList.toggle('is-resting', z.resting || z.left <= 0);
    this.zoneLeft.style.width = `${Math.round(Math.max(0, Math.min(1, z.left)) * 100)}%`;
  }

  /**
   * The waypoint chip: how far, and an arrow turned heading up like the
   * minimap (the waypoint's bearing less the car's heading). Writes the DOM
   * only when the text or the angle changes. A waypoint race shows the
   * compass instead, its arrow eased (frame-rate independent) so it swings
   * rather than snaps when the target changes.
   */
  private updateWaypoint(d: HudData, dt: number): void {
    const w = d.waypoint;
    const me = w ? d.cars.find((c) => c.isPlayer) : undefined;
    const race = d.mode === 'waypoint' && !d.openWorld;
    this.wpEl.classList.toggle('is-visible', !!me && !race);
    this.compassEl.classList.toggle('is-visible', !!me && race);
    if (!w || !me) return;
    const dx = w.x - me.x;
    const dz = w.z - me.z;
    if (race) return this.updateCompass(d.waypointLabel ?? 'Waypoint', Math.hypot(dx, dz), Math.atan2(-dx, dz) + me.yaw, dt);
    const text = `${d.waypointLabel ?? 'Waypoint'} · ${formatDistance(Math.hypot(dx, dz))}`;
    if (this.wpText.textContent !== text) this.wpText.textContent = text;
    const a = Math.atan2(-dx, dz) + me.yaw;
    if (!(Math.abs(Math.atan2(Math.sin(a - this.wpAngle), Math.cos(a - this.wpAngle))) < 0.01)) {
      this.wpAngle = a;
      this.wpDir.style.transform = `rotate(${a.toFixed(3)}rad)`;
    }
  }

  /** The compass: what the target is, how far (m), and the arrow toward it (rad, 0 = straight ahead). */
  private updateCompass(label: string, distance: number, a: number, dt: number): void {
    if (this.compassLabel.textContent !== label) this.compassLabel.textContent = label;
    const text = formatDistance(distance);
    if (this.compassDistance.textContent !== text) this.compassDistance.textContent = text;
    const prev = this.compassAngle;
    const delta = Math.atan2(Math.sin(a - prev), Math.cos(a - prev));
    const next = Number.isNaN(prev) ? a : prev + delta * damp(1 / 0.08, dt);
    if (Number.isNaN(prev) || Math.abs(next - prev) > 0.002) {
      this.compassAngle = next;
      this.compassArrow.style.transform = `rotate(${next.toFixed(3)}rad)`;
    }
  }

  /**
   * The dials. The nitrous glow is smoothed here for both (the tachometer wears it on every car); the boost
   * gauge is for turbocharged and supercharged cars only: a naturally aspirated car hides it (the cluster
   * closes up, _hud.scss) and skips its simulation and drawing.
   */
  private updateDials(d: HudData, dt: number): void {
    this.nitroGlow += ((d.nitroActive ? 1 : 0) - this.nitroGlow) * damp(1 / 0.12, dt);
    if (d.nitroActive && d.nitroStage > 0) this.glowStage = d.nitroStage;
    const boosted = d.aspiration !== 'na';
    if (boosted !== this.boostShown) {
      this.boostShown = boosted;
      this.boostCv.hidden = !boosted;
    }
    this.tach.draw(
      { rpm: d.rpm, redline: d.redline, speedMph: d.speedMph, gear: d.gear, manual: d.manual, launchRpm: d.launchRpm ?? 0, glow: this.nitroGlow, glowStage: this.glowStage },
      this.clock,
      this.reducedMotion.matches,
    );
    if (!boosted) return;
    this.updateBoost(d, dt);
    this.boostGauge.draw({ bar: this.boostNeedle, glow: this.nitroGlow, glowStage: this.glowStage, antilag: this.antilag, blowOff: this.bov > 0.1 });
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
    // A turbo car's boost is the sim's: antilag pins it, the two-step builds it at the line.
    if (d.boost !== undefined) target = d.boost >= 0.02 ? d.boost * 1.25 + (d.nitroActive ? 0.55 + 0.1 * (d.nitroStage - 1) : 0) : vacuum;
    this.antilag = d.antilag === true;
    // Blow-off valve: lifting sharply at boost dumps the pressure at once.
    if (this.lastThrottle > 0.6 && load < 0.25 && this.boost > 0.35) this.bov = 0.35;
    this.lastThrottle = load;
    this.bov = Math.max(0, this.bov - dt);
    const tau = this.bov > 0 ? 0.05 : target > this.boost ? 0.55 : 0.16;
    this.boost += (target - this.boost) * damp(1 / tau, dt);
    this.boostNeedle += (this.boost - this.boostNeedle) * damp(1 / 0.05, dt);
  }

  private drawMap(d: HudData): void {
    const player = d.cars.find((x) => x.isPlayer);
    if (player) this.map.draw({ x: player.x, z: player.z, yaw: player.yaw }, d.cars, d.waypoint);
  }

  dispose(): void {
    this.tach.dispose();
    this.boostGauge.dispose();
    this.root.remove();
  }
}
