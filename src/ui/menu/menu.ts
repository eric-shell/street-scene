/**
 * The main menu, in steps so no pane tries to do everything, on the rail
 * (ui/rail/rail.ts) beside the event city, where the player's car cruises the
 * route. Home is the title block over the event card (tonight's event: its
 * name and tagline, the seed with edit and shuffle, the city as a tilted live
 * map with what makes it this city, and the way into the race, with the way
 * back to today's race beside it on a city of your own)
 * over a list of the other places: Garage, Explore (the drone flyover) and
 * Settings. Home says nothing about the race itself, so no type is implied
 * before the player picks one. A race takes three steps, each short enough
 * to fit the column without scrolling: home, then the race step (the types in
 * a grid of two rows over the course card, each type's course drawn on in its own color as
 * it is picked, menuMaps.ts; the course map opens the full city map on that
 * course), then the setup step (what is about to start, the build to race
 * in, rivals, difficulty and driving aids, Start). A pip trio in the header says which step this is.
 * Settings opens the settings panel as a step.
 *
 * Steps slide: deeper pushes the old step out to the left as the new one
 * cascades in from the right, back reverses it, and the camera behind the menu
 * moves with them (onStep; game/streetCameras.ts). Every step keeps the title
 * block on top (the boot splash lands on `.title-lockup`, see ui/splash/splash.ts);
 * Escape or the back button goes back a step. Arrow keys walk the home list and
 * the race type grid (1 to 6 pick one); the ? in the bottom left (ui/panels/help.ts)
 * lists each step's keys and tips, with Hide the menu (H) as a button for touch
 * screens. The caller feeds the
 * cruising car's pose every frame (MainMenu.frame) for the maps' car markers.
 */
import { bem, btn, chip, h, iconBtn, scrollHint, segmented, sheen, specChip } from '../kit/dom';
import {
  Anchor,
  Calendar,
  Check,
  ChevronRight,
  ChevronsRight,
  ChevronsUpDown,
  CircleDot,
  Compass,
  Drone,
  Flag,
  Ghost,
  Landmark,
  MapIcon,
  MapPinned,
  Mountain,
  MountainSnow,
  Pencil,
  Play,
  RotateCcw,
  Route,
  Settings as SettingsIcon,
  Shuffle,
  SlidersHorizontal,
  SquareParking,
  Store,
  TrainFront,
  Gauge,
  Trees,
  Undo2,
  Users,
  Video,
  Waves,
  Wind,
  Wrench,
  X,
  type IconNode,
  icon,
} from '../kit/icons';
import { RACE_TYPES, type Difficulty, type RaceType, type Settings } from '../settings';
import { onOff, settingRow, settingsPanel } from '../screens/settingsPanel';
import { RailSteps, navRow, railScreen, screenHead } from '../rail/rail';
import { Help, MUSIC_KEYS, type HelpKey } from '../panels/help';
import { formatTime } from '../kit/format';
import { roadDistance } from '../kit/units';
import { CityOverview, CourseMap, courseRoute, type CourseRoutes, type MapPose } from './menuMaps';
import { courseBest, courseFacts, raceTicket } from './raceTicket';
import { KINDS, layersOf } from '../map/cityMap';
import { DRAG_OPPONENTS, MAX_OPPONENTS, type RaceMode } from '../../sim/race';
import { driftZones } from '../../sim/driftZones';
import { CITY } from '../../city/config';
import type { World } from '../../city/world';
import type { Vec2 } from '../../sim/math';
import type { AreaKind } from '../../city/districts/types';
import type { BestRecord } from '../../replay/replay';
import type { MusicPlayer } from '../../audio/musicPlayer';
import type { SpecBadge } from '../../shared/carSpec';
import { uiBlip, uiWhoosh } from '../../audio/uiSound';

/** The title's words: one line, sized to the menu's column in the menu and on the splash alike (`.title-lockup__title .logo` in _title-lockup.scss). */
export const TITLE_WORDS = ['STREET', 'SCENE'] as const;
export const TAGLINE = 'midnight street racing club';

/** The title's words as spans, with a space between so its text reads "STREET SCENE"; the splash fills them letter by letter. */
export function titleWords(word: (text: string) => (Node | string)[] = (t) => [t]): (Node | string)[] {
  return TITLE_WORDS.flatMap((t, i) => [...(i ? [' '] : []), h('span', { class: 'logo__word' }, ...word(t))]);
}

export type MenuStep = 'home' | 'race' | 'setup' | 'settings';

/** A garage build as the menu shows it: its name, its car and the car's spec tags (drivetrain, engine, forced induction). */
export interface MenuBuild {
  name: string;
  car: string;
  tags: SpecBadge[];
}

export interface MenuOptions {
  seed: string;
  isDaily: boolean;
  /** The seed's named event (city/events.ts), the event card's headline. */
  event?: { name: string; tagline: string };
  /** The event city: the home map, the courses' backdrop and what the city has. */
  world: World;
  /** The event's courses (the drift lap runs the circuit; the waypoint race's is its suggested route). */
  routes: CourseRoutes;
  bests: Record<RaceMode, BestRecord | null>;
  /** The garage's builds, for the Garage row and the setup step's car pick. */
  builds: MenuBuild[];
  /** The build in use (an index into builds). */
  build: number;
  /** The setup step picked another build: the garage's current slot (and the car on the street) follows it. */
  onBuild(i: number): void;
  hasReplay: boolean;
  /** A copy of the settings: the race and settings steps change it and report each change through onSettings. */
  settings: Settings;
  music?: MusicPlayer;
  /** The step to open on (default home), without the slide. */
  step?: MenuStep;
  onSettings(s: Settings): void;
  /** Start the picked race type with the race options in `settings`. */
  onRace(type: RaceType): void;
  onGarage(): void;
  onReplay(): void;
  /** Explore: the drone flyover of the event city. */
  onDrone(): void;
  /** Open the full city map over the menu: the whole city, or on a race type's course (the race step's map). */
  onMap(type?: RaceType): void;
  /** The waypoint free roam will steer to, set on the map (the menu's maps pin it). */
  waypoint?: () => Vec2 | null;
  onSeed(seed: string | null): void;
  /** Hide every piece of UI to watch the menu city (H); any key or click brings it back. */
  onHideUi(): void;
  /** The step changed: the camera behind the menu moves with it. */
  onStep?(step: MenuStep): void;
}

export interface MainMenu {
  readonly root: HTMLElement;
  readonly step: MenuStep;
  /** Every frame the menu is up: the cruising car's pose, for the maps' car markers. */
  frame(pose: MapPose): void;
  dispose(): void;
}

/** Each race type: name, icon, laps, what Start says and its row's sub (the record replaces it once set). */
const TYPE_INFO: Record<RaceType, { label: string; icon: IconNode; sub: string; start: string; laps?: number }> = {
  circuit: { label: 'Circuit', icon: RotateCcw, sub: '3 laps', start: 'Start circuit', laps: 3 },
  sprint: { label: 'Sprint', icon: Route, sub: 'A to B', start: 'Start sprint' },
  drag: { label: 'Drag', icon: ChevronsRight, sub: 'Head to head', start: 'Start drag' },
  waypoint: { label: 'Waypoint', icon: MapPinned, sub: 'Any streets', start: 'Start waypoint race' },
  drift: { label: 'Drift', icon: Wind, sub: 'Score attack', start: 'Start drift', laps: 2 },
  roam: { label: 'Free roam', icon: Compass, sub: 'No rules', start: 'Start free roam' },
};

/**
 * What makes a city this city, for the event card's chips, in the order they
 * are worth naming (the first three present are shown). Each chip takes its
 * district's map ink, so the chips read as a legend of the map above them.
 */
const FEATURES: { kind: AreaKind; icon: IconNode; one: string; many?: (n: number) => string }[] = [
  { kind: 'river', icon: Waves, one: 'River channel' },
  { kind: 'lake', icon: Waves, one: 'Lake' },
  { kind: 'subway', icon: TrainFront, one: 'The El' },
  { kind: 'highway', icon: Gauge, one: 'The expressway' },
  { kind: 'market', icon: Store, one: 'Night market' },
  { kind: 'monument', icon: Landmark, one: 'Monument' },
  { kind: 'hills', icon: Mountain, one: 'The hills' },
  { kind: 'bluff', icon: MountainSnow, one: 'The bluff' },
  { kind: 'waterfront', icon: Anchor, one: 'Waterfront' },
  { kind: 'alley', icon: Route, one: 'Raceway alley', many: (n) => `${n} raceway alleys` },
  { kind: 'roundabout', icon: CircleDot, one: 'Roundabout', many: (n) => `${n} roundabouts` },
  { kind: 'park', icon: Trees, one: 'Park', many: (n) => `${n} parks` },
  { kind: 'carPark', icon: SquareParking, one: 'Parking garage', many: (n) => `${n} parking garages` },
];

/** The other places on home, each in its own hue (rail.ts navRow). */
const PLACES_INFO = {
  garage: { icon: Wrench, label: 'Garage', hue: 'orange' },
  explore: { icon: Drone, label: 'Explore', hue: 'cyan' },
  settings: { icon: SettingsIcon, label: 'Settings', hue: 'purple' },
} as const;

/** Columns of the race step's type grid (`.mode-grid` in _mode-grid.scss): the arrow keys move a row by this many types. */
const MODE_COLUMNS = 3;
const GRID_MOVES: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: MODE_COLUMNS, ArrowUp: -MODE_COLUMNS };

/** How deep each step sits, so a move deeper slides forward (left) and a move out slides back. */
const STEP_DEPTH: Record<MenuStep, number> = { home: 0, race: 1, settings: 1, setup: 2 };

/** Today's event's date as its seed counts it (the UTC day, seed.ts dailySeed): "Sat, Oct 24". */
function todayLabel(now = new Date()): string {
  return now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A row of the home menu's list (its element class names the place, for focus). */
function navItem(kind: keyof typeof PLACES_INFO, sub: string, onClick: () => void, label: string | Node = PLACES_INFO[kind].label): HTMLButtonElement {
  const info = PLACES_INFO[kind];
  return navRow(info.icon, label, sub, info.hue, onClick, `menu__${kind}`);
}

/** A race type in the race step's row: icon over its name, the number key that picks it, its color when picked. */
function modeTile(t: RaceType, n: number, onClick: () => void): HTMLButtonElement {
  const info = TYPE_INFO[t];
  return h(
    'button',
    { class: `mode-tile mode-${t}`, type: 'button', role: 'radio', title: `${info.label} (${n + 1})`, onclick: onClick },
    icon(info.icon, { size: 22 }),
    h('span', { class: 'mode-tile__label' }, info.label),
    h('kbd', { class: 'mode-tile__key', 'aria-hidden': 'true' }, String(n + 1)),
    sheen(),
  );
}

/** A build's spec tags in their inks, small. */
function buildTags(b: MenuBuild): HTMLElement {
  return h('span', { class: 'build-line__tags' }, ...b.tags.map((t, i) => specChip(t, i, '--small')));
}

/** The city's notable districts as chips in their map inks (at most three). */
function cityFeatures(world: World): HTMLElement | null {
  const counts = new Map<AreaKind, number>();
  for (const a of world.areas) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  const chips = FEATURES.filter((f) => counts.get(f.kind))
    .slice(0, 3)
    .map((f) => {
      const n = counts.get(f.kind)!;
      const c = chip(n > 1 && f.many ? f.many(n) : f.one, f.icon, '--ink');
      c.style.setProperty('--ink', KINDS[f.kind]?.ink ?? 'var(--soft)');
      return c;
    });
  return chips.length ? h('div', { class: 'event-card__feats', 'aria-label': 'In this city' }, ...chips) : null;
}

export function mainMenu(o: MenuOptions): MainMenu {
  const s = o.settings;
  const menu = h('div', { class: 'rail__col menu' });
  // The step's keys and tips behind the ? in the corner (KEYS and TIPS below, read when it opens).
  const help = new Help({ title: 'Menu', sections: () => helpFor(step) });
  const root = railScreen('menu-screen', menu, help.el);
  // The title block is what the boot splash lands on (same structure as the splash's, see ui/splash/splash.ts).
  const head = h(
    'div',
    { class: 'title-lockup' },
    h('div', { class: 'title-lockup__title' }, h('h1', { class: 'logo' }, ...titleWords()), h('div', { class: 'title-lockup__rule', 'aria-hidden': 'true' })),
    h('div', { class: 'title-lockup__tagline' }, TAGLINE),
  );
  menu.append(head);
  let step: MenuStep = 'home';
  let build = Math.max(0, Math.min(o.builds.length - 1, o.build));
  const rail = new RailSteps(menu);
  // The maps of the step on screen; frame() moves their car markers.
  let overview: CityOverview | null = null;
  let course: CourseMap | null = null;
  // Build the map layers now, while the boot splash is still up, not on the first visit to a map.
  layersOf(o.world);

  const best = (m: RaceMode) => {
    const b = o.bests[m];
    return b ? (m === 'drift' ? `${Math.round(b.score ?? 0).toLocaleString()} pts` : formatTime(b.time)) : null;
  };

  /** The seed: a chip with quiet actions; editing swaps the chip for a field (Enter applies, Escape cancels). */
  const seedControl = (): HTMLElement => {
    const box = h('div', { class: 'seed-control' });
    const show = () =>
      box.replaceChildren(
        h('span', { class: 'seed-control__value', title: 'City seed' }, `#${o.seed}`),
        iconBtn(Pencil, 'Type a seed', edit, '--small --ghost'),
        iconBtn(Shuffle, 'Random city', () => o.onSeed(String(Math.floor(Math.random() * 1e8))), '--small --ghost'),
      );
    const edit = () => {
      const input = h('input', { type: 'text', class: 'mono seed-control__input', value: o.seed, maxlength: 32, 'aria-label': 'Seed', placeholder: 'Type a seed' }) as HTMLInputElement;
      const apply = () => o.onSeed(input.value.trim() || null);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') apply();
        else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          show();
          box.querySelector<HTMLElement>('button')?.focus();
        }
      });
      box.replaceChildren(input, iconBtn(Check, 'Use seed', apply, '--small'), iconBtn(X, 'Cancel', show, '--small --ghost'));
      input.focus();
      input.select();
    };
    show();
    return box;
  };

  /** Tonight's event: what it is, the city it runs in (live map and its districts), and the way in. */
  const eventCard = (): HTMLElement => {
    const enter = btn(Flag, 'Race', () => go('race'), '--large --primary --cta event-card__go');
    enter.title = 'Pick the race type and rivals, then start';
    enter.append(icon(ChevronRight, { size: 20 }));
    // Away from today's city, the way back stands beside Race: as plain as Race, dated so it reads as today's.
    const today = !o.isDaily && btn(Undo2, "Today's race", () => o.onSeed(null), '--large event-card__today', todayLabel());
    if (today) today.title = "Back to today's event city";
    overview = new CityOverview(o.world);
    const map = h(
      'button',
      { class: 'event-map', type: 'button', title: 'Open the city map', 'aria-label': 'Open the city map', onclick: () => o.onMap() },
      overview.el,
      // The arrow on the map is the car on screen, cruising the city right now.
      h('span', { class: 'map-live' }, h('i', { class: 'map-live__dot' }), 'Live'),
      h('span', { class: 'map-hint' }, icon(MapIcon, { size: 13 }), 'City map'),
      sheen(),
    );
    return h(
      'section',
      { class: 'event-card', 'aria-label': 'Event' },
      h('div', { class: 'event-card__top' }, h('span', { class: 'label label--kicker' }, icon(Calendar, { size: 14 }), o.isDaily ? 'Event of the day' : 'Custom event'), seedControl()),
      h('h2', { class: 'event-card__name' }, o.event?.name ?? 'Street race'),
      o.event && h('p', { class: 'event-card__tagline' }, o.event.tagline),
      map,
      cityFeatures(o.world),
      today ? h('div', { class: 'event-card__actions' }, enter, today) : enter,
    );
  };

  const home = (): HTMLElement[] => [
    eventCard(),
    h(
      'nav',
      { class: 'nav-list', 'aria-label': 'Main menu' },
      // The build in use under Garage, its spec tags beside the word.
      navItem('garage', `${o.builds[build].name} · ${o.builds[build].car}`, o.onGarage, h('span', { class: 'build-line' }, h('span', { class: 'build-line__name' }, PLACES_INFO.garage.label), buildTags(o.builds[build]))),
      navItem('explore', 'Fly a drone over the event city', o.onDrone),
      navItem('settings', 'Display, sound, controls', () => go('settings')),
    ),
  ];

  /** What a type's course is, in a few facts: laps and length, A to B, the zones, the streets. */
  const factsOf = (t: RaceType): string[] => {
    const r = o.routes;
    switch (t) {
      case 'circuit':
        return [`${TYPE_INFO.circuit.laps} laps`, `${roadDistance(r.circuit.length)} lap`, `${r.circuit.tightCorners} tight turns`];
      case 'sprint':
        return ['A to B', roadDistance(r.sprint.finishS - r.sprint.startS), `${r.sprint.tightCorners} tight turns`];
      case 'drag':
        return [`${Math.round((r.drag.finishS - r.drag.startS) / CITY.spacing)} blocks`, roadDistance(r.drag.finishS - r.drag.startS), 'Head to head'];
      case 'waypoint': {
        const n = (r.waypoint.waypoints?.length ?? 1) - 1;
        return [`${n} waypoints`, `${roadDistance(r.waypoint.finishS - r.waypoint.startS)} suggested`, 'Any streets'];
      }
      case 'drift': {
        const zones = driftZones(o.world).length;
        return [`${TYPE_INFO.drift.laps} laps`, zones === 1 ? '1 drift zone' : `${zones} drift zones`, 'Solo'];
      }
      case 'roam':
        return ['Whole city', `${roadDistance(layersOf(o.world).streetLength)} of streets`, 'Traffic'];
    }
  };

  /** Where a step stands in the race flow (home, race type, setup): pips beside the screen title's aside. */
  const progress = (at: number, aside: HTMLElement): HTMLElement =>
    h(
      'span',
      { class: 'screen-head__aside' },
      h('span', { class: 'stepper', role: 'img', 'aria-label': `Step ${at} of 3` }, ...[1, 2, 3].map((i) => h('i', { class: i < at ? 'stepper__pip is-done' : i === at ? 'stepper__pip is-current' : 'stepper__pip' }))),
      aside,
    );

  /** Step 2: the race types in a grid (two rows of three) over the course card, the picked type's course drawn on in its color; then on to the setup. */
  const race = (): HTMLElement[] => {
    const types = h('div', { class: 'mode-grid', role: 'radiogroup', 'aria-label': 'Race type' });
    const typeTiles = RACE_TYPES.map((t, i) => {
      const b = modeTile(t, i, () => pick(t));
      types.append(b);
      return b;
    });
    // The course map opens the city map on the picked course.
    course = new CourseMap(o.world, o.routes, () => o.onMap(s.raceType));
    // Announced when the type changes, so the course's facts reach a screen reader too.
    const courseHead = h('div', { class: 'course-card__head', 'aria-live': 'polite' });
    const courseCard = h('section', { class: 'course-card', 'aria-label': 'Course' }, courseHead, course.el);
    const next = btn(SlidersHorizontal, '', () => go('setup'), '--large --primary --cta step-foot__next');
    next.append(icon(ChevronRight, { size: 20 }));
    const replay = btn(Video, 'Replay', o.onReplay, 'step-foot__replay', o.hasReplay ? 'Last race' : 'No race yet');
    if (!o.hasReplay) replay.setAttribute('disabled', '');
    const refresh = (animate: boolean) => {
      const t = s.raceType;
      root.dataset.mode = t;
      typeTiles.forEach((b, i) => {
        const on = RACE_TYPES[i] === t;
        b.classList.toggle('is-selected', on);
        b.setAttribute('aria-checked', String(on));
      });
      course!.show(t, animate);
      const info = TYPE_INFO[t];
      const record = t === 'roam' ? null : best(t);
      const swap = animate ? 'is-swapping' : '';
      courseHead.replaceChildren(
        h('div', { class: bem('course-card__title', swap) }, h('span', { class: 'course-name' }, icon(info.icon, { size: 18 }), info.label), courseFacts(factsOf(t))),
        // Free roam keeps no records.
        ...(t === 'roam' ? [] : [courseBest(record, swap)]),
      );
      next.querySelector('.btn__label')!.textContent = `Set up ${info.label.toLowerCase()}`;
    };
    const pick = (t: RaceType) => {
      if (t === s.raceType) return;
      s.raceType = t;
      o.onSettings(s);
      uiBlip();
      refresh(true);
    };
    pickType = (t) => pick(t);
    refresh(false);
    return [
      screenHead({ icon: Flag, title: 'Race', back: () => go('home'), aside: progress(2, chip(o.event?.name ?? `#${o.seed}`, undefined, '--accent')) }),
      types,
      courseCard,
      h('div', { class: 'step-foot' }, replay, next),
    ];
  };
  /** Pick a race type on the race step (arrow and number keys). */
  let pickType: ((t: RaceType) => void) | null = null;

  /**
   * The setup step's model card: the build in use as one row (its slot, name, car and spec tags) that
   * drops the garage's builds down as a list over the cards below, so the card stays one row tall
   * however many builds there are. The list hangs in the menu screen, not in the step: the step's
   * cards scroll on a short screen, and their box would clip it. It is placed under the card when it
   * opens (over it, when there is more room above), and closes on a scroll or resize rather than
   * chase the card. A row in the list, the up and down keys or a number key picks a build and
   * swaps the car on the street; Escape, a pick or a click elsewhere closes the list. The rows run in
   * slot order, like the line of cars the picks build up there.
   */
  let turnBuild: ((to: number, relative: boolean) => void) | null = null;
  /** Close the open build list; false when it was not open. */
  let closeBuilds: (() => boolean) | null = null;
  const buildPick = (): HTMLElement => {
    const n = o.builds.length;
    const rowParts = (b: MenuBuild, i: number) => [
      h('span', { class: 'build-pick__slot' }, String(i + 1)),
      h('span', { class: 'build-pick__text' }, h('span', { class: 'build-pick__name' }, b.name), h('span', { class: 'build-pick__car' }, b.car)),
      buildTags(b),
    ];
    const current = h('button', { class: 'build-pick__row build-pick__row--current', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' });
    const rows = o.builds.map((b, i) => {
      const row = h('button', { class: 'build-pick__row', type: 'button', role: 'option', title: `${b.name} · ${b.car}` }, ...rowParts(b, i));
      row.addEventListener('click', () => {
        choose(i);
        close();
        current.focus({ preventScroll: true });
      });
      return row;
    });
    const list = h('div', { class: 'build-pick__list', role: 'listbox', 'aria-label': 'Build' }, ...rows);
    // The wrapper casts the drop shadow the list's chamfer would clip.
    const drop = h('div', { class: 'build-pick__drop' }, list);
    const el = h('div', { class: 'build-pick' }, h('div', { class: 'build-pick__head' }, h('div', { class: 'section-title' }, 'Model'), h('span', { class: 'build-pick__count' }, n > 1 ? `${n} builds` : 'Only build')), current);
    // A little air between the list and the card, and between the list and the screen's edge (px).
    const GAP = 4;
    const EDGE = 12;
    const place = () => {
      const r = el.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      const below = box.bottom - r.bottom - GAP - EDGE;
      const above = r.top - box.top - GAP - EDGE;
      list.style.maxHeight = '';
      const up = list.scrollHeight > below && above > below;
      drop.classList.toggle('is-up', up);
      drop.style.left = `${r.left - box.left}px`;
      drop.style.width = `${r.width}px`;
      drop.style.top = up ? '' : `${r.bottom - box.top + GAP}px`;
      drop.style.bottom = up ? `${box.bottom - r.top + GAP}px` : '';
      list.style.maxHeight = `${Math.max(120, up ? above : below)}px`;
    };
    const show = () => {
      current.replaceChildren(...rowParts(o.builds[build], build));
      if (n > 1) current.append(icon(ChevronsUpDown, { size: 16 }));
      rows.forEach((r, i) => {
        r.classList.toggle('is-selected', i === build);
        r.setAttribute('aria-selected', String(i === build));
      });
    };
    const choose = (i: number) => {
      if (i === build) return;
      build = i;
      show();
      o.onBuild(build);
      uiBlip();
    };
    // A press outside the card and its list, a scroll anywhere but in the list, or a resize closes it.
    const outside = (e: PointerEvent) => {
      if (!el.contains(e.target as Node) && !drop.contains(e.target as Node)) close();
    };
    const scrolled = (e: Event) => {
      if (!drop.contains(e.target as Node)) close();
    };
    const resized = () => close();
    const open = (on: boolean) => {
      el.classList.toggle('is-open', on);
      current.setAttribute('aria-expanded', String(on));
      if (on) {
        root.append(drop);
        place();
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('scroll', scrolled, true);
        window.addEventListener('resize', resized);
      } else {
        drop.remove();
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('scroll', scrolled, true);
        window.removeEventListener('resize', resized);
      }
    };
    const close = () => {
      const was = el.classList.contains('is-open');
      if (was) open(false);
      return was;
    };
    if (n > 1) current.addEventListener('click', () => open(!el.classList.contains('is-open')));
    else current.disabled = true;
    turnBuild = n > 1 ? (to, relative) => choose(relative ? (build + to + n) % n : to) : null;
    closeBuilds = close;
    show();
    return el;
  };

  /** Step 3: what is about to start (its course drawn small, its facts, your best), the build to race in on its own card, rivals and driving aids, and Start. */
  const setup = (): HTMLElement[] => {
    const t = s.raceType;
    const info = TYPE_INFO[t];
    root.dataset.mode = t;
    const record = t === 'roam' ? null : best(t);
    const ticket = raceTicket({ mode: t, title: info.label, label: 'Race', facts: factsOf(t), route: t === 'roam' ? null : courseRoute(o.routes, t), best: record });
    // Drift is a solo score attack and free roam has no rules: the card says so instead of offering rivals.
    const solo = t === 'drift' || t === 'roam';
    const difficultyRow = () =>
      settingRow(
        'AI difficulty',
        segmented<Difficulty>(
          [
            { value: 'easy', label: 'Easy' },
            { value: 'medium', label: 'Medium' },
            { value: 'hard', label: 'Hard' },
          ],
          s.difficulty,
          (v) => {
            s.difficulty = v;
            o.onSettings(s);
          },
        ),
      );
    let rivals: HTMLElement;
    if (solo) {
      rivals = h('div', { class: 'race-setup__group' }, h('div', { class: 'section-title' }, 'Rivals'), h('p', { class: 'setting-note setting-note--solo' }, icon(Ghost, { size: 14 }), t === 'drift' ? 'Drift is a solo score attack: just you, the zones and the clock.' : 'Free roam has no rivals and no clock: the city is yours.'));
    } else if (t === 'drag') {
      // A drag is always head to head: the field is fixed, only how hard the rival launches is the player's.
      rivals = h(
        'div',
        { class: 'race-setup__group' },
        h('div', { class: 'section-title' }, 'Rivals'),
        h('p', { class: 'setting-note setting-note--solo' }, icon(Users, { size: 14 }), `Head to head: ${DRAG_OPPONENTS} rival in the next lane, first to the line wins.`),
        difficultyRow(),
      );
    } else {
      const oppHint = h('span', { class: 'field__hint' });
      const hint = () => oppHint.replaceChildren(...(s.opponents ? [icon(Users, { size: 12 }), ` ${s.opponents} on the grid`] : [icon(Ghost, { size: 12 }), ' Solo: race your best ghost']));
      const opponents = segmented(
        Array.from({ length: MAX_OPPONENTS + 1 }, (_, i) => ({ value: String(i), label: String(i) })),
        String(s.opponents),
        (v) => {
          s.opponents = Number(v);
          o.onSettings(s);
          hint();
        },
      );
      opponents.classList.add('segmented--wide');
      opponents.setAttribute('aria-label', 'Opponents');
      hint();
      rivals = h(
        'div',
        { class: 'race-setup__group' },
        h('div', { class: 'section-title' }, 'Rivals'),
        h('div', { class: 'field' }, h('div', { class: 'field__head' }, h('span', { class: 'field__name' }, 'Opponents'), oppHint), opponents),
        difficultyRow(),
      );
    }
    const driving = h(
      'div',
      { class: 'race-setup__group' },
      h('div', { class: 'section-title' }, 'Driving'),
      settingRow('Manual gearbox', onOff(s.manualGearbox, (v) => ((s.manualGearbox = v), o.onSettings(s))), 'Q / E to shift'),
      settingRow('Traction control', onOff(s.tractionControl, (v) => ((s.tractionControl = v), o.onSettings(s))), 'Off lets the rear step out'),
    );
    const start = btn(Play, info.start, () => o.onRace(t), '--large --primary --cta step-foot__start');
    return [
      screenHead({ icon: SlidersHorizontal, title: 'Setup', back: () => go('race'), aside: progress(3, chip(info.label, info.icon, `--mode mode-${t}`)) }),
      ticket,
      buildPick(),
      h('div', { class: 'race-setup' }, rivals, driving),
      h('div', { class: 'step-foot' }, start),
    ];
  };

  const settings = (): HTMLElement[] => [screenHead({ icon: SettingsIcon, title: 'Settings', back: () => go('home') }), settingsPanel(s, o.onSettings, o.music)];

  // Hide the menu is a button in the panel too, for touch screens.
  const hideUi: HelpKey = { keys: ['H'], label: 'Hide the menu and watch the city', action: () => o.onHideUi() };
  const KEYS: Record<MenuStep, HelpKey[]> = {
    home: [{ keys: ['↑', '↓'], label: 'Walk the menu' }, { keys: ['Enter'], label: 'Choose' }, hideUi],
    race: [{ keys: ['←', '→', '↑', '↓'], label: 'Race type' }, { keys: ['1–6'], label: 'Pick a type by its place' }, { keys: ['Enter'], label: 'Next' }, { keys: ['Esc'], label: 'Back' }, hideUi],
    setup: [...(o.builds.length > 1 ? [{ keys: ['↑', '↓'], label: 'Build' }, { keys: [`1–${o.builds.length}`], label: 'Pick a build by its slot' }] : []), { keys: ['Enter'], label: 'Start' }, { keys: ['Esc'], label: 'Back' }, hideUi],
    settings: [{ keys: ['Esc'], label: 'Back' }, hideUi],
  };
  const TIPS: Record<MenuStep, string[]> = {
    home: ["Every day brings a new event city. Beside its name the pencil types a seed of your own and shuffle rolls a random city; Today's race beside Race brings you back.", 'The live map opens the whole city; a waypoint set there carries into free roam.'],
    race: ['Each type draws its course on the card, with your best on this event.'],
    setup: ['Your car opens the garage\'s builds; each one you pick joins the line of cars on the street.', 'Rivals and driving aids are remembered for your next race.'],
    settings: ['Controls lists every key, gamepad button and touch control.'],
  };
  const helpFor = (at: MenuStep) => [
    { title: 'Keys', keys: KEYS[at] },
    { title: 'Music', keys: MUSIC_KEYS },
    { title: 'Tips', tips: TIPS[at] },
  ];

  const steps: Record<MenuStep, () => HTMLElement[]> = { home, race, setup, settings };

  /**
   * A step's cards between its header and its foot, in a box that scrolls when the screen is too short
   * for them, with the kit's fades and chevrons at the edges that hold more (scrollHint, as the garage's
   * body): the header and the foot (Next, Start) stay on screen. Settings keeps its own scrolling pane.
   */
  const scrolling = (parts: HTMLElement[]): HTMLElement[] => {
    const head = parts[0]?.classList.contains('screen-head') ? 1 : 0;
    const foot = parts.at(-1)?.classList.contains('step-foot') ? 1 : 0;
    const body = h('div', { class: 'menu-screen__body' }, ...parts.slice(head, parts.length - foot));
    return [...parts.slice(0, head), scrollHint(body, 'menu-screen__scroll'), ...parts.slice(parts.length - foot)];
  };
  function go(next: MenuStep, animate = true): void {
    const from = step;
    step = next;
    root.dataset.step = next;
    if (next !== 'race' && next !== 'setup') delete root.dataset.mode;
    overview?.dispose();
    course?.dispose();
    overview = course = null;
    pickType = null;
    turnBuild = null;
    closeBuilds?.();
    closeBuilds = null;
    const fwd = STEP_DEPTH[next] > STEP_DEPTH[from];
    const parts = steps[next]();
    if (rail.show(next === 'settings' ? parts : scrolling(parts), animate ? (fwd ? 'fwd' : 'back') : null)) uiWhoosh(fwd);
    const el = rail.current!;
    help.close();
    if (next !== from || !animate) o.onStep?.(next);
    if (!animate) return;
    // Keep keyboard and gamepad focus on the menu: the step's main action, or where the player came back from.
    const focus = {
      home: from === 'settings' ? '.menu__settings' : '.event-card__go',
      race: '.step-foot__next',
      setup: '.step-foot__start',
      settings: '.settings__tab.is-selected',
    }[next];
    el.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
  }
  go(o.step ?? 'home', false);

  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return window.removeEventListener('keydown', onKey);
    if (document.body.classList.contains('is-cinematic') || e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
    // The full map over the menu keeps the keys to itself.
    if (typing || root.parentElement?.querySelector('.full-map')) return;
    if (e.key === 'Escape' && closeBuilds?.()) {
      // The open build list closes first; the next Escape goes back a step.
      e.preventDefault();
    } else if (e.key === 'Escape' && step !== 'home') {
      e.preventDefault();
      go(step === 'setup' ? 'race' : 'home');
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && step === 'home') {
      // Up and down walk the home menu: the map, the race button, then the list.
      const items = [...(rail.current?.querySelectorAll<HTMLElement>('.event-map, .event-card__go, .nav-row') ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? items.findIndex((x) => x.classList.contains('event-card__go')) : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      e.preventDefault();
      items[next]?.focus();
    } else if (step === 'race' && pickType && !e.repeat) {
      // Left and right step through the race types, up and down change rows of the grid; 1 to 6 pick one.
      const at = RACE_TYPES.indexOf(s.raceType);
      const n = RACE_TYPES.length;
      const move = GRID_MOVES[e.key];
      if (move) {
        e.preventDefault();
        pickType(RACE_TYPES[(at + move + n) % n]);
      } else if (e.key >= '1' && e.key <= String(n) && e.key.length === 1) pickType(RACE_TYPES[Number(e.key) - 1]);
    } else if (step === 'setup' && turnBuild && !e.repeat) {
      // Up and down (or left and right) walk the garage's builds; 1 to the last slot pick one.
      const move = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (move) {
        e.preventDefault();
        turnBuild(move, true);
      } else if (e.key >= '1' && e.key <= String(o.builds.length) && e.key.length === 1) turnBuild(Number(e.key) - 1, false);
    }
  };
  window.addEventListener('keydown', onKey);
  return {
    root,
    get step() {
      return step;
    },
    frame(pose) {
      const wp = o.waypoint?.() ?? null;
      overview?.update(pose, wp);
      course?.update(pose, wp);
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      help.dispose();
      overview?.dispose();
      course?.dispose();
    },
  };
}
