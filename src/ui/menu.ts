/**
 * The main menu, in steps so no pane tries to do everything, on the rail
 * (ui/rail.ts) beside the event city, where the player's car cruises the
 * route. Home is the title block over the event card (tonight's event: name,
 * tagline and its route drawn small, the race setup at a glance, the seed with
 * edit, shuffle and back-to-today, and the way into the race) over a list of
 * the other places: Garage, Explore (the drone flyover) and Settings; arrow keys
 * move between them. Race opens the
 * race step (the types as a column of rows, rivals, difficulty, driving aids,
 * then Start); Settings
 * opens the settings panel as a step. Every step keeps the title block on top
 * (the boot splash lands on `.menu-head`, see ui/splash.ts) and Escape or the
 * back button returns home. The key legend along the bottom carries Hide UI
 * (H), which stays a button on touch screens.
 */
import { btn, h, iconBtn, segmented } from './dom';
import { Calendar, Check, ChevronRight, Compass, Drone, Flag, Ghost, Pencil, Play, RotateCcw, Route, Settings as SettingsIcon, Shuffle, Trophy, Undo2, Users, Video, Wind, Wrench, X, type IconNode, icon } from './icons';
import { RACE_TYPES, type Difficulty, type RaceType, type Settings } from './settings';
import { onOff, settingRow, settingsPanel } from './screens';
import { chip, keybar, railScreen, screenHead, type KeyHint } from './rail';
import { formatTime } from './format';
import { MAX_OPPONENTS, type RaceMode } from '../sim/race';
import type { BestRecord } from '../replay/replay';
import type { MusicPlayer } from '../audio/musicPlayer';

/** The title's words: one line, sized to the menu's column in the menu and on the splash alike (ui.css `.head-title .logo`). */
export const TITLE_WORDS = ['STREET', 'SCENE'] as const;
export const TAGLINE = 'Street racing after dark';

/** The title's words as spans, with a space between so its text reads "STREET SCENE"; the splash fills them letter by letter. */
export function titleWords(word: (text: string) => (Node | string)[] = (t) => [t]): (Node | string)[] {
  return TITLE_WORDS.flatMap((t, i) => [...(i ? [' '] : []), h('span', { class: 'logo-word' }, ...word(t))]);
}

export type MenuStep = 'home' | 'race' | 'settings';

/** A point in world meters (x east, z south), as the route sketch reads it. */
export interface MapPoint {
  x: number;
  z: number;
}

export interface MenuOptions {
  seed: string;
  isDaily: boolean;
  /** The seed's named event (city/events.ts), the event card's headline. */
  event?: { name: string; tagline: string };
  /** The event's route in driving order and its start line, drawn small on the event card. */
  route?: { points: readonly MapPoint[]; start: MapPoint };
  bests: Record<RaceMode, BestRecord | null>;
  /** The current build's car, for the Garage tile. */
  carName: string;
  hasReplay: boolean;
  /** A copy of the settings: the race and settings steps change it and report each change through onSettings. */
  settings: Settings;
  music?: MusicPlayer;
  onSettings(s: Settings): void;
  /** Start the picked race type with the race options in `settings`. */
  onRace(type: RaceType): void;
  onGarage(): void;
  onReplay(): void;
  /** Explore: the drone flyover of the event city. */
  onDrone(): void;
  onSeed(seed: string | null): void;
  /** Hide every piece of UI to watch the menu city (H); any key or click brings it back. */
  onHideUi(): void;
}

const TYPE_INFO: Record<RaceType, { label: string; icon: IconNode; sub: string; start: string }> = {
  circuit: { label: 'Circuit', icon: RotateCcw, sub: '3 laps', start: 'Start circuit' },
  sprint: { label: 'Sprint', icon: Route, sub: 'A to B', start: 'Start sprint' },
  drift: { label: 'Drift', icon: Wind, sub: 'Score attack', start: 'Start drift' },
  roam: { label: 'Free roam', icon: Compass, sub: 'No rules', start: 'Start free roam' },
};

/** A race type's row: icon, label and a short sub on the right (a record reads as a value in the secondary color). */
function tile(ico: IconNode, label: string, sub: string, onClick: () => void, opts: { cls?: string; record?: boolean; radio?: boolean } = {}): HTMLButtonElement {
  return h(
    'button',
    { class: `tile ${opts.cls ?? ''}`.trim(), type: 'button', role: opts.radio ? 'radio' : undefined, title: `${label}: ${sub}`, onclick: onClick },
    icon(ico, { size: 24 }),
    h('span', { class: 'tile-label' }, label),
    h('span', { class: opts.record ? 'tile-sub record' : 'tile-sub' }, sub),
  );
}

/** A row of the home menu's list: icon, label over a one-line sub, and a chevron. */
function navItem(ico: IconNode, label: string, sub: string, onClick: () => void): HTMLButtonElement {
  return h(
    'button',
    { class: 'nav-item', type: 'button', onclick: onClick },
    icon(ico, { size: 22 }),
    h('span', { class: 'nav-text' }, h('span', { class: 'nav-label' }, label), h('span', { class: 'nav-sub' }, sub)),
    icon(ChevronRight, { size: 18 }),
  );
}

const SVG = 'http://www.w3.org/2000/svg';

/** The event's route as a small line drawing fitted to the card's side (x east, z south, so north is up), its start marked. */
function routeSketch(route: NonNullable<MenuOptions['route']>): SVGSVGElement {
  const W = 112;
  const H = 84;
  const pad = 6;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of route.points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const k = Math.min((W - 2 * pad) / Math.max(1, maxX - minX), (H - 2 * pad) / Math.max(1, maxZ - minZ));
  const ox = (W - (maxX - minX) * k) / 2;
  const oz = (H - (maxZ - minZ) * k) / 2;
  const px = (p: MapPoint) => `${(ox + (p.x - minX) * k).toFixed(1)} ${(oz + (p.z - minZ) * k).toFixed(1)}`;
  const d = route.points.map((p, i) => `${i ? 'L' : 'M'}${px(p)}`).join('');
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'event-route');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('aria-hidden', 'true');
  for (const cls of ['route-road', 'route-line']) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('class', cls);
    path.setAttribute('d', d);
    // A unit path length lets CSS draw the line on with one dash.
    path.setAttribute('pathLength', '1');
    svg.append(path);
  }
  const [sx, sz] = px(route.start).split(' ');
  const start = document.createElementNS(SVG, 'circle');
  start.setAttribute('cx', sx);
  start.setAttribute('cy', sz);
  start.setAttribute('r', '4');
  svg.append(start);
  return svg;
}

export function mainMenu(o: MenuOptions): HTMLElement {
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
  let step: MenuStep = 'home';

  const best = (m: RaceMode) => {
    const b = o.bests[m];
    return b ? (m === 'drift' ? `Best ${Math.round(b.score ?? 0).toLocaleString()}` : `Best ${formatTime(b.time)}`) : null;
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

  /** Tonight's event: what it is, where it runs, how the race is set up, and the way in. */
  const eventCard = (): HTMLElement => {
    const t = s.raceType;
    const info = TYPE_INFO[t];
    const solo = t === 'drift' || t === 'roam';
    const record = t === 'roam' ? null : best(t);
    const enter = btn(Flag, 'Race', () => go('race'), 'big primary event-go');
    enter.title = 'Pick the race type and rivals, then start';
    enter.append(icon(ChevronRight, { size: 20 }));
    return h(
      'section',
      { class: 'event-card', 'aria-label': 'Event' },
      h('div', { class: 'event-top' }, h('span', { class: 'label' }, icon(Calendar, { size: 14 }), o.isDaily ? 'Event of the day' : 'Custom event'), seedControl()),
      h('h2', { class: 'event-name' }, o.event?.name ?? 'Street race'),
      o.event && h('p', { class: 'event-tagline' }, o.event.tagline),
      o.route && o.route.points.length > 2 && routeSketch(o.route),
      h(
        'div',
        { class: 'event-meta' },
        chip(t === 'circuit' ? `${info.label} · ${info.sub}` : info.label, info.icon),
        !solo && chip(s.opponents ? `${s.opponents} rival${s.opponents > 1 ? 's' : ''}` : 'Ghost race', s.opponents ? Users : Ghost),
        record && chip(record, Trophy, 'accent'),
      ),
      enter,
    );
  };

  const home = (): HTMLElement[] => [
    eventCard(),
    h(
      'nav',
      { class: 'nav-list', 'aria-label': 'Main menu' },
      navItem(Wrench, 'Garage', `${o.carName} · paint, parts, tuning`, o.onGarage),
      navItem(Drone, 'Explore', 'Fly a drone over the event city', o.onDrone),
      navItem(SettingsIcon, 'Settings', 'Display, sound, controls', () => go('settings')),
    ),
  ];

  const race = (): HTMLElement[] => {
    const types = h('div', { class: 'tiles race-types', role: 'radiogroup', 'aria-label': 'Race type' });
    const typeTiles = RACE_TYPES.map((t) => {
      const info = TYPE_INFO[t];
      const record = t === 'roam' ? null : best(t);
      const b = tile(info.icon, info.label, record ?? info.sub, () => pick(t), { radio: true, record: !!record, cls: t === 'roam' ? 'roam' : '' });
      types.append(b);
      return b;
    });
    const oppHint = h('span', { class: 'hint' });
    const opponents = segmented(
      Array.from({ length: MAX_OPPONENTS + 1 }, (_, i) => ({ value: String(i), label: String(i) })),
      String(s.opponents),
      (v) => {
        s.opponents = Number(v);
        o.onSettings(s);
        refresh();
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
    const rivals = h(
      'div',
      { class: 'race-group' },
      h('div', { class: 'section-title' }, 'Rivals'),
      h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('span', { class: 'name' }, 'Opponents'), oppHint), opponents),
      settingRow('AI difficulty', difficulty),
    );
    const driving = h(
      'div',
      { class: 'race-group' },
      h('div', { class: 'section-title' }, 'Driving'),
      settingRow('Manual gearbox', onOff(s.manualGearbox, (v) => ((s.manualGearbox = v), o.onSettings(s))), 'Q / E to shift'),
      settingRow('Traction control', onOff(s.tractionControl, (v) => ((s.tractionControl = v), o.onSettings(s))), 'Off lets the rear step out'),
    );
    const start = btn(Play, '', () => o.onRace(s.raceType), 'big primary start');
    const replay = btn(Video, 'Replay', o.onReplay, 'replay', o.hasReplay ? 'Last race' : 'No race yet');
    if (!o.hasReplay) replay.setAttribute('disabled', '');
    const refresh = () => {
      const t = s.raceType;
      typeTiles.forEach((b, i) => {
        const on = RACE_TYPES[i] === t;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      });
      // Drift is a solo score attack and free roam has no rules, so rivals do not apply to them.
      const solo = t === 'drift' || t === 'roam';
      rivals.classList.toggle('off', solo);
      rivals.querySelectorAll('button').forEach((b) => (b.disabled = solo));
      // The hint says why when rivals are off, so switching types never moves the layout.
      oppHint.textContent = t === 'drift' ? 'Drift is a solo score attack' : t === 'roam' ? 'Free roam has no rivals' : s.opponents ? `${s.opponents} on the grid` : 'Solo: race your best ghost';
      start.querySelector('.grow')!.textContent = TYPE_INFO[t].start;
    };
    const pick = (t: RaceType) => {
      s.raceType = t;
      o.onSettings(s);
      refresh();
    };
    refresh();
    return [
      screenHead({ icon: Flag, title: 'Race', back: () => go('home'), aside: chip(o.event?.name ?? `#${o.seed}`, undefined, 'accent') }),
      types,
      h('div', { class: 'race-setup' }, rivals, driving),
      h('div', { class: 'step-foot' }, replay, start),
    ];
  };

  const settings = (): HTMLElement[] => [screenHead({ icon: SettingsIcon, title: 'Settings', back: () => go('home') }), settingsPanel(s, o.onSettings, o.music)];

  const hideUi: KeyHint = { keys: ['H'], label: 'Hide UI', action: () => o.onHideUi(), title: 'Hide the menu and watch the city (H)' };
  const KEYS: Record<MenuStep, KeyHint[]> = {
    home: [{ keys: ['↑', '↓'], label: 'Select' }, { keys: ['0'], label: 'Explore' }, { keys: ['M'], label: 'Mute music' }, hideUi],
    race: [{ keys: ['Esc'], label: 'Back' }, hideUi],
    settings: [{ keys: ['Esc'], label: 'Back' }, hideUi],
  };

  const steps: Record<MenuStep, () => HTMLElement[]> = { home, race, settings };
  function go(next: MenuStep, animate = true): void {
    const from = step;
    step = next;
    root.dataset.step = next;
    // Each step's parts rise in, staggered, like the menu does under the boot splash.
    menu.classList.toggle('step-enter', animate);
    menu.replaceChildren(head, ...steps[next]());
    const nextBar = keybar(KEYS[next]);
    bar.replaceWith(nextBar);
    bar = nextBar;
    if (!animate) return;
    // Keep keyboard and gamepad focus on the menu: the step's main action, or where the player came back from.
    const focus =
      next === 'race'
        ? menu.querySelector<HTMLElement>('.start')
        : next === 'home'
          ? menu.querySelector<HTMLElement>(from === 'settings' ? '.nav-item:last-child' : '.event-go')
          : menu.querySelector<HTMLElement>('.settings-tab.on');
    focus?.focus({ preventScroll: true });
  }
  go('home', false);

  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return window.removeEventListener('keydown', onKey);
    if (document.body.classList.contains('cinematic')) return;
    if (e.key === 'Escape' && step !== 'home') {
      e.preventDefault();
      go('home');
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && step === 'home' && !(e.target instanceof HTMLInputElement)) {
      // Up and down walk the home menu: the race button, then the list.
      const items = [...menu.querySelectorAll<HTMLElement>('.event-go, .nav-item')];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      e.preventDefault();
      items[next]?.focus();
    }
  };
  window.addEventListener('keydown', onKey);
  return root;
}
