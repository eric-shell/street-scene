/**
 * Garage UI on the rail (ui/rail/rail.ts), drawn like the main menu's: no column,
 * only a scrim, with the header (back), tabs of live-preview categories and the
 * open tab's groups standing on the scene as plates of their own down the
 * left; beside it the 3D view framed to the free space, with the car card
 * (model, build, spec tags, measured stats, and the Garage / Street switch and
 * camera on its foot) top left and the hold-to-rev button at the bottom. Body part menus are populated
 * entirely from partsCatalog.json. Builds save to localStorage slots and export
 * as share codes. Hidden dev mode (Ctrl+Shift+D or ?dev) accepts a dropped GLB
 * and equips it live in a chosen slot.
 *
 * It speaks the main menu's language (the partials beside this file): chamfered
 * plates, a hue per category (the tab's badge, and the open tab's picks, sliders
 * and section hairlines take it through `data-tab` on the root), spec tags and
 * stat bars in the palette, a sheen on whatever is hovered, and the rail's parts
 * rising in as the roller door rolls up on the garage.
 */
import type { GameRenderer } from '../render/scene';
import { CarAssetLibrary, MANIFEST, manifestCar, partsFor } from '../render/car/carAssets';
import { GarageScene } from './garageScene';
import type { StreetStage } from '../game/streetStage';
import type { Quality } from '../ui/settings';
import { railInset, screenHead } from '../ui/rail/rail';
import { Help, MUSIC_KEYS } from '../ui/panels/help';
import { GaragePrefs, GarageState, MAX_SLOTS, Presentation, addSlot, decodeShareCode, encodeShareCode, freshBuild, importBuild, loadGaragePrefs, saveGaragePrefs, shareUrl } from './storage';
import { BODY_PART_SLOTS, OPTIONAL_SLOTS, PART_SLOTS, PartSlot, SLOT_LABELS } from '../shared/parts';
import { AXLES, Axle, AxleStance, BUILD_NAME_MAX, CarBuild, DEFAULT_BUILD_NAME, DecalLayer, GLOW_PATTERNS, MAX_DECALS, PAINT_FINISHES, STANCE_LIMITS, VINYL_SHAPES, VinylShape, validateBuild } from '../shared/carBuild';
import { DEFAULT_CAR_ID, PERFORMANCE_CATEGORIES, PerformanceCategory, SELECTABLE_CAR_IDS, TIER_NAMES, Tier, getBaseTuning } from '../sim/tuning';
import { tuningForBuild } from '../sim/build';
import { FEATURES } from '../shared/features';
import { specBadges, type SpecBadge } from '../shared/carSpec';
import { measureStats, statBars, type CarStats } from '../sim/stats';
import { SHAPE_LABELS } from '../render/car/decals';
import { btn, chip, h, iconBtn, isTyping, segmented, sheen, toast } from '../ui/kit/dom';
import { door, transitioning } from '../ui/transitions/transitions';
import { KMH_PER_MPH, M_PER_FT } from '../ui/kit/units';
import {
  ArrowUpDown,
  Car,
  Check,
  Copy,
  Disc3,
  Download,
  Eye,
  FlipHorizontal2,
  Gauge,
  Hammer,
  Layers,
  MousePointerClick,
  Paintbrush,
  Plus,
  Save,
  Share2,
  Trash2,
  Upload,
  Wind,
  Wrench,
  Zap,
  Box,
  Sparkles,
  Timer,
  Route,
  Video,
  Warehouse,
  icon,
  IconNode,
} from '../ui/kit/icons';
import { Link2, Link2Off } from 'lucide';

type Tab = 'car' | 'body' | 'paint' | 'wheels' | 'vinyl' | 'stance' | 'tint' | 'glow' | 'perf' | 'share';

const TABS: { id: Tab; label: string; icon: IconNode }[] = [
  { id: 'car', label: 'Car', icon: Car },
  { id: 'body', label: 'Body', icon: Hammer },
  { id: 'paint', label: 'Paint', icon: Paintbrush },
  { id: 'wheels', label: 'Wheels', icon: Disc3 },
  ...(FEATURES.vinyls ? [{ id: 'vinyl' as Tab, label: 'Vinyls', icon: Layers }] : []),
  { id: 'stance', label: 'Stance', icon: ArrowUpDown },
  { id: 'tint', label: 'Tint', icon: Eye },
  { id: 'glow', label: 'Neon', icon: Sparkles },
  { id: 'perf', label: 'Tune', icon: Gauge },
  { id: 'share', label: 'Save', icon: Share2 },
];

/** Each spec tag's ink by its place in specBadges (drivetrain cyan, engine yellow, forced induction red): `.ink-*` in _tune-stat.scss. */
const SPEC_INKS = ['ink-drive', 'ink-engine', 'ink-boost'] as const;

/** A spec tag as a chip in its ink, the long form on hover (car tiles and the car card alike). */
const specChip = (t: SpecBadge, i: number, cls = '') => {
  const c = chip(t.text, undefined, `--ink ${SPEC_INKS[i] ?? ''} ${cls}`);
  c.title = t.title;
  return c;
};

/** Model author shown under a car's name, by manifest `source`. */
const AUTHORS: Record<string, string | undefined> = { icemaan: 'IceMaan', eshell: 'eshell' };

const PERF_ICONS: Record<PerformanceCategory, IconNode> = {
  engine: Wrench,
  turbo: Wind,
  exhaust: Wind,
  transmission: Gauge,
  tires: Disc3,
  suspension: ArrowUpDown,
  brakes: Disc3,
  weight: Box,
  nitrous: Zap,
};

export interface GarageCallbacks {
  onChange(g: GarageState): void;
  onExit(): void;
  /** Settings engine volume 0..1 (garage revs). */
  engineVolume?(): number;
}

/** What the garage shows the car in: the menu's street stage (the Street view) and the graphics tier (the showroom's extras). */
export interface GarageStage {
  street: StreetStage;
  quality: Quality;
}

/** A label from a lower case id: "metallic" reads "Metallic". */
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Measured stats per car and performance build: measuring drives the sim for up to a minute of game time. */
const statsCache = new Map<string, CarStats>();
function statsFor(b: CarBuild): CarStats {
  const key = `${b.carId}:${PERFORMANCE_CATEGORIES.map((c) => b.performance[c]).join('')}`;
  let st = statsCache.get(key);
  if (!st) statsCache.set(key, (st = measureStats(tuningForBuild(b.carId, b.performance))));
  return st;
}

/**
 * The measured stats the car card and the Tune tab show, in order, each bar in
 * its ink (`.ink-*` in _tune-stat.scss). The card names the measure, the Tune
 * tab the quality (with an icon), so its acceleration value says what was timed.
 */
const STATS: readonly { ink: string; bar: keyof ReturnType<typeof statBars>; card: string; tune: string; icon: IconNode; value: (s: CarStats, onTune: boolean) => string }[] = [
  { ink: 'speed', bar: 'topSpeed', card: 'Top speed', tune: 'Top speed', icon: Gauge, value: (s) => `${Math.round(s.topSpeed / KMH_PER_MPH)} mph` },
  { ink: 'accel', bar: 'acceleration', card: '0-60', tune: 'Acceleration', icon: Timer, value: (s, onTune) => `${onTune ? '0-60 ' : ''}${s.zeroTo60.toFixed(2)} s` },
  { ink: 'grip', bar: 'handling', card: 'Grip', tune: 'Handling', icon: Disc3, value: (s) => `${s.grip.toFixed(2)} g` },
  { ink: 'nitrous', bar: 'nitrous', card: 'Nitrous', tune: 'Nitrous', icon: Zap, value: (s) => `${s.nitrous.toFixed(1)} kN·s` },
];

/** Keys that hold the gas in the garage. */
const GAS_KEYS = ['KeyW', 'ArrowUp', 'Space'];

// ---------------------------------------------------------------------------
// The tabs' controls
// ---------------------------------------------------------------------------

type Child = Node | false | null;

/**
 * A group: a plate with the tab's hue on its hairline, a section title (the
 * menu cards' yellow caps over a hairline) and its controls. Icons are for the
 * tabs only.
 */
const section = (label: string, ...children: Child[]) => h('div', { class: 'garage-section' }, h('div', { class: 'section-title' }, label), ...children);

/** A swatch: a chamfered chip of color, marked while it is the color in use. */
function swatch(hex: string, current: string, onPick: (el: HTMLElement) => void): HTMLElement {
  const s = h('button', { type: 'button', class: `garage-swatch${hex.toLowerCase() === current.toLowerCase() ? ' is-selected' : ''}`, style: `--swatch:${hex}`, title: hex, 'aria-label': hex }, sheen());
  s.addEventListener('click', () => onPick(s));
  return s;
}

function color(value: string, onInput: (c: string) => void): HTMLInputElement {
  const el = h('input', { type: 'color', value }) as HTMLInputElement;
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

/** A row in a group: the name on the left, its control on the right (the settings' rows). */
const field = (label: string, control: Node) => h('div', { class: 'garage-row' }, h('span', { class: 'garage-row__name' }, label), control);

function slider(label: string, value: number, min: number, max: number, step: number, fmt: (x: number) => string, onInput: (x: number) => void): HTMLElement {
  const out = h('span', { class: 'garage-value' }, fmt(value));
  const el = h('input', { type: 'range', min, max, step, value }) as HTMLInputElement;
  el.addEventListener('input', () => {
    const x = Number(el.value);
    out.textContent = fmt(x);
    onInput(x);
  });
  return h('div', { class: 'garage-slider' }, h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', {}, label), out), el);
}

/** One pick in a list: its name, a sub line, and spec tags (drivetrain code, engine) on their own row, each in its ink. */
interface Choice<T> {
  value: T;
  label: string;
  sub?: string;
  tags?: SpecBadge[];
  /** Extra content after the label (a layer's color dot). */
  extra?: Node;
}

/** A list of picks, the current one marked; a click marks it and calls onPick. */
function choiceList<T extends string | number | null>(items: Choice<T>[], current: T, onPick: (x: T) => void): HTMLElement {
  const list = h('div', { class: 'garage-list' });
  for (const it of items) {
    // Hover a spec tag for its long form.
    const tags = it.tags?.length ? h('span', { class: 'garage-item__tags' }, ...it.tags.map((t, i) => specChip(t, i, '--small'))) : null;
    const el = h(
      'button',
      { type: 'button', class: `garage-item${it.value === current ? ' is-selected' : ''}${tags ? ' garage-item--car' : ''}` },
      h('span', { class: 'garage-item__label' }, it.label),
      it.sub ? h('span', { class: 'garage-item__sub muted' }, it.sub) : null,
      it.extra ?? null,
      tags,
      sheen(),
    );
    el.addEventListener('click', () => {
      list.querySelectorAll('.garage-item').forEach((x) => x.classList.remove('is-selected'));
      el.classList.add('is-selected');
      onPick(it.value);
    });
    list.append(el);
  }
  return list;
}

/** Slider readouts: a length (m) in cm, a factor as a percent. */
const cm =(x: number) => `${Math.round(x * 100)} cm`;
const percent = (x: number) => `${Math.round(x * 100)}%`;

export class GarageScreen {
  private scene: GarageScene;
  private root: HTMLElement;
  private body: HTMLElement;
  private tabBar: HTMLElement;
  private tab: Tab = 'car';
  private saveTimer = 0;
  private selectedDecal = -1;
  private placing: { shape: VinylShape; index: number } | null = null;
  private devMode = new URLSearchParams(location.search).has('dev');
  private abort = new AbortController();
  private pointerDown: { x: number; y: number } | null = null;
  private prefs: GaragePrefs = loadGaragePrefs();
  private gasKeys = new Set<string>();
  private gasPointer = false;
  private tabInTimer = 0;
  /** The roller door is running for a Garage / Street switch. */
  private switching = false;
  /** The car the card last showed, so only a new car (not every slider step) animates the card. */
  private cardCar = '';
  /** The Garage / Street switch and camera on the car card's foot, built once so its pick survives the card's rebuilds. */
  private readonly stageEl: HTMLElement;
  /** The garage's keys and tips behind the ? in the corner (C is a button there too, for touch screens). */
  private readonly help = new Help({
    title: 'Garage',
    sections: () => [
      {
        title: 'Keys',
        keys: [
          { keys: ['Drag'], label: 'Orbit the car' },
          { keys: ['W', '↑', 'Space'], label: 'Hold to rev' },
          { keys: ['C'], label: 'Next camera angle', action: () => this.nextCamera() },
          { keys: ['Esc'], label: 'Back to the menu' },
        ],
      },
      { title: 'Music', keys: MUSIC_KEYS },
      {
        title: 'Tips',
        tips: ['Every change saves to this build as you go; Save keeps builds in slots and shares them as a code.', 'Garage / Street on the car card shows the car on the turntable or out on the event street.'],
      },
    ],
  });
  /** Watches the roller door for the moment it starts rolling up (arrive). */
  private doorWatch: MutationObserver | null = null;
  private arriveTimer = 0;

  constructor(
    gr: GameRenderer,
    private readonly assets: CarAssetLibrary,
    private readonly uiRoot: HTMLElement,
    private garage: GarageState,
    private readonly availability: Record<string, boolean>,
    private readonly cb: GarageCallbacks,
    stage: GarageStage,
  ) {
    this.scene = new GarageScene(gr, assets, stage.street, stage.quality);
    this.tabBar = h('div', { class: 'garage__tabs', role: 'tablist', 'aria-label': 'Categories' });
    this.body = h('div', { class: 'garage__body' });
    this.stageEl = this.stageBar();
    this.root = h(
      'div',
      { class: 'garage rail' },
      h('div', { class: 'rail__bg', 'aria-hidden': 'true' }),
      h('div', { class: 'rail__edge', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'garage__panel' },
        screenHead({ icon: Wrench, title: 'Garage', back: () => this.exit(), backLabel: 'Back to menu (Esc)' }),
        this.tabBar,
        this.body,
      ),
      this.help.el,
      this.carCard,
      this.gasButton(),
    );
    uiRoot.append(this.root);
    // Toasts (camera angle, saved builds) rise above the rev button while the garage is open.
    document.body.classList.add('is-garage-open');
    // The 3D view centers on the space beside the rail (or above the sheet on a phone).
    const frame = () => {
      const inset = railInset(this.root);
      gr.setFraming(inset.left, inset.bottom);
    };
    frame();
    this.scene.setPresentation(this.prefs.presentation);
    this.scene.setEngineVolume(cb.engineVolume?.() ?? 0.7);
    this.configureEngine();
    // A tile per category: its icon on a badge in the category's hue (_garage.scss keys the hue on data-tab).
    for (const t of TABS) {
      const b = h(
        'button',
        { class: 'garage-tab', type: 'button', role: 'tab', 'aria-selected': 'false', title: t.label, onclick: () => this.setTab(t.id) },
        h('span', { class: 'garage-tab__badge' }, icon(t.icon, { size: 17 })),
        h('span', { class: 'garage-tab__label' }, t.label),
        sheen(),
      );
      b.dataset.tab = t.id;
      this.tabBar.append(b);
    }
    this.setTab('car');
    this.updateCarCard();
    void this.scene.setCar(this.build.carId, this.build.visual);
    this.arrive();

    const o = { signal: this.abort.signal };
    window.addEventListener('resize', frame, o);
    // Escape goes back to the menu and C cycles the camera (not while typing or with a dialog up).
    window.addEventListener(
      'keydown',
      (e) => {
        if (isTyping(e) || e.repeat) return;
        if (this.uiRoot.querySelector('.screen')) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          this.exit();
        } else if (e.code === 'KeyC' && !e.ctrlKey && !e.metaKey && !e.altKey) this.nextCamera();
      },
      o,
    );
    // Vinyl placement by clicking on the car (a click, not a drag).
    gr.canvas.addEventListener('pointerdown', (e) => (this.pointerDown = { x: e.clientX, y: e.clientY }), o);
    gr.canvas.addEventListener(
      'pointerup',
      (e) => {
        const d = this.pointerDown;
        this.pointerDown = null;
        if (!d || !this.placing || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
        const hit = this.scene.pick(e.clientX, e.clientY);
        if (!hit) return toast('Click on the painted body', MousePointerClick);
        this.placeDecal(hit.pos, hit.normal);
      },
      o,
    );
    // Engine audio may only start after a user gesture.
    const unlock = () => this.scene.unlockAudio();
    window.addEventListener('pointerdown', unlock, { ...o, capture: true });
    window.addEventListener('keydown', unlock, { ...o, capture: true });
    // Hold W / Up / Space to rev (not while typing in a field, and not the arrows the pad sends to move around the screen: input/padNav.ts).
    window.addEventListener(
      'keydown',
      (e) => {
        if (!e.isTrusted || !GAS_KEYS.includes(e.code) || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        this.gasKeys.add(e.code);
        this.updateGas();
      },
      o,
    );
    window.addEventListener(
      'keyup',
      (e) => {
        if (!this.gasKeys.delete(e.code)) return;
        e.preventDefault();
        this.updateGas();
      },
      o,
    );
    window.addEventListener(
      'blur',
      () => {
        this.gasKeys.clear();
        this.gasPointer = false;
        this.updateGas();
      },
      o,
    );
    // Hidden dev mode: drag and drop a GLB to preview it in a slot.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'KeyD' && e.ctrlKey && e.shiftKey) {
          this.devMode = !this.devMode;
          toast(this.devMode ? 'Dev mode: drop a .glb part onto the window' : 'Dev mode off', Upload);
          this.root.classList.toggle('is-dev', this.devMode);
        }
      },
      o,
    );
    window.addEventListener('dragover', (e) => this.devMode && e.preventDefault(), o);
    window.addEventListener(
      'drop',
      (e) => {
        if (!this.devMode) return;
        e.preventDefault();
        const file = e.dataTransfer?.files[0];
        if (file && file.name.toLowerCase().endsWith('.glb')) void this.devDrop(file);
        else toast('Drop a .glb file', Upload);
      },
      o,
    );
    this.root.classList.toggle('is-dev', this.devMode);
  }

  private get build(): CarBuild {
    return this.garage.slots[this.garage.current];
  }

  /**
   * The garage opens behind the roller door (ui/transitions/transitions.ts), so its parts
   * wait, paused on their first frame, until the door starts rolling up, then
   * rise in a beat apart as it clears them (`.garage.is-arriving` in _garage.scss). With no
   * door down (a deep link, reduced motion's fade) they go at once. A fallback
   * releases them in case the door never reports, so nothing stays hidden.
   */
  private arrive(): void {
    const root = this.root;
    const go = () => {
      this.doorWatch?.disconnect();
      this.doorWatch = null;
      clearTimeout(this.arriveTimer);
      root.classList.remove('is-held');
      // Off again once the last part has landed, so later re-renders stay still.
      this.arriveTimer = window.setTimeout(() => root.classList.remove('is-arriving'), 1600);
    };
    root.classList.add('is-arriving');
    const overlay = document.querySelector('.door');
    if (!overlay || overlay.classList.contains('is-opening')) return go();
    root.classList.add('is-held');
    this.doorWatch = new MutationObserver(() => {
      if (overlay.classList.contains('is-opening')) go();
    });
    this.doorWatch.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    this.arriveTimer = window.setTimeout(go, 6000);
  }

  /** The car card over the 3D view: model, build name, spec tags, the measured stats and the stage switch. */
  private readonly carCard = h('div', { class: 'car-card', 'aria-live': 'polite' });

  private updateCarCard(): void {
    const b = this.build;
    const car = manifestCar(b.carId);
    const st = statsFor(b);
    const bars = statBars(st);
    this.carCard.replaceChildren(
      h('div', { class: 'label label--kicker' }, icon(Car, { size: 14 }), AUTHORS[car.source] ? `By ${AUTHORS[car.source]}` : 'Car'),
      h('h2', { class: 'car-card__name' }, car.displayName),
      h('div', { class: 'car-card__build' }, `"${b.name}"`),
      h('div', { class: 'car-card__tags' }, ...specBadges(car.engine, getBaseTuning(b.carId).drivetrain.layout).map((t, i) => specChip(t, i))),
      // The values stay yellow; each bar takes its stat's ink.
      h(
        'div',
        { class: 'car-card__stats' },
        ...STATS.map((t) =>
          h('div', { class: `car-card__stat ink-${t.ink}` }, h('span', { class: 'car-card__stat-name' }, t.card), h('span', { class: 'stat-bar' }, h('span', { class: 'stat-bar__fill', style: `width:${bars[t.bar] * 100}%` })), h('span', { class: 'car-card__stat-value' }, t.value(st, false))),
        ),
      ),
      this.stageEl,
    );
    // A new car on the turntable deals its card in again; edits to the same car (names, sliders) rebuild
    // the card still, so the class only stays for the render that brought the new car.
    const fresh = this.cardCar !== '' && this.cardCar !== b.carId;
    this.cardCar = b.carId;
    this.carCard.classList.remove('is-swapping');
    if (!fresh) return;
    void this.carCard.offsetWidth;
    this.carCard.classList.add('is-swapping');
  }

  private nextCamera(): void {
    toast(`Camera: ${this.scene.setCamera()}`, Video);
  }

  /** Presentation toggle (the showroom's turntable or the street) and camera angles: the car card's foot. */
  private stageBar(): HTMLElement {
    return h(
      'div',
      { class: 'car-card__stage' },
      segmented<Presentation>(
        [
          { value: 'garage', label: 'Garage', icon: Warehouse },
          { value: 'street', label: 'Street', icon: Route },
        ],
        this.prefs.presentation,
        (p) => {
          this.prefs.presentation = p;
          saveGaragePrefs(this.prefs);
          this.applyPresentation();
        },
      ),
      iconBtn(Video, 'Next camera angle (C)', () => this.nextCamera(), '--small'),
    );
  }

  /**
   * Show the picked presentation behind the roller door: it comes down on one
   * view and rolls up on the other. A pick made while the door runs is shown
   * by one more pass once it is up, so the switch and the view always agree.
   */
  private applyPresentation(): void {
    if (this.switching || transitioning() || this.scene.presentation === this.prefs.presentation) return;
    this.switching = true;
    void door(this.prefs.presentation === 'street' ? 'Street' : 'Garage', () => {
      this.scene.setPresentation(this.prefs.presentation);
      this.configureEngine();
    }).finally(() => {
      this.switching = false;
      this.applyPresentation();
    });
  }

  /** Hold to rev. Pointer events so mouse, pen and touch all work; the key works too. */
  private gasButton(): HTMLElement {
    // A primary action: the bright sheen on hover, and a sweep after sweep while it is held (_rev-button.scss).
    const b = h('button', { class: 'btn rev-button', type: 'button', title: 'Hold to rev (W, Up or Space)', 'aria-label': 'Rev the engine' }, icon(Gauge, { size: 20 }), h('span', {}, 'Hold to rev'), sheen());
    const release = () => {
      this.gasPointer = false;
      this.updateGas();
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      this.scene.unlockAudio();
      this.gasPointer = true;
      this.updateGas();
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, release);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    this.gasEl = b;
    return b;
  }

  private gasEl: HTMLElement | null = null;

  private updateGas(): void {
    const on = this.gasPointer || this.gasKeys.size > 0;
    this.scene.setGas(on ? 1 : 0);
    this.gasEl?.classList.toggle('is-revving', on);
  }

  /** Idle and redline of the current build feed the garage rev model. */
  private configureEngine(): void {
    const e = tuningForBuild(this.build.carId, this.build.performance).engine;
    this.scene.setEngine(e.idleRpm, e.redline);
  }

  private setTab(t: Tab): void {
    const switched = t !== this.tab;
    this.tab = t;
    this.placing = null;
    this.tabBar.querySelectorAll<HTMLElement>('.garage-tab').forEach((b) => {
      const on = b.dataset.tab === t;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-selected', String(on));
    });
    // The open tab's hue colors its picks, sliders and section hairlines (_garage.scss keys it on data-tab).
    this.root.dataset.tab = t;
    this.renderTab();
    if (!switched) return;
    this.body.scrollTop = 0;
    // A new tab's controls cascade in; the class goes again so re-renders within the tab stay still.
    this.body.classList.remove('is-switching');
    void this.body.offsetWidth;
    this.body.classList.add('is-switching');
    clearTimeout(this.tabInTimer);
    this.tabInTimer = window.setTimeout(() => this.body.classList.remove('is-switching'), 600);
  }

  /** Apply the current build to the preview and save (debounced). Resolves when the preview is up to date. */
  private changed(rerender = false): Promise<unknown> {
    const ready = this.scene.setCar(this.build.carId, this.build.visual);
    this.configureEngine();
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.cb.onChange(this.garage), 250);
    if (rerender) this.renderTab();
    this.updateCarCard();
    return ready;
  }

  private renderTab(): void {
    // A re-render within the tab (a tier picked, a slot added) keeps the scroll; emptying the body would reset it.
    const scroll = this.body.scrollTop;
    this.renderTabContent();
    this.body.scrollTop = scroll;
  }

  private renderTabContent(): void {
    this.body.replaceChildren();
    const b = this.build;
    const v = b.visual;
    // Rim size steps in whole inches once the wheel is measured; the build keeps the size factor, so the
    // slider converts both ways (the inches a factor gives depend on the car and the wheel model).
    const car = this.scene.car?.wheelsReady ? this.scene.car : null;
    const id = (x: number) => x;
    // Per axle sliders. While front and rear are linked, moving one moves its partner too.
    const partners = new Map<string, { el: HTMLInputElement; out: HTMLElement; fmt: (x: number) => string; toUi: (x: number) => number }>();
    const axleSlider = (axle: Axle, key: keyof AxleStance, short = false) => {
      const L = STANCE_LIMITS[key];
      const spec = {
        camber: { label: 'Camber', min: L[0], max: L[1], step: 0.5, fmt: (x: number) => `${x}°`, toUi: id, fromUi: id },
        offset: { label: 'Wheel offset', min: L[0], max: L[1], step: 0.005, fmt: cm, toUi: id, fromUi: id },
        wheelSize: car
          ? (() => {
              const min = Math.ceil(car.rimInches(L[0]) - 1e-6);
              const max = Math.floor(car.rimInches(L[1]) + 1e-6);
              return { label: 'Rim size', min, max, step: 1, fmt: (x: number) => `${x} in`, toUi: (x: number) => Math.max(min, Math.min(max, Math.round(car.rimInches(x)))), fromUi: (x: number) => car.rimSizeForInches(x) };
            })()
          : { label: 'Rim size', min: L[0], max: L[1], step: 0.01, fmt: percent, toUi: id, fromUi: id },
      }[key];
      const label = short ? spec.label : `${axle === 'front' ? 'Front' : 'Rear'}`;
      const el = slider(label, spec.toUi(v.stance[axle][key]), spec.min, spec.max, spec.step, spec.fmt, (ui) => {
        const x = spec.fromUi(ui);
        v.stance[axle][key] = x;
        if (this.prefs.linkAxles) {
          const other: Axle = axle === 'front' ? 'rear' : 'front';
          v.stance[other][key] = x;
          const p = partners.get(`${other}.${key}`);
          if (p) {
            p.el.value = String(p.toUi(x));
            p.out.textContent = p.fmt(p.toUi(x));
          }
        }
        this.changed();
      });
      partners.set(`${axle}.${key}`, { el: el.querySelector('input') as HTMLInputElement, out: el.querySelector('.garage-value') as HTMLElement, fmt: spec.fmt, toUi: spec.toUi });
      return el;
    };

    switch (this.tab) {
      case 'car': {
        const nameInput = h('input', { type: 'text', value: b.name, maxlength: BUILD_NAME_MAX, style: 'width:100%' }) as HTMLInputElement;
        nameInput.addEventListener('input', () => {
          b.name = nameInput.value.slice(0, BUILD_NAME_MAX) || DEFAULT_BUILD_NAME;
          this.changed();
        });
        // Only real, imported cars; a disabled tile at the end promises more.
        const imported = MANIFEST.cars.filter((c) => SELECTABLE_CAR_IDS.includes(c.id) && this.availability[c.id] !== false);
        const cars = imported.length ? imported : MANIFEST.cars.filter((c) => SELECTABLE_CAR_IDS.includes(c.id));
        const list = choiceList(
          cars.map((c) => ({ value: c.id, label: c.displayName, sub: AUTHORS[c.source], tags: specBadges(c.engine, getBaseTuning(c.id).drivetrain.layout) })),
          b.carId,
          (id) => {
            if (id === b.carId) return;
            b.carId = id;
            // Parts are per car; wheels are universal and stay.
            const wheels = v.parts.wheels;
            v.parts = wheels ? { wheels } : {};
            v.decals = [];
            // Say hello: a short blip of the new car's engine (and the body rocks with it).
            void this.changed().then(() => this.scene.blip());
          },
        );
        const soon = h('div', { class: 'garage-item garage-item--soon', 'aria-disabled': 'true', title: 'More models coming soon' }, h('span', { class: 'garage-item__label' }, 'More models soon'), h('span', { class: 'garage-item__sub muted' }, 'Coming soon'));
        soon.addEventListener('click', () => toast('More cars are on the way', Car));
        list.append(soon);
        this.body.append(section('Build name', nameInput), section('Car', list));
        break;
      }
      case 'body': {
        for (const slot of ['body' as PartSlot, ...BODY_PART_SLOTS]) {
          const parts = partsFor(b.carId, slot);
          const optional = OPTIONAL_SLOTS.includes(slot);
          const items: { value: string | null; label: string; sub?: string }[] = [{ value: null, label: optional ? 'None' : 'Stock' }, ...parts.map((p) => ({ value: p.id, label: p.displayName, sub: `${p.tris} tris` }))];
          const dev = [...this.assets.devParts.entries()].filter(([, d]) => d.slot === slot).map(([id, d]) => ({ value: id, label: d.name, sub: 'Dev preview' }));
          items.push(...dev);
          this.body.append(
            section(
              SLOT_LABELS[slot],
              items.length > 1
                ? choiceList(items, v.parts[slot] ?? null, (id) => {
                    v.parts[slot] = id;
                    this.changed();
                  })
                : h('div', { class: 'muted garage-note garage-note--empty' }, slot === 'body' ? 'Only the stock body for this car.' : 'No parts for this slot yet. See docs/partsAuthoring.md to add one.'),
            ),
          );
        }
        break;
      }
      case 'paint': {
        const presets = ['#d11f3f', '#ff6a00', '#ffcc1f', '#3dff9a', '#19e6ff', '#1f6bff', '#8b3dff', '#ff3df2', '#f2f2f2', '#9aa3ad', '#2a2c33', '#0b0b0d'];
        const sw = h('div', { class: 'garage-swatches' });
        const picker = color(v.paint.color, (c) => {
          v.paint.color = c;
          this.changed();
        });
        for (const p of presets) {
          sw.append(
            swatch(p, v.paint.color, (s) => {
              v.paint.color = p;
              picker.value = p;
              sw.querySelectorAll('.garage-swatch').forEach((x) => x.classList.toggle('is-selected', x === s));
              this.changed();
            }),
          );
        }
        // A color from the picker is no preset: no swatch stays marked.
        picker.addEventListener('input', () => sw.querySelectorAll('.garage-swatch.is-selected').forEach((x) => x.classList.remove('is-selected')));
        this.body.append(
          section('Body color', h('div', { class: 'row' }, picker, sw)),
          section(
            'Finish',
            segmented(
              PAINT_FINISHES.map((f) => ({ value: f, label: capital(f) })),
              v.paint.finish,
              (f) => {
                v.paint.finish = f;
                this.changed();
              },
            ),
          ),
          section(
            'Trim color',
            color(v.trimColor, (c) => {
              v.trimColor = c;
              this.changed();
            }),
          ),
        );
        break;
      }
      case 'wheels': {
        const wheels = partsFor(b.carId, 'wheels');
        this.body.append(
          section(
            'Rims',
            choiceList(
              wheels.map((p) => ({ value: p.id, label: p.displayName, sub: `${p.tris} tris` })),
              v.parts.wheels ?? manifestCar(b.carId).defaultWheel,
              (id) => {
                v.parts.wheels = id;
                // Each wheel model has its own rim profile: re-render so the inch range fits the new one.
                void this.changed().then(() => this.tab === 'wheels' && this.renderTab());
              },
            ),
          ),
          section('Rim size', this.linkToggle(), ...AXLES.map((a) => axleSlider(a, 'wheelSize')), h('div', { class: 'muted garage-note' }, 'Bigger rims, thinner sidewalls: the tire keeps its outer size.')),
          // Wheel color has its own link: one picker while linked, front and rear pickers when not.
          this.prefs.linkWheelColor
            ? section(
                'Wheel color',
                this.colorLinkToggle(),
                color(v.wheels.color, (c) => {
                  v.wheels.color = v.wheels.rearColor = c;
                  this.changed();
                }),
              )
            : section(
                'Wheel color',
                this.colorLinkToggle(),
                field(
                  'Front',
                  color(v.wheels.color, (c) => {
                    v.wheels.color = c;
                    this.changed();
                  }),
                ),
                field(
                  'Rear',
                  color(v.wheels.rearColor, (c) => {
                    v.wheels.rearColor = c;
                    this.changed();
                  }),
                ),
              ),
        );
        break;
      }
      case 'vinyl':
        this.renderVinyls();
        break;
      case 'stance': {
        const s = v.stance;
        const L = STANCE_LIMITS;
        this.body.append(
          section(
            'Stance (visual only)',
            slider('Ride height', s.rideHeight, L.rideHeight[0], L.rideHeight[1], 0.005, cm, (x) => {
              s.rideHeight = x;
              this.changed();
            }),
            this.linkToggle(),
          ),
          ...AXLES.map((a) => section(a === 'front' ? 'Front' : 'Rear', ...(['camber', 'offset', 'wheelSize'] as const).map((k) => axleSlider(a, k, true)))),
        );
        break;
      }
      case 'tint': {
        this.body.append(
          section(
            'Window tint',
            slider('Darkness', v.tint.darkness, 0, 0.95, 0.01, percent, (x) => {
              v.tint.darkness = x;
              this.changed();
            }),
            field(
              'Tint color',
              color(v.tint.color, (c) => {
                v.tint.color = c;
                this.changed();
              }),
            ),
          ),
        );
        break;
      }
      case 'glow': {
        const g = v.underglow;
        this.body.append(
          section(
            'Underglow',
            segmented(
              [
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On' },
              ],
              g.enabled ? 'on' : 'off',
              (x) => {
                g.enabled = x === 'on';
                this.changed();
              },
            ),
          ),
          section(
            'Colors',
            h(
              'div',
              { class: 'row' },
              h('span', {}, 'Primary'),
              color(g.color, (c) => {
                g.color = c;
                g.enabled = true;
                this.changed();
              }),
              h('span', {}, 'Secondary'),
              color(g.color2, (c) => {
                g.color2 = c;
                this.changed();
              }),
            ),
            h(
              'div',
              { class: 'garage-swatches' },
              ...['#00e5ff', '#ff3df2', '#7cff4f', '#ffe14d', '#ff2e5b', '#7a5cff', '#ffffff', '#ff8a00'].map((p) =>
                swatch(p, g.color, () => {
                  g.color = p;
                  g.enabled = true;
                  this.changed(true);
                }),
              ),
            ),
          ),
          section(
            'Pattern',
            segmented(
              GLOW_PATTERNS.map((p) => ({ value: p, label: capital(p) })),
              g.pattern,
              (p) => {
                g.pattern = p;
                g.enabled = true;
                this.changed();
              },
            ),
            h('div', { class: 'muted garage-note' }, 'Alternate and chase use both colors.'),
          ),
          section(
            'Glow',
            slider('Brightness', g.brightness, 0.2, 2, 0.05, percent, (x) => {
              g.brightness = x;
              this.changed();
            }),
            slider('Speed', g.speed, 0.25, 3, 0.05, (x) => `${x.toFixed(2)}x`, (x) => {
              g.speed = x;
              this.changed();
            }),
            slider('Spread', g.size, 0.6, 1.6, 0.05, percent, (x) => {
              g.size = x;
              this.changed();
            }),
          ),
        );
        break;
      }
      case 'perf':
        this.renderPerformance();
        break;
      case 'share':
        this.renderShare();
        break;
    }
  }

  /** "Link front and rear" convenience toggle for the per axle sliders. */
  private linkToggle(): HTMLElement {
    const linked = this.prefs.linkAxles;
    return btn(
      linked ? Link2 : Link2Off,
      linked ? 'Front and rear linked' : 'Front and rear separate',
      () => {
        this.prefs.linkAxles = !linked;
        saveGaragePrefs(this.prefs);
        if (this.prefs.linkAxles) {
          // Linking starts from matching axles: the rear takes the front's settings.
          const s = this.build.visual.stance;
          s.rear = { ...s.front };
          this.changed();
          toast('Rear now matches front', Link2);
        }
        this.renderTab();
      },
      `--small garage-link${linked ? ' --primary' : ''}`,
    );
  }

  /** Link toggle for the wheel color, separate from the stance link so sizes and colors can split independently. */
  private colorLinkToggle(): HTMLElement {
    const linked = this.prefs.linkWheelColor;
    return btn(
      linked ? Link2 : Link2Off,
      linked ? 'Front and rear same color' : 'Front and rear colors separate',
      () => {
        this.prefs.linkWheelColor = !linked;
        saveGaragePrefs(this.prefs);
        if (this.prefs.linkWheelColor) {
          const w = this.build.visual.wheels;
          w.rearColor = w.color;
          this.changed();
          toast('Rear wheels now match front', Link2);
        }
        this.renderTab();
      },
      `--small garage-link${linked ? ' --primary' : ''}`,
    );
  }

  private renderVinyls(): void {
    const v = this.build.visual;
    const full = v.decals.length >= MAX_DECALS;
    const shapes = h('div', { class: 'garage-grid' });
    for (const shape of VINYL_SHAPES) {
      const b = h('button', { type: 'button', class: `garage-item${this.placing?.shape === shape ? ' is-selected' : ''}` }, SHAPE_LABELS[shape], sheen());
      if (full) b.setAttribute('disabled', '');
      b.addEventListener('click', () => {
        this.placing = { shape, index: -1 };
        this.renderTab();
        toast('Click on the car to place the vinyl', MousePointerClick);
      });
      shapes.append(b);
    }
    this.body.append(section(`Add vinyl (${v.decals.length}/${MAX_DECALS})`, shapes, this.placing ? h('div', { class: 'garage-note' }, icon(MousePointerClick, { size: 14 }), 'Click on the painted body to place it') : null));
    if (!v.decals.length) return;
    const layers = choiceList(
      v.decals.map((d, i) => ({ value: i, label: `${i + 1}. ${SHAPE_LABELS[d.shape]}`, extra: h('span', { class: 'garage-dot', style: `background:${d.color}` }) })),
      this.selectedDecal,
      (i) => {
        this.selectedDecal = i;
        this.renderTab();
      },
    );
    this.body.append(section('Layers', layers));
    const d = v.decals[this.selectedDecal];
    if (!d) return;
    const update = () => this.changed();
    this.body.append(
      section(
        'Selected layer',
        h(
          'div',
          { class: 'row' },
          color(d.color, (c) => {
            d.color = c;
            update();
          }),
          btn(FlipHorizontal2, d.mirror ? 'Mirrored' : 'Mirror', () => {
            d.mirror = !d.mirror;
            update();
            this.renderTab();
          }, `--small garage-toggle${d.mirror ? ' --primary' : ''}`),
          btn(MousePointerClick, 'Move', () => {
            this.placing = { shape: d.shape, index: this.selectedDecal };
            toast('Click on the car to move the vinyl', MousePointerClick);
          }, '--small'),
          iconBtn(Trash2, 'Delete layer', () => {
            v.decals.splice(this.selectedDecal, 1);
            this.selectedDecal = -1;
            this.changed(true);
          }, '--small'),
        ),
        slider('Scale', d.scale, 0.2, 3, 0.05, (x) => `${(x / M_PER_FT).toFixed(1)} ft`, (x) => {
          d.scale = x;
          update();
        }),
        slider('Rotation', d.rotation, -180, 180, 1, (x) => `${x}°`, (x) => {
          d.rotation = x;
          update();
        }),
        d.shape === 'number' &&
          (() => {
            const t = h('input', { type: 'text', value: d.text ?? '7', maxlength: 2, inputmode: 'numeric', style: 'width:70px' }) as HTMLInputElement;
            t.addEventListener('input', () => {
              d.text = t.value.replace(/[^0-9]/g, '').slice(0, 2) || '7';
              update();
            });
            return h('div', { class: 'row' }, h('span', {}, 'Number'), t);
          })(),
      ),
    );
  }

  private placeDecal(pos: [number, number, number], normal: [number, number, number]): void {
    const v = this.build.visual;
    const p = this.placing!;
    if (p.index >= 0 && v.decals[p.index]) {
      v.decals[p.index].pos = pos;
      v.decals[p.index].normal = normal;
    } else {
      if (v.decals.length >= MAX_DECALS) return;
      const layer: DecalLayer = { shape: p.shape, color: '#ffffff', pos, normal, rotation: 0, scale: p.shape === 'stripe' || p.shape === 'twinStripe' ? 1.6 : 0.8, mirror: Math.abs(normal[0]) > 0.6, text: p.shape === 'number' ? '7' : undefined };
      v.decals.push(layer);
      this.selectedDecal = v.decals.length - 1;
    }
    this.placing = null;
    this.changed(true);
  }

  private renderPerformance(): void {
    const b = this.build;
    const stats = statsFor(b);
    const bars = statBars(stats);
    this.body.append(
      section(
        'Stats',
        ...STATS.map((t) =>
          h(
            'div',
            { class: `tune-stat ink-${t.ink}` },
            h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { class: 'label' }, icon(t.icon, { size: 14 }), t.tune), h('span', { class: 'garage-value' }, t.value(stats, true))),
            h('div', { class: 'stat-bar' }, h('div', { class: 'stat-bar__fill', style: `width:${bars[t.bar] * 100}%` })),
          ),
        ),
      ),
    );
    // One group of upgrades, a row per part: its icon and name, then the tiers.
    this.body.append(
      section(
        'Upgrades',
        ...PERFORMANCE_CATEGORIES.map((cat) =>
          h(
            'div',
            { class: 'garage-row garage-row--tier' },
            h('span', { class: 'garage-row__name' }, icon(PERF_ICONS[cat], { size: 15 }), capital(cat)),
            segmented(
              TIER_NAMES.map((n, i) => ({ value: String(i), label: n })),
              String(b.performance[cat]),
              (x) => {
                b.performance[cat] = Number(x) as Tier;
                this.changed(true);
              },
            ),
          ),
        ),
      ),
    );
    this.body.append(h('div', { class: 'muted garage-note' }, 'Everything is unlocked in this proof of concept. Visual parts never change performance.'));
  }

  private renderShare(): void {
    const g = this.garage;
    const list = choiceList(
      g.slots.map((s, i) => ({ value: i, label: s.name, sub: manifestCar(s.carId).displayName })),
      g.current,
      (i) => {
        g.current = i;
        this.changed(true);
      },
    );
    // A new slot is selected at once; with every slot taken nothing changes but the toast.
    const add = (b: CarBuild) => {
      if (!addSlot(g, b)) return toast(`Up to ${MAX_SLOTS} builds`, Save);
      this.changed(true);
    };
    const slotActions = h(
      'div',
      { class: 'row' },
      btn(Plus, 'New', () => add(freshBuild(DEFAULT_CAR_ID, `Build ${g.slots.length + 1}`)), '--small'),
      btn(Copy, 'Duplicate', () => {
        const copy = validateBuild(JSON.parse(JSON.stringify(this.build)));
        copy.name = `${copy.name} copy`.slice(0, BUILD_NAME_MAX);
        add(copy);
      }, '--small'),
      btn(Trash2, 'Delete', () => {
        if (g.slots.length <= 1) return toast('Keep at least one build', Save);
        g.slots.splice(g.current, 1);
        g.current = Math.max(0, g.current - 1);
        this.changed(true);
      }, '--small'),
    );
    const codeOut = h('input', { type: 'text', readonly: true, placeholder: 'Press Export to create a code', style: 'width:100%' }) as HTMLInputElement;
    const importIn = h('input', { type: 'text', placeholder: 'Paste a build code or link', style: 'width:100%' }) as HTMLInputElement;
    this.body.append(
      section('Garage slots', list, slotActions, h('div', { class: 'muted garage-note' }, 'Builds save automatically in this browser.')),
      section(
        'Share',
        codeOut,
        h(
          'div',
          { class: 'row' },
          btn(Download, 'Export', async () => {
            codeOut.value = await encodeShareCode(this.build);
          }, '--small --primary'),
          btn(Copy, 'Copy link', async () => {
            const code = codeOut.value || (await encodeShareCode(this.build));
            codeOut.value = code;
            try {
              await navigator.clipboard.writeText(shareUrl(code));
              toast('Share link copied', Check);
            } catch {
              codeOut.select();
              toast('Copy the code from the box', Copy);
            }
          }, '--small'),
        ),
      ),
      section(
        'Import',
        importIn,
        btn(Upload, 'Load code', async () => {
          let code = importIn.value.trim();
          try {
            const u = new URL(code);
            code = u.searchParams.get('build') ?? code;
          } catch {
            /* plain code */
          }
          const imported = await decodeShareCode(code);
          if (!imported) return toast('That code could not be read', Upload);
          importBuild(g, imported);
          this.changed(true);
          toast(`Loaded "${imported.name}"`, Check);
        }, '--small'),
      ),
    );
  }

  private async devDrop(file: File): Promise<void> {
    let object;
    try {
      object = await this.assets.parseDropped(await file.arrayBuffer());
    } catch (e) {
      toast(`Could not read ${file.name}`, Upload);
      console.error(e);
      return;
    }
    const names = this.scene.car?.baseMeshNames() ?? [];
    const guess = (PART_SLOTS as readonly string[]).find((s) => file.name.includes(`_${s}_`)) as PartSlot | undefined;
    const dialog = h('div', { class: 'screen screen--center screen--dim' });
    const slotSel = h('select', {}, ...PART_SLOTS.filter((s) => s !== 'body').map((s) => h('option', { value: s, selected: s === guess }, SLOT_LABELS[s]))) as HTMLSelectElement;
    const hideBoxes = names.map((n) => {
      const cb = h('input', { type: 'checkbox', value: n }) as HTMLInputElement;
      return h('label', { class: 'row', style: 'gap:6px;font-size:14px' }, cb, n);
    });
    dialog.append(
      h(
        'div',
        { class: 'dialog panel' },
        h('h2', { class: 'title dialog__title' }, icon(Upload, { size: 22 }), 'Preview part'),
        h('div', { class: 'muted' }, file.name),
        h('div', { class: 'setting-row' }, h('span', { class: 'label' }, 'Slot'), slotSel),
        names.length ? h('div', { class: 'label' }, 'Hide base meshes') : null,
        h('div', { class: 'col', style: 'max-height:200px;overflow:auto' }, ...hideBoxes),
        h(
          'div',
          { class: 'row' },
          btn(Check, 'Equip', () => {
            const slot = slotSel.value as PartSlot;
            const id = `dev_${Date.now().toString(36)}`;
            this.assets.devParts.set(id, { slot, object, name: file.name.replace(/\.glb$/i, '') });
            const v = this.build.visual;
            v.parts[slot] = id;
            const hides = hideBoxes.map((l) => l.querySelector('input') as HTMLInputElement).filter((c) => c.checked).map((c) => c.value);
            void this.scene.setCar(this.build.carId, v).then((view) => view.setDevHides(slot, hides));
            dialog.remove();
            this.setTab(slot === 'wheels' ? 'wheels' : 'body');
            toast('Dev part equipped (not saved to the catalog)', Check);
          }, '--primary'),
          btn(Trash2, 'Cancel', () => dialog.remove()),
        ),
      ),
    );
    this.uiRoot.append(dialog);
  }

  /** Back to the menu; dispose() saves the garage once on the way out. */
  private exit(): void {
    this.cb.onExit();
  }

  render(dt: number): void {
    this.scene.render(dt);
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
    clearTimeout(this.arriveTimer);
    this.doorWatch?.disconnect();
    this.cb.onChange(this.garage);
    this.abort.abort();
    document.body.classList.remove('is-garage-open');
    this.help.dispose();
    this.root.remove();
    this.scene.dispose();
  }
}
