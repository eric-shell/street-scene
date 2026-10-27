/**
 * The pause screen: a rail over the dimmed race (ui/rail/rail.ts) in the main
 * menu's and the garage's language. Styled by _pause-screen.scss and
 * _pause-card.scss; the settings step is the shared settings panel.
 */
import { btn, h } from '../kit/dom';
import { ChevronsRight, Compass, MapIcon, MapPinned, Pause, Play, RotateCcw, Route, LogOut, Settings as SettingsIcon, Wind, icon, type IconNode } from '../kit/icons';
import type { RaceType, Settings } from '../settings';
import { RailSteps, navRow, railScreen, screenHead, type Hue } from '../rail/rail';
import { Help, MUSIC_KEYS } from '../panels/help';
import type { ArtCar } from '../menu/menuMaps';
import { courseArt } from '../menu/menuMaps';
import { courseFacts } from '../menu/raceTicket';
import type { Route as RaceRoute } from '../../city/route';
import type { MusicPlayer } from '../../audio/musicPlayer';
import { settingsPanel } from './settingsPanel';

export interface PauseScreen {
  readonly el: HTMLElement;
  /** Escape on the pause screen: true when it went back from its settings step, false when there is nothing to go back from. */
  back(): boolean;
}

/** What is paused, as the pause screen's ticket shows it. */
export interface PauseTicket {
  /** The event's name, over the title. */
  event?: string;
  /** Circuit, Sprint, Drag, Waypoint, Drift, Free roam. */
  title: string;
  /** The race type whose color it wears. */
  mode: RaceType;
  /** Lap, place, score: a few facts in a row. */
  facts: string[];
  /** The course, drawn small with every car where it is (none: the open city, a compass instead). */
  route?: RaceRoute;
  cars?: ArtCar[];
}

/** An action on the pause screen besides the fixed ones (free roam: a new city), in its hue. */
export interface PauseAction {
  icon: IconNode;
  label: string;
  sub: string;
  hue: Hue;
  onClick(): void;
}

const TYPE_ICON: Record<RaceType, IconNode> = { circuit: RotateCcw, sprint: Route, drag: ChevronsRight, waypoint: MapPinned, drift: Wind, roam: Compass };

/**
 * Pause: a rail over the dimmed race in the main menu's and the garage's
 * language: no column, only a scrim, the parts plates of their own. A card
 * shaped like the menu's event card and the garage's build card says what is
 * paused (the race type as its kicker, the event's name, lap and place, the
 * course drawn with every car where it stands) and ends in Resume, the
 * screen's main action, which glints; the other actions are rows in their own
 * hues like the menu's places (restart orange, a new city green, the city
 * map cyan, settings purple, quit red). Settings is a step of its own on the same rail, sliding
 * in like the menu's steps, so Escape there comes back to the pause list
 * instead of resuming.
 */
export function pauseMenu(o: {
  ticket: PauseTicket;
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  /** Restart's label and sub (default "Restart race", "Back to the grid"). */
  restartLabel?: string;
  restartSub?: string;
  /** Quit's label and sub (default "Quit to menu", "Leave this race"). */
  quitLabel?: string;
  quitSub?: string;
  /** Rows under Restart (free roam: a new city). */
  extra?: PauseAction[];
  /** The city map row, another way to the map than Tab or the minimap (none: no row, as in a replay). */
  onMap?(): void;
  /** The settings step works on this copy and reports every change. */
  settings: Settings;
  onSettings(s: Settings): void;
  music?: MusicPlayer;
}): PauseScreen {
  const col = h('div', { class: 'rail__col' });
  const help = new Help({
    title: 'Paused',
    sections: () => [
      { title: 'Keys', keys: [{ keys: ['Esc'], label: step === 'pause' ? 'Resume' : 'Back to the pause list' }] },
      { title: 'Music', keys: MUSIC_KEYS },
      { title: 'Tips', tips: ['Settings › Controls lists every key, gamepad button and touch control.'] },
    ],
  });
  const root = railScreen('pause-screen --scrim', col, help.el);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Paused');
  const t = o.ticket;
  let step: 'pause' | 'settings' = 'pause';
  const steps = new RailSteps(col);
  const card = (): HTMLElement =>
    h(
      'section',
      { class: `pause-card mode-${t.mode}`, 'aria-label': 'What is paused' },
      h('span', { class: 'label label--kicker' }, icon(TYPE_ICON[t.mode], { size: 14 }), t.title),
      h('h3', { class: 'pause-card__name' }, t.event ?? t.title),
      courseFacts(t.facts),
      h('div', { class: 'pause-card__art' }, t.route ? courseArt(t.route, t.mode, 320, 110, t.cars) : icon(Compass, { size: 40 })),
      btn(Play, 'Resume', o.onResume, '--large --primary --cta pause-card__go pause-screen__resume'),
    );
  const pause = (): HTMLElement[] => [
    screenHead({ icon: Pause, title: 'Paused' }),
    card(),
    h(
      'nav',
      { class: 'nav-list', 'aria-label': 'Paused' },
      navRow(RotateCcw, o.restartLabel ?? 'Restart race', o.restartSub ?? 'Back to the grid', 'orange', o.onRestart),
      ...(o.extra ?? []).map((x) => navRow(x.icon, x.label, x.sub, x.hue, x.onClick)),
      ...(o.onMap ? [navRow(MapIcon, 'City map', t.mode === 'roam' ? 'Find a place, set a waypoint' : 'The course and where you are', 'cyan', o.onMap)] : []),
      navRow(SettingsIcon, 'Settings', 'Display, sound, controls', 'purple', () => show('settings'), 'pause-screen__settings'),
      navRow(LogOut, o.quitLabel ?? 'Quit to menu', o.quitSub ?? 'Leave this race', 'red', o.onQuit),
    ),
  ];
  const settings = (): HTMLElement[] => [screenHead({ icon: SettingsIcon, title: 'Settings', back: () => show('pause') }), settingsPanel(o.settings, o.onSettings, o.music)];
  const show = (next: 'pause' | 'settings', animate = true) => {
    step = next;
    steps.show(next === 'pause' ? pause() : settings(), animate ? (next === 'settings' ? 'fwd' : 'back') : null);
    const el = steps.current!;
    help.close();
    // Keyboard and gamepad focus stays on the rail: Resume, the open settings tab, or Settings when coming back.
    const focus = next === 'settings' ? '.settings__tab.is-selected' : animate ? '.pause-screen__settings' : '.pause-screen__resume';
    requestAnimationFrame(() => el.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true }));
  };
  show('pause', false);
  return {
    el: root,
    back: () => {
      if (step !== 'settings') return false;
      show('pause');
      return true;
    },
  };
}
