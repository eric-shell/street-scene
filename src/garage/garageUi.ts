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
 *
 * This file is the screen: its steps, the build card and slots, saving, dialogs
 * and input. The pieces beside it are garageWidgets.ts (the pickers, sliders and
 * stat lines every tab is made of), garageTabs.ts (what each tab shows and the
 * TabHost it asks the screen for) and garageVinyls.ts (the Vinyls tab and
 * placing a layer on the car).
 */
import type { GameRenderer } from '../render/scene';
import { CarAssetLibrary, manifestCar } from '../render/car/carAssets';
import type { StreetStage } from '../game/streetStage';
import type { Quality } from '../ui/settings';
import { RailSteps, railInset, screenHead } from '../ui/rail/rail';
import { Help, MUSIC_KEYS } from '../ui/panels/help';
import type { HelpKey } from '../ui/panels/help';
import { uiWhoosh } from '../audio/uiSound';
import { PART_SLOTS, PartSlot, SLOT_LABELS } from '../shared/parts';
import { Axle, BUILD_NAME_MAX, CarBuild, DEFAULT_BUILD_NAME, VinylShape, validateBuild } from '../shared/carBuild';
import { getBaseTuning } from '../sim/tuning';
import { tuningForBuild } from '../sim/build';
import { specBadges } from '../shared/carSpec';
import { btn, chip, h, iconBtn, isTyping, scrollHint, segmented, sheen, specChip, toast } from '../ui/kit/dom';
import { door, transitioning } from '../ui/transitions/transitions';
import { openSignInDialog, onSignedIn, wantsSignIn } from '../ui/screens/signIn';
import { Car, Check, ChevronRight, CircleUser, CloudOff, Copy, Download, Hammer, MousePointerClick, Paintbrush, Pencil, Plus, Save, Share2, Trash2, Undo2, Upload, Wrench, X, Route, Video, Warehouse, icon, IconNode } from '../ui/kit/icons';
import { GarageScene } from './garageScene';
import { track } from '../analytics/telemetry';
import { GaragePrefs, GarageState, MAX_SLOTS, Presentation, addSlot, decodeShareCode, encodeShareCode, importBuild, loadGaragePrefs, randomBuild, saveGaragePrefs, shareUrl } from './storage';
import { section, statLines } from './garageWidgets';
import type { Child } from './garageWidgets';
import { AUTHORS, renderTabContent, TABS } from './garageTabs';
import type { Tab, TabHost, WheelView } from './garageTabs';
import { WheelThumbs } from './wheelThumbs';
import { placeDecal } from './garageVinyls';
import { FEATURES } from '../shared/features';

/** The garage's steps: pick a build, then customize it. */
type Step = 'builds' | 'build';

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

/** Keys that hold the gas in the garage (W, Up or Space; the help lists them). */
const GAS_KEYS = ['KeyW', 'ArrowUp', 'Space'];
/** The race's steering keys turn the front wheels on the turntable. */
const LEFT_KEYS = ['KeyA', 'ArrowLeft'];
const RIGHT_KEYS = ['KeyD', 'ArrowRight'];
const DRIVE_KEYS = [...GAS_KEYS, ...LEFT_KEYS, ...RIGHT_KEYS];

// ---------------------------------------------------------------------------
// The tabs' controls
// ---------------------------------------------------------------------------

/** How long the Save button stays green after a save (ms), before it eases back to Saved. */
const SAVED_FLASH_MS = 5000;

/** Where a step stands (pips like the menu's race flow), then anything else for the header's right. */
const progress = (at: number, ...aside: Child[]) =>
  h(
    'span',
    { class: 'screen-head__aside' },
    h('span', { class: 'stepper', role: 'img', 'aria-label': `Step ${at} of 2` }, ...[1, 2].map((i) => h('i', { class: i < at ? 'stepper__pip is-done' : i === at ? 'stepper__pip is-current' : 'stepper__pip' }))),
    ...aside,
  );

/**
 * The garage screen. The members the tab builders reach (`scene`, `body`, `tab`, `bodySlot`, `wheel*`,
 * `selectedDecal`, `placing`, `prefs`, `assets`, `availability`, `build`, `changed`, `renderTab`) are not
 * private: garageTabs.ts and garageVinyls.ts see the screen only through TabHost.
 */
export class GarageScreen implements TabHost {
  scene: GarageScene;
  private root: HTMLElement;
  body: HTMLElement;
  /** The body inside its scroll hints (fades and the more-below chevron), as the step lays it out. */
  private readonly bodyView: HTMLElement;
  private tabBar: HTMLElement;
  tab: Tab = 'model';
  private step: Step = 'builds';
  /** The steps, sliding in the rail's column above the Save button. */
  private readonly steps: RailSteps;
  /** The Body tab's part slot on show: one at a time, so the tab never scrolls through all of them. */
  bodySlot: PartSlot = 'body';
  /** The axle the Wheels tab's wheel and tire picks dress while front and rear are unlinked. */
  wheelAxle: Axle = 'front';
  /** The Wheels tab's view: the picker first, the size and paint a switch away. */
  wheelView: WheelView = 'wheel';
  /** The maker the wheel picker shows (null: all of them). */
  wheelMaker: string | null = null;
  readonly wheelThumbs: WheelThumbs;
  /** The current slot as last saved (JSON): the build differs from it while it has unsaved changes. */
  private savedJson: string;
  /** The Save button and the discard button beside it, under both steps. */
  private readonly saveBtn: HTMLButtonElement;
  private readonly revertBtn: HTMLButtonElement;
  /** Whether the Save button shows unsaved changes, so it only changes look when that flips. */
  private shownDirty: boolean | null = null;
  /** The garage's dialog while one is up (unsaved changes, share, delete). */
  private dialog: HTMLElement | null = null;
  selectedDecal = -1;
  placing: { shape: VinylShape; index: number } | null = null;
  private devMode = new URLSearchParams(location.search).has('dev');
  private abort = new AbortController();
  private pointerDown: { x: number; y: number } | null = null;
  prefs: GaragePrefs = loadGaragePrefs();
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
    readonly assets: CarAssetLibrary,
    private readonly uiRoot: HTMLElement,
    private garage: GarageState,
    readonly availability: Record<string, boolean>,
    private readonly cb: GarageCallbacks,
    stage: GarageStage,
  ) {
    this.scene = new GarageScene(gr, assets, stage.street, stage.quality);
    this.wheelThumbs = new WheelThumbs(assets);
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
        placeDecal(this, hit.pos, hit.normal);
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
        if (e.code === 'KeyD' && e.ctrlKey && e.shiftKey && FEATURES.devTools) {
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

  get build(): CarBuild {
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
    if (next === 'builds') this.scene.frameWheels(false);
    this.configureEngine();
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
      ...[this.signInNote()].filter((n) => n !== null),
    ];
  }

  /**
   * Signed out on a build with accounts, under the builds: they live on this device only, and Sign in opens
   * the sign-in dialog, once the build's changes are saved or dropped (signing in can reload the page).
   */
  private signInNote(): HTMLElement | null {
    if (!wantsSignIn()) return null;
    const note = h(
      'div',
      { class: 'garage-note' },
      icon(CloudOff, { size: 16 }),
      h('span', { class: 'garage-note__text' }, 'Your builds are saved on this device only'),
      btn(CircleUser, 'Sign in', () => this.whenSaved(() => openSignInDialog(this.uiRoot)), '--small garage-note__go'),
    );
    onSignedIn(note, () => note.remove());
    return note;
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
      tile.addEventListener('click', () => (s ? this.pickSlot(i) : this.addBuild(() => randomBuild(`Build ${g.slots.length + 1}`))));
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

  /**
   * Idle and redline of the current build feed the garage rev model, and on the Tune tab its launch rpm (the gas
   * bounces off the two-step there, as at the line); its steering lock and rate the turntable's front wheels.
   */
  private configureEngine(): void {
    const t = tuningForBuild(this.build.carId, this.build.performance);
    const L = t.launch;
    const tune = this.step === 'build' && this.tab === 'tune' && L.twoStepRpm > 0;
    this.scene.setEngine(t.engine.idleRpm, t.engine.redline, tune ? { rpm: L.twoStepRpm, depth: L.twoStepDepth, cutTime: L.twoStepCutTime, pedal: L.pedalThreshold } : null);
    this.scene.setSteering(t.steering.maxDeg, t.steering.rateDegPerSec);
  }

  private setTab(t: Tab): void {
    const switched = t !== this.tab;
    this.tab = t;
    this.placing = null;
    this.configureEngine();
    this.tabBar.querySelectorAll<HTMLElement>('.garage-tab').forEach((b) => {
      const on = b.dataset.tab === t;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-selected', String(on));
    });
    // The open tab's hue colors its picks, sliders and section hairlines (_garage.scss keys it on data-tab).
    this.root.dataset.tab = t;
    // The Wheels tab brings the camera down to the front wheel; leaving it goes back to the three quarter view.
    this.scene.frameWheels(this.step === 'build' && t === 'wheels');
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
  changed(rerender = false): Promise<unknown> {
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
    track('build_save', { carId: this.build.carId, slot: this.garage.current });
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

  renderTab(): void {
    // A re-render within the tab (a tier picked, a slot added) keeps the scroll; emptying the body would reset it.
    const scroll = this.body.scrollTop;
    renderTabContent(this);
    this.body.scrollTop = scroll;
  }

  /**
   * Share the build in use as a code or link, and load one into a slot: one
   * dialog, opened from the build card (share) or the Builds header (import,
   * its field focused).
   */
  private openShare(focusImport: boolean): void {
    const codeOut = h('input', { type: 'text', readonly: true, placeholder: 'Press Export to create a code', style: 'width:100%' }) as HTMLInputElement;
    // One build_share per dialog, however many times the code is made or copied.
    let announced = false;
    const shared = (): void => {
      if (!announced) track('build_share', { carId: this.build.carId });
      announced = true;
    };
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
          shared();
        }, '--small --primary'),
        btn(Copy, 'Copy link', async () => {
          const code = codeOut.value || (await encodeShareCode(this.build));
          codeOut.value = code;
          shared();
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
            track('build_import', { carId: imported.carId });
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
    this.wheelThumbs.dispose();
    this.scene.dispose();
  }
}
