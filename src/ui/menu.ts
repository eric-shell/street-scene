/**
 * The main menu, in steps so no pane tries to do everything, on the rail
 * (ui/rail.ts) beside the event city, where the player's car cruises the
 * route. Home is the title block over the event card (tonight's event: its
 * name and tagline, the seed with edit, shuffle and back-to-today, the city as
 * a tilted live map with what makes it this city, and the way into the race)
 * over a list of the other places: Garage, Explore (the drone flyover) and
 * Settings. Home says nothing about the race itself, so no type is implied
 * before the player picks one. A race takes three steps, each short enough
 * to fit the column without scrolling: home, then the race step (the types in
 * a row over the course card, each type's course drawn on in its own color as
 * it is picked, ui/menuMaps.ts; the course map opens the full city map on that
 * course), then the setup step (what is about to start, rivals, difficulty
 * and driving aids, Start). A pip trio in the header says which step this is.
 * Settings opens the settings panel as a step.
 *
 * Steps slide: deeper pushes the old step out to the left as the new one
 * cascades in from the right, back reverses it, and the camera behind the menu
 * moves with them (onStep; game/streetCameras.ts). Every step keeps the title
 * block on top (the boot splash lands on `.menu-head`, see ui/splash.ts);
 * Escape or the back button goes back a step. Arrow keys walk the home list and
 * switch race types (1 to 4 pick one); the key legend along the bottom carries
 * Hide UI (H), which stays a button on touch screens. The caller feeds the
 * cruising car's pose every frame (MainMenu.frame) for the maps' car markers.
 */
import { btn, h, iconBtn, segmented, sheen } from './dom';
import {
  Anchor,
  Calendar,
  Check,
  ChevronRight,
  CircleDot,
  Compass,
  Drone,
  Flag,
  Ghost,
  Landmark,
  MapIcon,
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
  Trees,
  Trophy,
  Undo2,
  Users,
  Video,
  Waves,
  Wind,
  Wrench,
  X,
  type IconNode,
  icon,
} from './icons';
import { RACE_TYPES, type Difficulty, type RaceType, type Settings } from './settings';
import { onOff, settingRow, settingsPanel } from './screens';
import { chip, keybar, navRow, railScreen, screenHead, swapStep, type KeyHint } from './rail';
import { formatTime } from './format';
import { CityOverview, CourseMap, courseArt, type CourseRoutes, type MapPose } from './menuMaps';
import { KINDS, layersOf } from './cityMap';
import { MAX_OPPONENTS, type RaceMode } from '../sim/race';
import { driftZones } from '../sim/driftZones';
import type { World } from '../city/world';
import type { Vec2 } from '../sim/math';
import type { AreaKind } from '../city/districts/types';
import type { BestRecord } from '../replay/replay';
import type { MusicPlayer } from '../audio/musicPlayer';
import { uiBlip, uiWhoosh } from '../audio/uiSound';

/** The title's words: one line, sized to the menu's column in the menu and on the splash alike (ui.css `.head-title .logo`). */
export const TITLE_WORDS = ['STREET', 'SCENE'] as const;
export const TAGLINE = 'Street racing after dark';

/** The title's words as spans, with a space between so its text reads "STREET SCENE"; the splash fills them letter by letter. */
export function titleWords(word: (text: string) => (Node | string)[] = (t) => [t]): (Node | string)[] {
  return TITLE_WORDS.flatMap((t, i) => [...(i ? [' '] : []), h('span', { class: 'logo-word' }, ...word(t))]);
}

export type MenuStep = 'home' | 'race' | 'setup' | 'settings';

export interface MenuOptions {
  seed: string;
  isDaily: boolean;
  /** The seed's named event (city/events.ts), the event card's headline. */
  event?: { name: string; tagline: string };
  /** The event city: the home map, the courses' backdrop and what the city has. */
  world: World;
  /** The event's courses (the drift lap runs the circuit). */
  routes: CourseRoutes;
  bests: Record<RaceMode, BestRecord | null>;
  /** The current build's car, for the Garage row. */
  carName: string;
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
  { kind: 'market', icon: Store, one: 'Night market' },
  { kind: 'monument', icon: Landmark, one: 'Monument' },
  { kind: 'hills', icon: Mountain, one: 'The hills' },
  { kind: 'bluff', icon: MountainSnow, one: 'The bluff' },
  { kind: 'waterfront', icon: Anchor, one: 'Waterfront' },
  { kind: 'alley', icon: Route, one: 'Raceway alley', many: (n) => `${n} raceway alleys` },
  { kind: 'roundabout', icon: CircleDot, one: 'Roundabout', many: (n) => `${n} roundabouts` },
  { kind: 'park', icon: Trees, one: 'Park', many: (n) => `${n} parks` },
  { kind: 'carPark', icon: SquareParking, one: 'Car park', many: (n) => `${n} car parks` },
];

/** The other places on home, each in its own hue (rail.ts navRow). */
const PLACES_INFO = {
  garage: { icon: Wrench, label: 'Garage', hue: 'orange' },
  explore: { icon: Drone, label: 'Explore', hue: 'cyan' },
  settings: { icon: SettingsIcon, label: 'Settings', hue: 'purple' },
} as const;

/** How deep each step sits, so a move deeper slides forward (left) and a move out slides back. */
const STEP_DEPTH: Record<MenuStep, number> = { home: 0, race: 1, settings: 1, setup: 2 };

const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

/** A row of the home menu's list (its class names the place, for focus). */
function navItem(kind: keyof typeof PLACES_INFO, sub: string, onClick: () => void): HTMLButtonElement {
  const info = PLACES_INFO[kind];
  return navRow(info.icon, info.label, sub, info.hue, onClick, `nav-${kind}`);
}

/** A race type in the race step's row: icon over its name, the number key that picks it, its color when picked. */
function modeTile(t: RaceType, n: number, onClick: () => void): HTMLButtonElement {
  const info = TYPE_INFO[t];
  return h(
    'button',
    { class: `mode-tile mode-${t}`, type: 'button', role: 'radio', title: `${info.label} (${n + 1})`, onclick: onClick },
    icon(info.icon, { size: 22 }),
    h('span', { class: 'mode-label' }, info.label),
    h('kbd', { class: 'mode-key', 'aria-hidden': 'true' }, String(n + 1)),
    sheen(),
  );
}

/** The city's notable districts as chips in their map inks (at most three). */
function cityFeatures(world: World): HTMLElement | null {
  const counts = new Map<AreaKind, number>();
  for (const a of world.areas) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  const chips = FEATURES.filter((f) => counts.get(f.kind))
    .slice(0, 3)
    .map((f) => {
      const n = counts.get(f.kind)!;
      const c = chip(n > 1 && f.many ? f.many(n) : f.one, f.icon, 'feat');
      c.style.setProperty('--ink', KINDS[f.kind]?.ink ?? 'var(--soft)');
      return c;
    });
  return chips.length ? h('div', { class: 'event-feats', 'aria-label': 'In this city' }, ...chips) : null;
}

export function mainMenu(o: MenuOptions): MainMenu {
  const s = o.settings;
  const menu = h('div', { class: 'menu rail-col' });
  let bar = keybar([]);
  const root = railScreen('home', menu, bar);
  // The title block is what the boot splash lands on (same structure as the splash's, see ui/splash.ts).
  const head = h(
    'div',
    { class: 'menu-head' },
    h('div', { class: 'head-title' }, h('h1', { class: 'logo' }, ...titleWords()), h('div', { class: 'title-rule', 'aria-hidden': 'true' })),
    h('div', { class: 'tagline' }, TAGLINE),
  );
  menu.append(head);
  let step: MenuStep = 'home';
  let current: HTMLElement | null = null;
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
    const box = h('div', { class: 'seed-ctl' });
    const show = () =>
      box.replaceChildren(
        h('span', { class: 'seed', title: 'City seed' }, `#${o.seed}`),
        iconBtn(Pencil, 'Type a seed', edit, 'small ghost'),
        iconBtn(Shuffle, 'Random city', () => o.onSeed(String(Math.floor(Math.random() * 1e8))), 'small ghost'),
        ...(o.isDaily ? [] : [iconBtn(Undo2, "Back to today's event", () => o.onSeed(null), 'small ghost')]),
      );
    const edit = () => {
      const input = h('input', { type: 'text', class: 'mono', value: o.seed, maxlength: 32, 'aria-label': 'Seed', placeholder: 'Type a seed' }) as HTMLInputElement;
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
      box.replaceChildren(input, iconBtn(Check, 'Use seed', apply, 'small'), iconBtn(X, 'Cancel', show, 'small ghost'));
      input.focus();
      input.select();
    };
    show();
    return box;
  };

  /** Tonight's event: what it is, the city it runs in (live map and its districts), and the way in. */
  const eventCard = (): HTMLElement => {
    const enter = btn(Flag, 'Race', () => go('race'), 'big primary event-go cta');
    enter.title = 'Pick the race type and rivals, then start';
    enter.append(icon(ChevronRight, { size: 20 }));
    overview = new CityOverview(o.world);
    const map = h(
      'button',
      { class: 'event-map', type: 'button', title: 'Open the city map', 'aria-label': 'Open the city map', onclick: () => o.onMap() },
      overview.el,
      // The arrow on the map is the car on screen, cruising the city right now.
      h('span', { class: 'event-map-live' }, h('i'), 'Live'),
      h('span', { class: 'event-map-hint' }, icon(MapIcon, { size: 13 }), 'City map'),
      sheen(),
    );
    return h(
      'section',
      { class: 'event-card', 'aria-label': 'Event' },
      h('div', { class: 'event-top' }, h('span', { class: 'label kicker' }, icon(Calendar, { size: 14 }), o.isDaily ? 'Event of the day' : 'Custom event'), seedControl()),
      h('h2', { class: 'event-name' }, o.event?.name ?? 'Street race'),
      o.event && h('p', { class: 'event-tagline' }, o.event.tagline),
      map,
      cityFeatures(o.world),
      enter,
    );
  };

  const home = (): HTMLElement[] => [
    eventCard(),
    h(
      'nav',
      { class: 'nav-list', 'aria-label': 'Main menu' },
      navItem('garage', `${o.carName} · paint, parts, tuning`, o.onGarage),
      navItem('explore', 'Fly a drone over the event city', o.onDrone),
      navItem('settings', 'Display, sound, controls', () => go('settings')),
    ),
  ];

  /** What a type's course is, in a few facts: laps and length, A to B, the zones, the streets. */
  const courseFacts = (t: RaceType): string[] => {
    const r = o.routes;
    switch (t) {
      case 'circuit':
        return [`${TYPE_INFO.circuit.laps} laps`, `${km(r.circuit.length)} lap`, `${r.circuit.tightCorners} tight turns`];
      case 'sprint':
        return ['A to B', km(r.sprint.finishS - r.sprint.startS), `${r.sprint.tightCorners} tight turns`];
      case 'drift': {
        const zones = driftZones(o.world).length;
        return [`${TYPE_INFO.drift.laps} laps`, zones === 1 ? '1 drift zone' : `${zones} drift zones`, 'Solo'];
      }
      case 'roam':
        return ['Whole city', `${km(layersOf(o.world).streetLength)} of streets`, 'Traffic'];
    }
  };

  /** Where a step stands in the race flow (home, race type, setup): pips beside the screen title's aside. */
  const progress = (at: number, aside: HTMLElement): HTMLElement =>
    h(
      'span',
      { class: 'head-aside' },
      h('span', { class: 'stepper', role: 'img', 'aria-label': `Step ${at} of 3` }, ...[1, 2, 3].map((i) => h('i', { class: i < at ? 'done' : i === at ? 'on' : '' }))),
      aside,
    );

  /** Step 2: the race types in a row over the course card, the picked type's course drawn on in its color; then on to the setup. */
  const race = (): HTMLElement[] => {
    const types = h('div', { class: 'mode-row', role: 'radiogroup', 'aria-label': 'Race type' });
    const typeTiles = RACE_TYPES.map((t, i) => {
      const b = modeTile(t, i, () => pick(t));
      types.append(b);
      return b;
    });
    // The course map opens the city map on the picked course.
    course = new CourseMap(o.world, o.routes, () => o.onMap(s.raceType));
    // Announced when the type changes, so the course's facts reach a screen reader too.
    const courseHead = h('div', { class: 'course-head', 'aria-live': 'polite' });
    const courseCard = h('section', { class: 'course-card', 'aria-label': 'Course' }, courseHead, course.el);
    const next = btn(SlidersHorizontal, '', () => go('setup'), 'big primary next cta');
    next.append(icon(ChevronRight, { size: 20 }));
    const replay = btn(Video, 'Replay', o.onReplay, 'replay', o.hasReplay ? 'Last race' : 'No race yet');
    if (!o.hasReplay) replay.setAttribute('disabled', '');
    const refresh = (animate: boolean) => {
      const t = s.raceType;
      root.dataset.mode = t;
      typeTiles.forEach((b, i) => {
        const on = RACE_TYPES[i] === t;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      });
      course!.show(t, animate);
      const info = TYPE_INFO[t];
      const record = t === 'roam' ? null : best(t);
      const swap = animate ? ' swap' : '';
      courseHead.replaceChildren(
        h(
          'div',
          { class: `course-title${swap}` },
          h('span', { class: 'course-name' }, icon(info.icon, { size: 18 }), info.label),
          h('span', { class: 'course-facts' }, ...courseFacts(t).map((f) => h('span', {}, f))),
        ),
        // Free roam keeps no records.
        ...(record ? [h('span', { class: `course-best${swap}`, title: 'Your best on this event' }, icon(Trophy, { size: 14 }), record)] : t === 'roam' ? [] : [h('span', { class: `course-best none${swap}` }, 'No time yet')]),
      );
      next.querySelector('.grow')!.textContent = `Set up ${info.label.toLowerCase()}`;
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
      screenHead({ icon: Flag, title: 'Race', back: () => go('home'), aside: progress(2, chip(o.event?.name ?? `#${o.seed}`, undefined, 'accent')) }),
      types,
      courseCard,
      h('div', { class: 'step-foot' }, replay, next),
    ];
  };
  /** Pick a race type on the race step (arrow and number keys). */
  let pickType: ((t: RaceType) => void) | null = null;

  /** Step 3: what is about to start (its course drawn small, its facts, your best), rivals and driving aids, and Start. */
  const setup = (): HTMLElement[] => {
    const t = s.raceType;
    const info = TYPE_INFO[t];
    root.dataset.mode = t;
    const record = t === 'roam' ? null : best(t);
    const ticket = h(
      'section',
      { class: 'race-ticket', 'aria-label': 'Race' },
      h('span', { class: 'ticket-art' }, t === 'roam' ? icon(Compass, { size: 30 }) : courseArt(t === 'sprint' ? o.routes.sprint : o.routes.circuit, t, 104, 52)),
      h('span', { class: 'ticket-text' }, h('span', { class: 'course-name' }, info.label), h('span', { class: 'course-facts' }, ...courseFacts(t).map((f) => h('span', {}, f)))),
      record && h('span', { class: 'course-best', title: 'Your best on this event' }, icon(Trophy, { size: 14 }), record),
    );
    // Drift is a solo score attack and free roam has no rules: the card says so instead of offering rivals.
    const solo = t === 'drift' || t === 'roam';
    let rivals: HTMLElement;
    if (solo) {
      rivals = h('div', { class: 'race-group' }, h('div', { class: 'section-title' }, 'Rivals'), h('p', { class: 'setting-note solo-note' }, icon(Ghost, { size: 14 }), t === 'drift' ? 'Drift is a solo score attack: just you, the zones and the clock.' : 'Free roam has no rivals and no clock: the city is yours.'));
    } else {
      const oppHint = h('span', { class: 'hint' });
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
      opponents.classList.add('wide');
      opponents.setAttribute('aria-label', 'Opponents');
      const difficulty = segmented<Difficulty>(
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
      );
      hint();
      rivals = h(
        'div',
        { class: 'race-group' },
        h('div', { class: 'section-title' }, 'Rivals'),
        h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('span', { class: 'name' }, 'Opponents'), oppHint), opponents),
        settingRow('AI difficulty', difficulty),
      );
    }
    const driving = h(
      'div',
      { class: 'race-group' },
      h('div', { class: 'section-title' }, 'Driving'),
      settingRow('Manual gearbox', onOff(s.manualGearbox, (v) => ((s.manualGearbox = v), o.onSettings(s))), 'Q / E to shift'),
      settingRow('Traction control', onOff(s.tractionControl, (v) => ((s.tractionControl = v), o.onSettings(s))), 'Off lets the rear step out'),
    );
    const start = btn(Play, info.start, () => o.onRace(t), 'big primary start cta');
    return [
      screenHead({ icon: SlidersHorizontal, title: 'Setup', back: () => go('race'), aside: progress(3, chip(info.label, info.icon, `mode-chip mode-${t}`)) }),
      ticket,
      h('div', { class: 'race-setup' }, rivals, driving),
      h('div', { class: 'step-foot' }, start),
    ];
  };

  const settings = (): HTMLElement[] => [screenHead({ icon: SettingsIcon, title: 'Settings', back: () => go('home') }), settingsPanel(s, o.onSettings, o.music)];

  const hideUi: KeyHint = { keys: ['H'], label: 'Hide UI', action: () => o.onHideUi(), title: 'Hide the menu and watch the city (H)' };
  const KEYS: Record<MenuStep, KeyHint[]> = {
    home: [{ keys: ['↑', '↓'], label: 'Select' }, { keys: ['0'], label: 'Explore' }, { keys: ['M'], label: 'Mute music' }, hideUi],
    race: [{ keys: ['←', '→'], label: 'Race type' }, { keys: ['Enter'], label: 'Next' }, { keys: ['Esc'], label: 'Back' }, hideUi],
    setup: [{ keys: ['Enter'], label: 'Start' }, { keys: ['Esc'], label: 'Back' }, hideUi],
    settings: [{ keys: ['Esc'], label: 'Back' }, hideUi],
  };

  const steps: Record<MenuStep, () => HTMLElement[]> = { home, race, setup, settings };
  function go(next: MenuStep, animate = true): void {
    const from = step;
    step = next;
    root.dataset.step = next;
    if (next !== 'race' && next !== 'setup') delete root.dataset.mode;
    overview?.dispose();
    course?.dispose();
    overview = course = null;
    pickType = null;
    const el = h('div', { class: 'menu-step' }, ...steps[next]());
    const fwd = STEP_DEPTH[next] > STEP_DEPTH[from];
    if (swapStep(menu, current, el, animate ? (fwd ? 'fwd' : 'back') : null)) uiWhoosh(fwd);
    current = el;
    const nextBar = keybar(KEYS[next]);
    bar.replaceWith(nextBar);
    bar = nextBar;
    if (next !== from || !animate) o.onStep?.(next);
    if (!animate) return;
    // Keep keyboard and gamepad focus on the menu: the step's main action, or where the player came back from.
    const focus = {
      home: from === 'settings' ? '.nav-settings' : '.event-go',
      race: '.next',
      setup: '.start',
      settings: '.settings-tab.on',
    }[next];
    el.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
  }
  go(o.step ?? 'home', false);

  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return window.removeEventListener('keydown', onKey);
    if (document.body.classList.contains('cinematic') || e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
    // The full map over the menu keeps the keys to itself.
    if (typing || root.parentElement?.querySelector('.fullmap-modal')) return;
    if (e.key === 'Escape' && step !== 'home') {
      e.preventDefault();
      go(step === 'setup' ? 'race' : 'home');
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && step === 'home') {
      // Up and down walk the home menu: the map, the race button, then the list.
      const items = [...(current?.querySelectorAll<HTMLElement>('.event-map, .event-go, .nav-item') ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? items.findIndex((x) => x.classList.contains('event-go')) : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      e.preventDefault();
      items[next]?.focus();
    } else if (step === 'race' && pickType && !e.repeat) {
      // Left and right step through the race types; 1 to 4 pick one.
      const at = RACE_TYPES.indexOf(s.raceType);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        pickType(RACE_TYPES[(at + (e.key === 'ArrowRight' ? 1 : -1) + RACE_TYPES.length) % RACE_TYPES.length]);
      } else if (/^[1-4]$/.test(e.key)) pickType(RACE_TYPES[Number(e.key) - 1]);
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
      overview?.dispose();
      course?.dispose();
    },
  };
}
