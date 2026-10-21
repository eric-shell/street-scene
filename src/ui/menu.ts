/**
 * The main menu, in steps so no pane tries to do everything. Home is the event
 * (seed, name) across the top and a row of four tiles: Race, Garage, Settings and
 * Explore. Race opens a second step (race type, rivals, difficulty, driving
 * aids, then Start); Settings opens the sidebar settings panel as a step;
 * Garage and Explore (the drone flyover) go straight to their screens. Every
 * step keeps the title block on top (the boot splash lands on `.menu-head`, see
 * ui/splash.ts) and Escape or the back button returns home. The Hide UI button
 * sits at the very bottom left of the viewport.
 */
import { btn, h, iconBtn, segmented } from './dom';
import { ArrowLeft, Calendar, Compass, Drone, EyeOff, Flag, Play, RotateCcw, Route, Settings as SettingsIcon, Shuffle, Video, Wind, Wrench, type IconNode, icon } from './icons';
import { RACE_TYPES, type Difficulty, type RaceType, type Settings } from './settings';
import { onOff, settingRow, settingsPanel } from './screens';
import { formatTime } from './format';
import { MAX_OPPONENTS, type RaceMode } from '../sim/race';
import type { BestRecord } from '../replay/replay';
import type { MusicPlayer } from '../audio/musicPlayer';

/** The title, one word a line in the menu and on the splash alike, so both wrap the same at any width. */
export const TITLE_LINES = ['STREET', 'SCENE'] as const;
export const TAGLINE = 'Street racing after dark';

/** The title's lines as block spans, with a space between so its text still reads "STREET SCENE". */
export function titleLines(line: (text: string) => (Node | string)[] = (t) => [t]): (Node | string)[] {
  return TITLE_LINES.flatMap((t, i) => [...(i ? [' '] : []), h('span', { class: 'logo-line' }, ...line(t))]);
}

export type MenuStep = 'home' | 'race' | 'settings';

export interface MenuOptions {
  seed: string;
  isDaily: boolean;
  /** The seed's named event (city/events.ts), shown under the seed. */
  event?: { name: string; tagline: string };
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
  /** Hide every piece of UI to watch the menu city's flyover (H); any key or click brings it back. */
  onHideUi(): void;
}

const TYPE_INFO: Record<RaceType, { label: string; icon: IconNode; sub: string; start: string }> = {
  circuit: { label: 'Circuit', icon: RotateCcw, sub: '3 laps', start: 'Start circuit' },
  sprint: { label: 'Sprint', icon: Route, sub: 'A to B', start: 'Start sprint' },
  drift: { label: 'Drift', icon: Wind, sub: 'Score attack', start: 'Start drift' },
  roam: { label: 'Free roam', icon: Compass, sub: 'No rules', start: 'Start free roam' },
};

/** A menu tile: icon, label and a one-line sub (a record reads as a value in the secondary color). */
function tile(ico: IconNode, label: string, sub: string, onClick: () => void, opts: { cls?: string; record?: boolean; radio?: boolean } = {}): HTMLButtonElement {
  return h(
    'button',
    { class: `tile ${opts.cls ?? ''}`.trim(), type: 'button', role: opts.radio ? 'radio' : undefined, title: `${label}: ${sub}`, onclick: onClick },
    icon(ico, { size: 24 }),
    h('span', { class: 'tile-label' }, label),
    h('span', { class: opts.record ? 'tile-sub record' : 'tile-sub' }, sub),
  );
}

export function mainMenu(o: MenuOptions): HTMLElement {
  const s = o.settings;
  // An opaque rail with a slashed edge carries the menu, so its contrast never depends on the city behind it.
  const root = h('div', { class: 'screen home', 'data-step': 'home' }, h('div', { class: 'home-rail', 'aria-hidden': 'true' }), h('div', { class: 'home-slash', 'aria-hidden': 'true' }));
  // The title block is what the boot splash lands on (same structure as the splash's, see ui/splash.ts).
  const head = h(
    'div',
    { class: 'menu-head' },
    h('div', { class: 'head-title' }, h('h1', { class: 'logo' }, ...titleLines()), h('div', { class: 'title-rule', 'aria-hidden': 'true' })),
    h('div', { class: 'tagline' }, TAGLINE),
  );
  const menu = h('div', { class: 'menu' });
  let step: MenuStep = 'home';

  const best = (m: RaceMode) => {
    const b = o.bests[m];
    return b ? (m === 'drift' ? `Best ${Math.round(b.score ?? 0).toLocaleString()}` : `Best ${formatTime(b.time)}`) : null;
  };
  const seedChip = () => h('span', { class: 'seed', title: 'City seed' }, `#${o.seed}`);
  /** A sub step's header: back, its title, and anything on the right. */
  const stepHead = (ico: IconNode, label: string, right?: Node) =>
    h('div', { class: 'step-head' }, iconBtn(ArrowLeft, 'Back (Esc)', () => go('home'), 'small'), h('h2', { class: 'step-title' }, icon(ico, { size: 20 }), label), right ?? null);

  const home = (): HTMLElement[] => {
    const seedInput = h('input', { type: 'text', class: 'mono', value: o.seed, maxlength: 32, 'aria-label': 'Seed', placeholder: 'Type a seed' }) as HTMLInputElement;
    seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') o.onSeed(seedInput.value.trim() || null);
    });
    const event = h(
      'div',
      { class: 'event panel' },
      h('div', { class: 'event-head' }, h('span', { class: 'label' }, icon(Calendar, { size: 14 }), o.isDaily ? 'Event of the day' : 'Custom event'), seedChip()),
      o.event && h('div', { class: 'event-title' }, h('span', { class: 'event-name' }, o.event.name), h('span', { class: 'event-tagline' }, o.event.tagline)),
      h(
        'div',
        { class: 'event-row' },
        seedInput,
        iconBtn(Play, 'Use seed', () => o.onSeed(seedInput.value.trim() || null), 'small'),
        iconBtn(Shuffle, 'Random seed', () => o.onSeed(String(Math.floor(Math.random() * 1e8))), 'small'),
        !o.isDaily && iconBtn(Calendar, 'Back to today', () => o.onSeed(null), 'small'),
      ),
    );
    const t = s.raceType;
    const raceSub = t === 'drift' || t === 'roam' ? TYPE_INFO[t].label : `${TYPE_INFO[t].label} · ${s.opponents ? `${s.opponents} rival${s.opponents > 1 ? 's' : ''}` : 'ghost'}`;
    const nav = h(
      'nav',
      { class: 'tiles home-tiles', 'aria-label': 'Main menu' },
      tile(Flag, 'Race', raceSub, () => go('race'), { cls: 'primary' }),
      tile(Wrench, 'Garage', o.carName, o.onGarage),
      tile(SettingsIcon, 'Settings', 'Display, sound', () => go('settings')),
      tile(Drone, 'Explore', 'Drone flyover', o.onDrone),
    );
    return [event, nav];
  };

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
    return [stepHead(Flag, 'Race', seedChip()), types, rivals, driving, h('div', { class: 'step-foot' }, replay, start)];
  };

  const settings = (): HTMLElement[] => [stepHead(SettingsIcon, 'Settings'), settingsPanel(s, o.onSettings, o.music)];

  const steps: Record<MenuStep, () => HTMLElement[]> = { home, race, settings };
  function go(next: MenuStep, animate = true): void {
    const from = step;
    step = next;
    root.dataset.step = next;
    // Each step's parts rise in, staggered, like the menu does under the boot splash.
    menu.classList.toggle('step-enter', animate);
    menu.replaceChildren(head, ...steps[next]());
    if (!animate) return;
    // Keep keyboard and gamepad focus on the menu: the step's main action, or the tile the player came back from.
    const focus = next === 'race' ? menu.querySelector<HTMLElement>('.start') : next === 'home' ? menu.querySelectorAll<HTMLElement>('.home-tiles .tile')[from === 'settings' ? 2 : 0] : menu.querySelector<HTMLElement>('.settings-tab.on');
    focus?.focus({ preventScroll: true });
  }
  go('home', false);

  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return window.removeEventListener('keydown', onKey);
    if (e.key === 'Escape' && step !== 'home' && !document.body.classList.contains('cinematic')) {
      e.preventDefault();
      go('home');
    }
  };
  window.addEventListener('keydown', onKey);

  const watch = h('button', { class: 'btn small home-watch', type: 'button', title: 'Hide the menu and watch the city (H)', onclick: () => o.onHideUi() }, icon(EyeOff, { size: 16 }), 'Hide UI', h('kbd', {}, 'H'));
  root.append(menu, watch);
  return root;
}
