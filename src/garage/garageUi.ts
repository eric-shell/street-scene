/**
 * Garage UI on the rail (ui/rail/rail.ts), drawn like the main menu's: no column,
 * only a scrim, with plates of their own standing on the scene down the left,
 * and in steps like the menu's so no pane tries to do everything. Builds (step
 * one) is the build card (the build's name with quiet rename, share, duplicate
 * and delete actions, its car, spec tags and measured stats, and Customize)
 * over the garage's slots, one build to a row. Customize (step two) is the tabs of
 * live-preview categories over the open tab's groups, each tab laid out to fit
 * the column without scrolling where it can (one line sliders, wheels in a grid,
 * the Body tab one part slot at a time). Under both steps the Save button;
 * beside the rail the 3D view framed to the free space, with the Garage /
 * Street switch and the camera at the bottom. Steps slide like the menu's and
 * Escape or the back button goes back one. Body part menus are populated
 * entirely from partsCatalog.json. Hidden dev mode (Ctrl+Shift+D or ?dev)
 * accepts a dropped GLB and equips it live in a chosen slot.
 *
 * Saving is explicit: edits show live and drive the races, but the slot in
 * localStorage only changes on Save. Anything that leaves the build (another
 * slot, a new one, an import, the menu) asks first while it has unsaved
 * changes, so only the slot in use is ever a draft. Share and import live in a
 * dialog off the build card and the Builds header.
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
import { RailSteps, railInset, screenHead } from '../ui/rail/rail';
import { Help, MUSIC_KEYS, type HelpKey } from '../ui/panels/help';
import { uiWhoosh } from '../audio/uiSound';
import { GaragePrefs, GarageState, MAX_SLOTS, Presentation, addSlot, decodeShareCode, encodeShareCode, freshBuild, importBuild, loadGaragePrefs, saveGaragePrefs, shareUrl } from './storage';
import { BODY_PART_SLOTS, OPTIONAL_SLOTS, PART_SLOTS, PartSlot, SLOT_LABELS } from '../shared/parts';
import { AXLES, Axle, AxleStance, BUILD_NAME_MAX, CarBuild, DEFAULT_BUILD_NAME, DecalLayer, GLOW_PATTERNS, MAX_DECALS, PAINT_FINISHES, Paint, AccentPaint, STANCE_LIMITS, TireShape, VINYL_SHAPES, VinylShape, validateBuild } from '../shared/carBuild';
import { DEFAULT_CAR_ID, PERFORMANCE_CATEGORIES, PerformanceCategory, SELECTABLE_CAR_IDS, TIER_NAMES, Tier, getBaseTuning } from '../sim/tuning';
import { tuningForBuild } from '../sim/build';
import { FEATURES } from '../shared/features';
import { specBadges, type SpecBadge } from '../shared/carSpec';
import { measureStats, statBars, type CarStats } from '../sim/stats';
import { SHAPE_LABELS } from '../render/car/decals';
import { btn, chip, h, iconBtn, isTyping, scrollHint, segmented, sheen, toast } from '../ui/kit/dom';
import { door, transitioning } from '../ui/transitions/transitions';
import { KMH_PER_MPH, M_PER_FT } from '../ui/kit/units';
import {
  ArrowUpDown,
  Car,
  Check,
  ChevronRight,
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
  Pencil,
  Plus,
  Save,
  Share2,
  Trash2,
  Undo2,
  Upload,
  Wind,
  Wrench,
  X,
  Zap,
  Box,
  Sparkles,
  Route,
  Video,
  Warehouse,
  icon,
  IconNode,
} from '../ui/kit/icons';
import { Link2, Link2Off } from 'lucide';

type Tab = 'model' | 'stance' | 'wheels' | 'body' | 'paint' | 'vinyl' | 'tint' | 'neon' | 'tune';

/** The garage's steps: pick a build, then customize it. */
type Step = 'builds' | 'build';

const TABS: { id: Tab; label: string; icon: IconNode }[] = [
  { id: 'model', label: 'Model', icon: Car },
  { id: 'stance', label: 'Stance', icon: ArrowUpDown },
  { id: 'wheels', label: 'Wheels', icon: Disc3 },
  { id: 'body', label: 'Body', icon: Hammer },
  { id: 'paint', label: 'Paint', icon: Paintbrush },
  ...(FEATURES.vinyls ? [{ id: 'vinyl' as Tab, label: 'Vinyls', icon: Layers }] : []),
  { id: 'tint', label: 'Tint', icon: Eye },
  { id: 'neon', label: 'Neon', icon: Sparkles },
  { id: 'tune', label: 'Tune', icon: Gauge },
];

/** Each spec tag's ink by its place in specBadges (drivetrain cyan, engine yellow, forced induction red): `.ink-*` in _tune-stat.scss. */
const SPEC_INKS = ['ink-drive', 'ink-engine', 'ink-boost'] as const;

/** A spec tag as a chip in its ink, the long form on hover (car tiles and the build card alike). */
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

/** The measured stats the build card and the Tune tab show, in order, each bar in its ink (`.ink-*` in _tune-stat.scss). */
const STATS: readonly { ink: string; bar: keyof ReturnType<typeof statBars>; name: string; value: (s: CarStats) => string }[] = [
  { ink: 'speed', bar: 'topSpeed', name: 'Top speed', value: (s) => `${Math.round(s.topSpeed / KMH_PER_MPH)} mph` },
  { ink: 'accel', bar: 'acceleration', name: '0-60', value: (s) => `${s.zeroTo60.toFixed(2)} s` },
  { ink: 'grip', bar: 'handling', name: 'Grip', value: (s) => `${s.grip.toFixed(2)} g` },
  { ink: 'nitrous', bar: 'nitrous', name: 'Nitrous', value: (s) => `${s.nitrous.toFixed(1)} kN·s` },
];

/** A build's measured stats: a line each, the measure, its bar in its ink and the value in yellow. */
function statLines(b: CarBuild): HTMLElement {
  const st = statsFor(b);
  const bars = statBars(st);
  return h(
    'div',
    { class: 'car-card__stats' },
    ...STATS.map((t) =>
      h('div', { class: `car-card__stat ink-${t.ink}` }, h('span', { class: 'car-card__stat-name' }, t.name), h('span', { class: 'stat-bar' }, h('span', { class: 'stat-bar__fill', style: `width:${bars[t.bar] * 100}%` })), h('span', { class: 'car-card__stat-value' }, t.value(st))),
    ),
  );
}

/** Keys that hold the gas in the garage (W, Up or Space; the help lists them). */
const GAS_KEYS = ['KeyW', 'ArrowUp', 'Space'];
/** The race's steering keys turn the front wheels on the turntable. */
const LEFT_KEYS = ['KeyA', 'ArrowLeft'];
const RIGHT_KEYS = ['KeyD', 'ArrowRight'];
const DRIVE_KEYS = [...GAS_KEYS, ...LEFT_KEYS, ...RIGHT_KEYS];

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

/**
 * Preset swatches per colored surface: the body's loud street colors (two rows), wheel metals, caliper brights,
 * neon. The swatches sit nine to a row (_garage-swatch.scss), so every list is a multiple of nine: no row half full.
 */
const PRESETS = {
  body: [
    ...['#d11f3f', '#ff6a00', '#ffcc1f', '#3dff9a', '#19e6ff', '#1f6bff', '#8b3dff', '#ff3df2', '#f2f2f2'],
    ...['#7a0f22', '#b84a12', '#c9a227', '#1f7a4d', '#0f6f80', '#14306e', '#9aa3ad', '#2a2c33', '#0b0b0d'],
  ],
  wheels: ['#c9ced8', '#e8eaee', '#7d838c', '#3a3d44', '#1a1b1f', '#f2f2f2', '#b08d57', '#d4af37', '#d11f3f'],
  calipers: ['#c41e3a', '#ffcc1f', '#ff6a00', '#1f6bff', '#3dff9a', '#ff3df2', '#d4af37', '#f2f2f2', '#1a1b1f'],
  glow: ['#00e5ff', '#ff3df2', '#7cff4f', '#ffe14d', '#ff2e5b', '#7a5cff', '#ffffff', '#ff8a00', '#ff1a1a'],
} as const;

/**
 * A color well and its preset swatches, kept in step: a swatch sets the well and is marked, a color from
 * the well marks none. `preset` says whether a swatch picked it.
 */
function colorPicker(value: string, presets: readonly string[], onInput: (c: string, preset: boolean) => void): HTMLElement {
  const sw = h('div', { class: 'garage-swatches' });
  const well = color(value, (c) => {
    sw.querySelectorAll('.garage-swatch.is-selected').forEach((x) => x.classList.remove('is-selected'));
    onInput(c, false);
  });
  for (const p of presets) {
    sw.append(
      swatch(p, value, (s) => {
        well.value = p;
        sw.querySelectorAll('.garage-swatch').forEach((x) => x.classList.toggle('is-selected', x === s));
        onInput(p, true);
      }),
    );
  }
  return h('div', { class: 'row' }, well, sw);
}

/**
 * Every paint's controls (body, wheels, calipers): its color over its finish, edited in place, then onChange.
 * An accent (wheels, calipers) gets a Match body toggle beside any `tools`: matched, it wears the body's paint
 * and shows that instead of its controls; unmatched, it starts from the body's paint, so nothing jumps.
 */
function paintPicker(paint: Paint | AccentPaint, presets: readonly string[], onChange: () => void, accent?: { body: Paint; tools?: Node[] }): HTMLElement {
  const root = h('div', { class: 'garage-paint' });
  const a = accent && 'match' in paint ? paint : null;
  const draw = () => {
    const tools: Node[] = [...(accent?.tools ?? [])];
    if (accent && a) {
      tools.push(
        toggle(Paintbrush, 'Match body', a.match, a.match ? 'Wearing the body paint' : 'Wear the body paint', () => {
          a.match = !a.match;
          if (!a.match) Object.assign(a, { color: accent.body.color, finish: accent.body.finish });
          onChange();
          draw();
        }),
      );
    }
    root.replaceChildren(
      ...(tools.length ? [h('div', { class: 'row' }, ...tools)] : []),
      ...(accent && a?.match
        ? [h('div', { class: 'muted garage-note' }, h('span', { class: 'garage-dot', style: `background:${accent.body.color}` }), `Body paint · ${capital(accent.body.finish)}`)]
        : [
            colorPicker(paint.color, presets, (c) => {
              paint.color = c;
              onChange();
            }),
            segmented(
              PAINT_FINISHES.map((f) => ({ value: f, label: capital(f) })),
              paint.finish,
              (f) => {
                paint.finish = f;
                onChange();
              },
            ),
          ]),
    );
  };
  draw();
  return root;
}

/**
 * A garage toggle (front and rear linked, match body, mirror): a short label that never changes, so the
 * button keeps its size, lit in the tab's hue while on (_garage-toggle.scss); the title says it in full.
 */
function toggle(ico: IconNode, label: string, on: boolean, title: string, onClick: () => void): HTMLButtonElement {
  const b = btn(ico, label, onClick, `--small garage-toggle${on ? ' --primary' : ''}`);
  b.title = title;
  b.setAttribute('aria-pressed', String(on));
  return b;
}

/** A row in a group: the name on the left, its control on the right (the settings' rows). */
const field = (label: string, control: Node) => h('div', { class: 'garage-row' }, h('span', { class: 'garage-row__name' }, label), control);

/** A slider on one line: its name, the track and the value in yellow, so a group of them stays short. */
function slider(label: string, value: number, min: number, max: number, step: number, fmt: (x: number) => string, onInput: (x: number) => void): HTMLElement {
  const out = h('span', { class: 'garage-value' }, fmt(value));
  const el = h('input', { type: 'range', min, max, step, value, 'aria-label': label }) as HTMLInputElement;
  el.addEventListener('input', () => {
    const x = Number(el.value);
    out.textContent = fmt(x);
    onInput(x);
  });
  return h('label', { class: 'garage-slider' }, h('span', { class: 'garage-slider__name' }, label), el, out);
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

/** A list of picks (`grid`: two to a row), the current one marked; a click marks it and calls onPick. */
function choiceList<T extends string | number | null>(items: Choice<T>[], current: T, onPick: (x: T) => void, grid = false): HTMLElement {
  const list = h('div', { class: grid ? 'garage-grid' : 'garage-list' });
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

/** The tire shapes as the Wheels tab lists them (TIRE_SHAPES' order, render/car/tireShapes.ts draws them). */
const TIRE_CHOICES: Choice<TireShape>[] = [
  { value: 'standard', label: 'Standard', sub: 'Square sidewall' },
  { value: 'stretched', label: 'Stretched', sub: 'Angled sidewall' },
];

/** How long the Save button stays green after a save (ms), before it eases back to Saved. */
const SAVED_FLASH_MS = 5000;

/** Slider readouts: a length (m) in cm, a factor as a percent. */
const cm = (x: number) => `${Math.round(x * 100)} cm`;
const percent = (x: number) => `${Math.round(x * 100)}%`;

/** Where a step stands (pips like the menu's race flow), then anything else for the header's right. */
const progress = (at: number, ...aside: Child[]) =>
  h(
    'span',
    { class: 'screen-head__aside' },
    h('span', { class: 'stepper', role: 'img', 'aria-label': `Step ${at} of 2` }, ...[1, 2].map((i) => h('i', { class: i < at ? 'stepper__pip is-done' : i === at ? 'stepper__pip is-current' : 'stepper__pip' }))),
    ...aside,
  );

export class GarageScreen {
  private scene: GarageScene;
  private root: HTMLElement;
  private body: HTMLElement;
  /** The body inside its scroll hints (fades and the more-below chevron), as the step lays it out. */
  private readonly bodyView: HTMLElement;
  private tabBar: HTMLElement;
  private tab: Tab = 'model';
  private step: Step = 'builds';
  /** The steps, sliding in the rail's column above the Save button. */
  private readonly steps: RailSteps;
  /** The Body tab's part slot on show: one at a time, so the tab never scrolls through all of them. */
  private bodySlot: PartSlot = 'body';
  /** The axle the Wheels tab's wheel and tire picks dress while front and rear are unlinked. */
  private wheelAxle: Axle = 'front';
  /** The current slot as last saved (JSON): the build differs from it while it has unsaved changes. */
  private savedJson: string;
  /** The Save button and the discard button beside it, under both steps. */
  private readonly saveBtn: HTMLButtonElement;
  private readonly revertBtn: HTMLButtonElement;
  /** Whether the Save button shows unsaved changes, so it only changes look when that flips. */
  private shownDirty: boolean | null = null;
  /** The garage's dialog while one is up (unsaved changes, share, delete). */
  private dialog: HTMLElement | null = null;
  private selectedDecal = -1;
  private placing: { shape: VinylShape; index: number } | null = null;
  private devMode = new URLSearchParams(location.search).has('dev');
  private abort = new AbortController();
  private pointerDown: { x: number; y: number } | null = null;
  private prefs: GaragePrefs = loadGaragePrefs();
  /** Drive keys held now (gas and steering). */
  private driveKeys = new Set<string>();
  private tabInTimer = 0;
  /** Ends the Save button's green flash after a save. */
  private savedTimer = 0;
  /** The roller door is running for a Garage / Street switch. */
  private switching = false;
  /** The slot and car the card last showed, so only another build (not every edit) deals the card in again. */
  private cardKey = '';
  /** The build card on the Builds step and the slots under it, refilled in place as the garage changes. */
  private readonly carCard = h('section', { class: 'car-card', 'aria-label': 'Build', 'aria-live': 'polite' });
  private readonly slotsEl = h('div', { class: 'garage-list', role: 'radiogroup', 'aria-label': 'Builds' });
  /** The garage's keys and tips behind the ? in the corner (the rev, C and Save are buttons there too, for touch screens). */
  private readonly help = new Help({
    title: 'Garage',
    sections: () => {
      const keys: HelpKey[] = [
        { keys: ['Drag'], label: 'Orbit the car' },
        { keys: ['W', '↑', 'Space'], label: 'Hold to rev', action: () => this.scene.blip() },
        { keys: ['A', 'D', '←', '→'], label: 'Turn the front wheels' },
        { keys: ['C'], label: 'Next camera angle', action: () => this.nextCamera() },
        { keys: ['Ctrl S'], label: 'Save the build', action: () => this.save() },
      ];
      const builds = this.step === 'builds';
      if (builds) keys.push({ keys: [`1–${MAX_SLOTS}`], label: 'Switch to a build by its slot' }, { keys: ['Esc'], label: 'Back to the menu' });
      else keys.push({ keys: ['Esc'], label: 'Back to your builds' });
      return [
        { title: 'Keys', keys },
        { title: 'Music', keys: MUSIC_KEYS },
        {
          title: 'Tips',
          tips: builds
            ? ['Each slot holds a build: pick one, then Customize. The pencil renames it, share turns it into a code or link.', 'Changes show at once; Save keeps them in the build\'s slot.']
            : ['Changes show at once; Save keeps them in the build\'s slot.', 'Garage / Street at the bottom shows the car on the turntable or out on the event street.'],
        },
      ];
    },
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
    this.tabBar = h('div', { class: 'garage__tabs', role: 'tablist', 'aria-label': 'Categories', style: `--tabs:${Math.ceil(TABS.length / 2)};--tab-count:${TABS.length}` });
    this.body = h('div', { class: 'garage__body' });
    this.bodyView = scrollHint(this.body, 'garage__scroll');
    this.savedJson = JSON.stringify(this.build);
    this.saveBtn = btn(Check, 'Saved', () => this.save(), 'garage__save');
    this.revertBtn = iconBtn(Undo2, 'Discard changes', () => this.revert());
    const stepsEl = h('div', { class: 'garage__steps' });
    this.steps = new RailSteps(stepsEl);
    this.root = h(
      'div',
      { class: 'garage rail' },
      h('div', { class: 'rail__bg', 'aria-hidden': 'true' }),
      h('div', { class: 'rail__edge', 'aria-hidden': 'true' }),
      h('div', { class: 'garage__panel' }, stepsEl, h('div', { class: 'garage__foot' }, this.revertBtn, this.saveBtn)),
      this.help.el,
      this.stageBar(),
    );
    uiRoot.append(this.root);
    // Toasts (camera angle, saved builds) rise above the Garage / Street switch while the garage is open.
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
    this.go('builds', false);
    void this.scene.setCar(this.build.carId, this.build.visual);
    this.arrive();

    const o = { signal: this.abort.signal };
    window.addEventListener('resize', frame, o);
    // Escape goes back a step (or closes a dialog), C cycles the camera, 1 to 6 switch builds on the Builds step
    // and Ctrl+S saves (also while typing; not with a dialog up).
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.repeat) return;
        if (this.dialog) {
          if (e.key === 'Escape') {
            e.preventDefault();
            this.closeDialog();
          }
          return;
        }
        if (this.uiRoot.querySelector('.screen')) return;
        if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey) && !e.altKey) {
          e.preventDefault();
          this.save();
          return;
        }
        if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          if (this.step === 'build') this.go('builds');
          else this.exit();
        } else if (e.code === 'KeyC') this.nextCamera();
        else if (this.step === 'builds' && /^[1-9]$/.test(e.key) && this.garage.slots[Number(e.key) - 1]) this.pickSlot(Number(e.key) - 1);
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
    // Hold W / Up / Space to rev and A / D / Left / Right to steer (not while typing in a field or on a slider, and
    // not the arrows the pad sends to move around the screen: input/padNav.ts).
    window.addEventListener(
      'keydown',
      (e) => {
        if (!e.isTrusted || !DRIVE_KEYS.includes(e.code) || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        this.driveKeys.add(e.code);
        this.updateDrive();
      },
      o,
    );
    window.addEventListener(
      'keyup',
      (e) => {
        if (!this.driveKeys.delete(e.code)) return;
        e.preventDefault();
        this.updateDrive();
      },
      o,
    );
    window.addEventListener(
      'blur',
      () => {
        this.driveKeys.clear();
        this.updateDrive();
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

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  /**
   * Show a step: deeper slides the old one out to the left as the new one
   * cascades in from the right, back reverses it (the menu's RailSteps).
   * Keyboard and gamepad focus lands on the step's main control.
   */
  private go(next: Step, animate = true): void {
    const from = this.step;
    this.step = next;
    this.root.dataset.step = next;
    this.placing = null;
    const fwd = next === 'build' && from === 'builds';
    if (this.steps.show(next === 'builds' ? this.buildsStep() : this.buildStep(), animate ? (fwd ? 'fwd' : 'back') : null)) uiWhoosh(fwd);
    this.help.close();
    if (!animate) return;
    this.steps.current?.querySelector<HTMLElement>(next === 'builds' ? '.car-card__go' : '.garage-tab.is-selected')?.focus({ preventScroll: true });
  }

  /** Step one: the build card over the slots. Import sits in the header: it fills a slot. */
  private buildsStep(): HTMLElement[] {
    this.updateCarCard();
    this.updateSlots();
    return [
      screenHead({ icon: Wrench, title: 'Garage', back: () => this.exit(), backLabel: 'Back to menu (Esc)', aside: progress(1, iconBtn(Upload, 'Import a build code', () => this.openShare(true), '--small --ghost')) }),
      this.carCard,
      section(`Builds · ${this.garage.slots.length} of ${MAX_SLOTS}`, this.slotsEl),
    ];
  }

  /** Step two: the build's name, the tabs and the open tab's groups. */
  private buildStep(): HTMLElement[] {
    this.setTab(this.tab);
    return [screenHead({ icon: Hammer, title: 'Customize', back: () => this.go('builds'), backLabel: 'Back to your builds (Esc)', aside: progress(2, chip(this.build.name, undefined, '--accent garage__build-chip')) }), this.tabBar, this.bodyView];
  }

  /**
   * The build card: the slot as the kicker with quiet rename, share,
   * duplicate and delete beside it, the build's name, its car and who made
   * it, the spec tags, the measured stats and Customize (the event card's
   * shape on the menu's home).
   */
  private updateCarCard(): void {
    const b = this.build;
    const car = manifestCar(b.carId);
    const go = btn(Paintbrush, 'Customize', () => this.go('build'), '--large --primary --cta car-card__go');
    go.title = 'Body, paint, wheels, stance, neon and tuning';
    go.append(icon(ChevronRight, { size: 20 }));
    const del = iconBtn(Trash2, 'Delete this build', () => this.confirmDelete(), '--small --ghost');
    del.disabled = this.garage.slots.length <= 1;
    const dup = iconBtn(Copy, 'Duplicate into a new slot', () => this.duplicate(), '--small --ghost');
    dup.disabled = this.garage.slots.length >= MAX_SLOTS;
    this.carCard.replaceChildren(
      h(
        'div',
        { class: 'car-card__top' },
        h('span', { class: 'label label--kicker' }, icon(Car, { size: 14 }), `Slot ${this.garage.current + 1}`),
        h('span', { class: 'car-card__actions' }, iconBtn(Pencil, 'Rename', () => this.rename(), '--small --ghost'), iconBtn(Share2, 'Share as a code or link', () => this.openShare(false), '--small --ghost'), dup, del),
      ),
      h('h2', { class: 'car-card__name' }, b.name),
      h('div', { class: 'car-card__car' }, car.displayName, AUTHORS[car.source] ? h('span', { class: 'muted' }, ` · by ${AUTHORS[car.source]}`) : null),
      h('div', { class: 'car-card__tags' }, ...specBadges(car.engine, getBaseTuning(b.carId).drivetrain.layout).map((t, i) => specChip(t, i))),
      statLines(b),
      go,
    );
    // Another build deals the card in again; edits to the same one rebuild it still, so the class only stays
    // for the render that brought the new build.
    const key = `${this.garage.current}:${b.carId}`;
    const fresh = this.cardKey !== '' && this.cardKey !== key;
    this.cardKey = key;
    this.carCard.classList.remove('is-swapping');
    if (!fresh) return;
    void this.carCard.offsetWidth;
    this.carCard.classList.add('is-swapping');
  }

  /** Rename in place, like the menu's seed: the name becomes a field (Enter keeps it, Escape cancels). */
  private rename(): void {
    const b = this.build;
    const input = h('input', { type: 'text', class: 'car-card__input', value: b.name, maxlength: BUILD_NAME_MAX, placeholder: DEFAULT_BUILD_NAME, 'aria-label': 'Build name' }) as HTMLInputElement;
    const apply = () => {
      const name = input.value.trim().slice(0, BUILD_NAME_MAX) || DEFAULT_BUILD_NAME;
      if (name === b.name) return this.updateCarCard();
      b.name = name;
      this.updateSlots();
      void this.changed();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply();
      else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.updateCarCard();
      }
    });
    this.carCard.querySelector('.car-card__name')?.replaceWith(h('div', { class: 'car-card__rename' }, input, iconBtn(Check, 'Keep the name', apply, '--small'), iconBtn(X, 'Cancel', () => this.updateCarCard(), '--small --ghost')));
    input.focus();
    input.select();
  }

  /**
   * The slots, one build to a row: its number, name and car (the one in use
   * marked, with a dot while it has unsaved changes) and an X that deletes it
   * once confirmed (none while it is the only build). Slots fill in order, so
   * one New build row stands for every empty slot, numbered for the next.
   */
  private updateSlots(): void {
    const g = this.garage;
    const dirty = this.isDirty();
    this.slotsEl.replaceChildren();
    for (let i = 0; i < Math.min(MAX_SLOTS, g.slots.length + 1); i++) {
      const s = g.slots[i];
      const on = i === g.current;
      const tile = s
        ? h(
            'button',
            { type: 'button', role: 'radio', 'aria-checked': String(on), class: `garage-item garage-item--slot${on ? ' is-selected' : ''}${on && dirty ? ' is-dirty' : ''}`, title: on ? 'The build in use' : `Switch to "${s.name}" (${i + 1})` },
            h('span', { class: 'garage-item__slot' }, String(i + 1)),
            h('span', { class: 'garage-item__label' }, s.name),
            h('span', { class: 'garage-item__sub muted' }, manifestCar(s.carId).displayName),
            h('span', { class: 'garage-item__unsaved', title: 'Unsaved changes' }),
            sheen(),
          )
        : h(
            'button',
            { type: 'button', class: 'garage-item garage-item--slot garage-item--empty', title: 'Start a new build here' },
            h('span', { class: 'garage-item__slot' }, String(i + 1)),
            h('span', { class: 'garage-item__label' }, icon(Plus, { size: 14 }), 'New build'),
            h('span', { class: 'garage-item__sub muted' }, `${MAX_SLOTS - g.slots.length} free`),
            sheen(),
          );
      tile.addEventListener('click', () => (s ? this.pickSlot(i) : this.addBuild(() => freshBuild(DEFAULT_CAR_ID, `Build ${g.slots.length + 1}`))));
      // The X sits beside the row's button, not in it: a button inside a button is not one a keyboard can reach.
      this.slotsEl.append(s && g.slots.length > 1 ? h('div', { class: 'garage-slot' }, tile, iconBtn(X, `Delete "${s.name}"`, () => this.confirmDelete(i), '--small --ghost garage-slot__delete')) : tile);
    }
    const title = this.slotsEl.parentElement?.querySelector('.section-title');
    if (title) title.textContent = `Builds · ${g.slots.length} of ${MAX_SLOTS}`;
  }

  private nextCamera(): void {
    toast(`Camera: ${this.scene.setCamera()}`, Video);
  }

  /** Presentation toggle (the showroom's turntable or the street) and camera angles, at the bottom of the view. */
  private stageBar(): HTMLElement {
    return h(
      'div',
      { class: 'garage-stage' },
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

  private updateDrive(): void {
    const held = (keys: string[]) => keys.some((k) => this.driveKeys.has(k));
    this.scene.setGas(held(GAS_KEYS) ? 1 : 0);
    this.scene.setSteer((held(RIGHT_KEYS) ? 1 : 0) - (held(LEFT_KEYS) ? 1 : 0));
  }

  /** Idle and redline of the current build feed the garage rev model; its steering lock and rate the turntable's front wheels. */
  private configureEngine(): void {
    const t = tuningForBuild(this.build.carId, this.build.performance);
    this.scene.setEngine(t.engine.idleRpm, t.engine.redline);
    this.scene.setSteering(t.steering.maxDeg, t.steering.rateDegPerSec);
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

  /** Apply the current build to the preview and mark it unsaved. Resolves when the preview is up to date. */
  private changed(rerender = false): Promise<unknown> {
    const ready = this.scene.setCar(this.build.carId, this.build.visual);
    this.configureEngine();
    // The card and slots are the Builds step's; the tabs are Customize's.
    if (this.step === 'builds') {
      this.updateCarCard();
      if (rerender) this.updateSlots();
    } else if (rerender) this.renderTab();
    this.updateSaveState();
    return ready;
  }

  // -------------------------------------------------------------------------
  // Saving and slots
  // -------------------------------------------------------------------------

  private isDirty(): boolean {
    return JSON.stringify(this.build) !== this.savedJson;
  }

  /** Write the garage (every slot, the current one as it is now) to storage; the build is clean after. */
  private persist(): void {
    this.savedJson = JSON.stringify(this.build);
    this.cb.onChange(this.garage);
    this.updateSaveState();
  }

  private save(): void {
    if (!this.isDirty()) return;
    this.persist();
    toast(`Saved "${this.build.name}" to slot ${this.garage.current + 1}`, Check);
    // The Saved plate flashes green, then eases back (_garage.scss); an edit before then ends it (updateSaveState).
    this.saveBtn.classList.add('is-saved');
    clearTimeout(this.savedTimer);
    this.savedTimer = window.setTimeout(() => this.saveBtn.classList.remove('is-saved'), SAVED_FLASH_MS);
  }

  /** Back to the build as last saved. */
  private revert(): void {
    if (!this.isDirty()) return;
    this.garage.slots[this.garage.current] = JSON.parse(this.savedJson) as CarBuild;
    this.selectedDecal = -1;
    this.placing = null;
    void this.changed(true);
  }

  /**
   * The Save button (lit with unsaved changes, a quiet "Saved" without) and the
   * current slot's unsaved mark. Runs on every edit, so the button only
   * changes when the state flips.
   */
  private updateSaveState(): void {
    const dirty = this.isDirty();
    this.slotsEl.querySelector('.garage-item--slot.is-selected')?.classList.toggle('is-dirty', dirty);
    if (dirty) {
      clearTimeout(this.savedTimer);
      this.saveBtn.classList.remove('is-saved');
    }
    if (dirty === this.shownDirty) return;
    this.shownDirty = dirty;
    const b = this.saveBtn;
    b.querySelector('svg')?.replaceWith(icon(dirty ? Save : Check, { size: 18 }));
    b.querySelector('.btn__label')!.textContent = dirty ? 'Save build' : 'Saved';
    b.classList.toggle('btn--primary', dirty);
    b.disabled = !dirty;
    b.title = dirty ? `Save to slot ${this.garage.current + 1} (Ctrl+S)` : 'Every change is saved';
    this.revertBtn.disabled = !dirty;
  }

  /** A dialog over the garage: its icon and title with a close button, then the content. Escape or a click outside closes it. */
  private openDialog(ico: IconNode, title: string, ...children: Child[]): void {
    this.closeDialog();
    this.dialog = h(
      'div',
      { class: 'screen screen--center screen--dim', onclick: (e: Event) => e.target === this.dialog && this.closeDialog() },
      h(
        'div',
        { class: 'dialog panel', role: 'dialog', 'aria-label': title },
        h('h2', { class: 'title dialog__title' }, icon(ico, { size: 22 }), title, h('span', { class: 'dialog__spacer' }), iconBtn(X, 'Close', () => this.closeDialog(), '--small')),
        ...children,
      ),
    );
    this.uiRoot.append(this.dialog);
  }

  private closeDialog(): void {
    this.dialog?.remove();
    this.dialog = null;
  }

  /**
   * Run `then` once the build has no unsaved changes: at once when it has
   * none, else after the player saves or discards them in a dialog (or never,
   * if they keep editing).
   */
  private whenSaved(then: () => void): void {
    if (!this.isDirty()) return then();
    const act = (fn: () => void) => () => {
      this.closeDialog();
      fn();
      then();
    };
    const save = btn(Save, 'Save', act(() => this.persist()), '--primary');
    this.openDialog(
      Save,
      'Unsaved changes',
      h('div', { class: 'muted' }, `"${this.build.name}" has changes that are not in its slot yet.`),
      h('div', { class: 'row' }, save, btn(Undo2, 'Discard', act(() => this.revert())), btn(null, 'Keep editing', () => this.closeDialog())),
    );
    save.focus();
  }

  /** Switch to slot i (after its unsaved changes are dealt with). */
  private pickSlot(i: number): void {
    if (i === this.garage.current) return;
    this.whenSaved(() => {
      this.garage.current = i;
      this.selectedDecal = -1;
      this.persist();
      // Say hello, as a new car does on the Model tab: a short blip of its engine (and the body rocks with it).
      void this.changed(true).then(() => this.scene.blip());
    });
  }

  /** Add a build in the next empty slot and switch to it; with every slot taken nothing changes but the toast. */
  private addBuild(make: () => CarBuild): void {
    this.whenSaved(() => {
      if (!addSlot(this.garage, make())) return toast(`Up to ${MAX_SLOTS} builds`, Save);
      this.selectedDecal = -1;
      this.persist();
      void this.changed(true);
    });
  }

  private duplicate(): void {
    this.addBuild(() => {
      const copy = validateBuild(JSON.parse(JSON.stringify(this.build)));
      copy.name = `${copy.name} copy`.slice(0, BUILD_NAME_MAX);
      return copy;
    });
  }

  /**
   * Delete slot i (the build in use by default), once confirmed. The build in
   * use goes with its unsaved changes and the slot before it takes over (with
   * a blip, like any switch); another slot goes without saving the build in
   * use, whose changes stay a draft.
   */
  private confirmDelete(i = this.garage.current): void {
    const g = this.garage;
    if (g.slots.length <= 1) return toast('Keep at least one build', Save);
    const name = g.slots[i].name;
    const del = btn(Trash2, 'Delete', () => {
      this.closeDialog();
      const current = i === g.current;
      g.slots.splice(i, 1);
      if (current) {
        g.current = Math.max(0, g.current - 1);
        this.selectedDecal = -1;
        this.persist();
        void this.changed(true).then(() => this.scene.blip());
      } else {
        if (i < g.current) g.current--;
        // Store the build in use as last saved: its draft is not the player's to keep yet.
        const live = g.slots[g.current];
        g.slots[g.current] = JSON.parse(this.savedJson) as CarBuild;
        this.cb.onChange(g);
        g.slots[g.current] = live;
        // The same build under a new slot number: the card is not dealt in again, the Save button's title renumbers.
        this.cardKey = `${g.current}:${live.carId}`;
        this.shownDirty = null;
        this.updateCarCard();
        this.updateSlots();
        this.updateSaveState();
      }
      toast(`Deleted "${name}"`, Trash2);
    }, '--primary');
    this.openDialog(Trash2, 'Delete build', h('div', { class: 'muted' }, `"${name}" leaves slot ${i + 1} for good. Share it first to keep a copy.`), h('div', { class: 'row' }, del, btn(null, 'Cancel', () => this.closeDialog())));
    del.focus();
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
    // Wheel size steps in whole inches once the wheel is measured; the build keeps the size factor, so the
    // slider converts both ways (the inches a factor gives depend on the car and the wheel model).
    const car = this.scene.car?.wheelsReady ? this.scene.car : null;
    const id = (x: number) => x;
    // Per axle sliders. While front and rear are linked (the Stance tab's link, or the Wheels tab's for wheel
    // size), moving one moves its partner too.
    const partners = new Map<string, { el: HTMLInputElement; out: HTMLElement; fmt: (x: number) => string; toUi: (x: number) => number }>();
    const axleSlider = (axle: Axle, key: keyof AxleStance, short = false, link = this.prefs.linkAxles) => {
      const L = STANCE_LIMITS[key];
      const spec = {
        rideHeight: { label: 'Ride height', min: L[0], max: L[1], step: 0.005, fmt: cm, toUi: id, fromUi: id },
        camber: { label: 'Camber', min: L[0], max: L[1], step: 0.5, fmt: (x: number) => `${x}°`, toUi: id, fromUi: id },
        offset: { label: 'Wheel offset', min: L[0], max: L[1], step: 0.005, fmt: cm, toUi: id, fromUi: id },
        wheelSize: car
          ? (() => {
              // Front and rear may wear different wheels, so each axle measures its own.
              const ax = axle === 'front' ? 0 : 1;
              const min = Math.ceil(car.wheelInches(L[0], ax) - 1e-6);
              const max = Math.floor(car.wheelInches(L[1], ax) + 1e-6);
              return { label: 'Wheel size', min, max, step: 1, fmt: (x: number) => `${x} in`, toUi: (x: number) => Math.max(min, Math.min(max, Math.round(car.wheelInches(x, ax)))), fromUi: (x: number) => car.wheelSizeForInches(x, ax) };
            })()
          : { label: 'Wheel size', min: L[0], max: L[1], step: 0.01, fmt: percent, toUi: id, fromUi: id },
      }[key];
      const label = short ? spec.label : `${axle === 'front' ? 'Front' : 'Rear'}`;
      const el = slider(label, spec.toUi(v.stance[axle][key]), spec.min, spec.max, spec.step, spec.fmt, (ui) => {
        const x = spec.fromUi(ui);
        v.stance[axle][key] = x;
        if (link) {
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
      case 'model': {
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
        this.body.append(section('Model', list, h('div', { class: 'muted garage-note' }, 'A new car starts from its stock body; the wheels stay.')));
        break;
      }
      case 'body': {
        // One part slot at a time: the slots as a segmented pick (a dot on those with a part fitted), then its parts.
        const slots: PartSlot[] = ['body', ...BODY_PART_SLOTS];
        const slot = this.bodySlot;
        const parts = partsFor(b.carId, slot);
        const optional = OPTIONAL_SLOTS.includes(slot);
        const items: { value: string | null; label: string; sub?: string }[] = [{ value: null, label: optional ? 'None' : 'Stock' }, ...parts.map((p) => ({ value: p.id, label: p.displayName, sub: `${p.tris} tris` }))];
        const dev = [...this.assets.devParts.entries()].filter(([, d]) => d.slot === slot).map(([id, d]) => ({ value: id, label: d.name, sub: 'Dev preview' }));
        items.push(...dev);
        const pick = segmented(
          slots.map((s) => ({ value: s, label: `${SLOT_LABELS[s]}${v.parts[s] ? ' •' : ''}` })),
          slot,
          (s) => {
            this.bodySlot = s;
            this.renderTab();
          },
        );
        this.body.append(
          section('Part', pick),
          section(
            SLOT_LABELS[slot],
            items.length > 1
              ? choiceList(items, v.parts[slot] ?? null, (id) => {
                  v.parts[slot] = id;
                  void this.changed(true);
                })
              : h('div', { class: 'muted garage-note garage-note--empty' }, slot === 'body' ? 'Only the stock body for this car.' : 'No parts for this slot yet. See docs/partsAuthoring.md to add one.'),
          ),
        );
        break;
      }
      case 'paint': {
        this.body.append(
          section('Body paint', paintPicker(v.paint, PRESETS.body, () => this.changed())),
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
        const w = v.wheels;
        // One axle switch scopes the tab: linked, every pick equips all four (the rear copies the front);
        // unlinked, the Front / Rear switch says which pair the wheel, size, tire and paint picks dress.
        const linked = this.prefs.linkWheels;
        const rear = !linked && this.wheelAxle === 'rear';
        const axle: Axle = rear ? 'rear' : 'front';
        const front = v.parts.wheels ?? manifestCar(b.carId).defaultWheel;
        const title = (name: string) => (linked ? capital(name) : `${capital(axle)} ${name}`);
        this.body.append(
          section(
            'Axles',
            h(
              'div',
              { class: 'row' },
              this.wheelLinkToggle(),
              linked
                ? h('span', { class: 'muted garage-note' }, 'Every pick equips all four wheels.')
                : segmented(
                    AXLES.map((a) => ({ value: a, label: capital(a) })),
                    this.wheelAxle,
                    (a) => {
                      this.wheelAxle = a;
                      this.renderTab();
                    },
                  ),
            ),
          ),
          section(
            title('wheel'),
            choiceList(
              wheels.map((p) => ({ value: p.id, label: p.displayName })),
              rear ? (w.rearPart ?? front) : front,
              (id) => {
                if (rear) w.rearPart = id;
                else {
                  // Linked, the rear follows the front; unlinked, it keeps the wheel it wore.
                  w.rearPart = linked ? null : (w.rearPart ?? front);
                  v.parts.wheels = id;
                }
                // Each wheel model has its own profile: re-render so the inch range fits the new one.
                void this.changed().then(() => this.tab === 'wheels' && this.renderTab());
              },
              true,
            ),
          ),
          section(title('size'), axleSlider(axle, 'wheelSize', true, linked), h('div', { class: 'muted garage-note' }, 'Bigger wheels, thinner sidewalls.')),
          section(
            title('tire'),
            choiceList(
              TIRE_CHOICES,
              rear ? w.rearTire : w.tire,
              (t) => {
                if (rear) w.rearTire = t;
                else {
                  w.tire = t;
                  if (linked) w.rearTire = t;
                }
                this.changed();
              },
              true,
            ),
          ),
          section(
            title('paint'),
            paintPicker(
              rear ? w.rearPaint : w.paint,
              PRESETS.wheels,
              () => {
                if (linked) w.rearPaint = { ...w.paint };
                this.changed();
              },
              { body: v.paint },
            ),
          ),
          // One caliper paint for all four corners, whatever the axle switch says.
          section('Calipers', paintPicker(v.calipers, PRESETS.calipers, () => this.changed(), { body: v.paint })),
        );
        break;
      }
      case 'vinyl':
        this.renderVinyls();
        break;
      case 'stance': {
        this.body.append(
          section('Ride height', this.linkToggle(), ...AXLES.map((a) => axleSlider(a, 'rideHeight')), h('div', { class: 'muted garage-note' }, 'Visual only. Front and rear apart rake the car.')),
          ...AXLES.map((a) => section(capital(a), ...(['camber', 'offset'] as const).map((k) => axleSlider(a, k, true)))),
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
      case 'neon': {
        const g = v.underglow;
        this.body.append(
          section(
            'Underglow',
            field(
              'Lights',
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
            'Colors',
            // A swatch re-renders so the Lights switch shows the glow it turned on; the well cannot (it would close mid drag).
            h('span', { class: 'garage-row__name' }, 'Primary'),
            colorPicker(g.color, PRESETS.glow, (c, preset) => {
              g.color = c;
              g.enabled = true;
              this.changed(preset);
            }),
            h('span', { class: 'garage-row__name' }, 'Secondary'),
            colorPicker(g.color2, PRESETS.glow, (c) => {
              g.color2 = c;
              this.changed();
            }),
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
      case 'tune':
        this.renderPerformance();
        break;
    }
  }

  /** "Link front and rear" convenience toggle for the per axle sliders. */
  private linkToggle(): HTMLElement {
    const linked = this.prefs.linkAxles;
    return toggle(
      linked ? Link2 : Link2Off,
      'Link',
      linked,
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
    );
  }

  /** The Wheels tab's link: linked, front and rear wear the same wheel, size, tire and paint; unlinked, each axle picks its own. */
  private wheelLinkToggle(): HTMLElement {
    const linked = this.prefs.linkWheels;
    return toggle(
      linked ? Link2 : Link2Off,
      'Link',
      linked,
      linked ? 'Front and rear wheels the same' : 'Front and rear wheels separate',
      () => {
        this.prefs.linkWheels = !linked;
        saveGaragePrefs(this.prefs);
        const w = this.build.visual.wheels;
        if (this.prefs.linkWheels) {
          // Linking starts from matching axles: the rear takes the front's wheel, size, tire and paint.
          w.rearPart = null;
          w.rearTire = w.tire;
          w.rearPaint = { ...w.paint };
          this.build.visual.stance.rear.wheelSize = this.build.visual.stance.front.wheelSize;
          void this.changed().then(() => this.tab === 'wheels' && this.renderTab());
          toast('Rear wheels now match front', Link2);
        } else this.wheelAxle = 'front';
        this.renderTab();
      },
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
          toggle(FlipHorizontal2, 'Mirror', d.mirror, d.mirror ? 'Mirrored to the other side' : 'Mirror to the other side', () => {
            d.mirror = !d.mirror;
            update();
            this.renderTab();
          }),
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
    // The build card's stat lines, so the stats and every upgrade fit the column together.
    this.body.append(section('Stats', statLines(b)));
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

  /**
   * Share the build in use as a code or link, and load one into a slot: one
   * dialog, opened from the build card (share) or the Builds header (import,
   * its field focused).
   */
  private openShare(focusImport: boolean): void {
    const codeOut = h('input', { type: 'text', readonly: true, placeholder: 'Press Export to create a code', style: 'width:100%' }) as HTMLInputElement;
    const importIn = h('input', { type: 'text', placeholder: 'Paste a build code or link', style: 'width:100%' }) as HTMLInputElement;
    this.openDialog(
      Share2,
      'Share',
      h('div', { class: 'section-title' }, `Share "${this.build.name}"`),
      h('div', { class: 'muted garage-note' }, 'As it looks now, saved or not.'),
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
      h('div', { class: 'section-title' }, 'Import'),
      importIn,
      h(
        'div',
        { class: 'row' },
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
          this.closeDialog();
          // A new slot while there is room, else it replaces the build in use: either way the build in use is left.
          this.whenSaved(() => {
            importBuild(this.garage, imported);
            this.selectedDecal = -1;
            this.persist();
            void this.changed(true);
            toast(`Loaded "${imported.name}" into slot ${this.garage.current + 1}`, Check);
          });
        }, '--small'),
      ),
      h('div', { class: 'muted garage-note' }, `It goes in a new slot, or over the build in use when all ${MAX_SLOTS} are taken.`),
    );
    if (focusImport) importIn.focus();
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
            if (slot !== 'wheels') this.bodySlot = slot;
            if (this.step !== 'build') {
              this.tab = slot === 'wheels' ? 'wheels' : 'body';
              this.go('build');
            } else this.setTab(slot === 'wheels' ? 'wheels' : 'body');
            toast('Dev part equipped (not saved to the catalog)', Check);
          }, '--primary'),
          btn(Trash2, 'Cancel', () => dialog.remove()),
        ),
      ),
    );
    this.uiRoot.append(dialog);
  }

  /** Back to the menu, once the build's unsaved changes are saved or discarded. */
  private exit(): void {
    this.whenSaved(() => this.cb.onExit());
  }

  render(dt: number): void {
    this.scene.render(dt);
  }

  /** Closed some other way than Back with unsaved changes: they go, so the races drive what the slot holds. */
  dispose(): void {
    clearTimeout(this.arriveTimer);
    this.doorWatch?.disconnect();
    if (this.isDirty()) this.garage.slots[this.garage.current] = JSON.parse(this.savedJson) as CarBuild;
    this.closeDialog();
    this.abort.abort();
    document.body.classList.remove('is-garage-open');
    this.help.dispose();
    this.root.remove();
    this.scene.dispose();
  }
}
