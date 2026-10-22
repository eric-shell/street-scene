/**
 * The pause screen: a rail over the dimmed race (ui/rail/rail.ts) in the main
 * menu's language. Styled by _pause-screen.scss; the ticket is the menu's
 * race ticket (ui/menu/), the settings step the shared settings panel.
 */
import { btn, chip, h } from '../kit/dom';
import { ChevronsRight, Compass, MapPinned, Pause, Play, RotateCcw, Route, Settings as SettingsIcon, Wind, X, type IconNode, icon } from '../kit/icons';
import type { RaceType, Settings } from '../settings';
import { navRow, railScreen, screenHead, swapStep, type Hue } from '../rail/rail';
import { Help, MUSIC_KEYS } from '../panels/help';
import { courseArt, type ArtCar } from '../menu/menuMaps';
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
 * Pause: a rail over the dimmed race in the main menu's language. The header
 * carries the race type's chip; a ticket says what is paused (the course drawn
 * small with every car where it stands, the event, lap, place); Resume is the
 * screen's main action and glints; the other actions are rows in their own
 * hues like the menu's places (restart orange, a new city green, settings
 * purple, quit red). Settings is a step of its own on the same rail, sliding
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
  let current: HTMLElement | null = null;
  const pause = (): HTMLElement[] => [
    screenHead({ icon: Pause, title: 'Paused', aside: chip(t.title, TYPE_ICON[t.mode], `--mode mode-${t.mode}`) }),
    h(
      'section',
      { class: `race-ticket mode-${t.mode}`, 'aria-label': 'What is paused' },
      h('span', { class: 'race-ticket__art' }, t.route ? courseArt(t.route, t.mode, 104, 52, t.cars) : icon(Compass, { size: 30 })),
      h(
        'span',
        { class: 'race-ticket__text' },
        t.event && h('span', { class: 'race-ticket__kicker' }, t.event),
        h('span', { class: 'course-name' }, t.title),
        h('span', { class: 'course-facts' }, ...t.facts.map((f) => h('span', {}, f))),
      ),
    ),
    btn(Play, 'Resume', o.onResume, '--large --primary --cta pause-screen__resume'),
    h(
      'nav',
      { class: 'nav-list', 'aria-label': 'Paused' },
      navRow(RotateCcw, o.restartLabel ?? 'Restart race', o.restartSub ?? 'Back to the grid', 'orange', o.onRestart),
      ...(o.extra ?? []).map((x) => navRow(x.icon, x.label, x.sub, x.hue, x.onClick)),
      navRow(SettingsIcon, 'Settings', 'Display, sound, controls', 'purple', () => show('settings'), 'pause-screen__settings'),
      navRow(X, o.quitLabel ?? 'Quit to menu', o.quitSub ?? 'Leave this race', 'red', o.onQuit),
    ),
  ];
  const settings = (): HTMLElement[] => [screenHead({ icon: SettingsIcon, title: 'Settings', back: () => show('pause') }), settingsPanel(o.settings, o.onSettings, o.music)];
  const show = (next: 'pause' | 'settings', animate = true) => {
    step = next;
    const el = h('div', { class: 'rail__step' }, ...(next === 'pause' ? pause() : settings()));
    swapStep(col, current, el, animate ? (next === 'settings' ? 'fwd' : 'back') : null);
    current = el;
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
