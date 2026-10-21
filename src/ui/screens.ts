/**
 * The screens over a race (pause and results, rails beside the race; see
 * ui/rail.ts), the settings panel the main menu and the pause screen share, and
 * the loading card. Every screen returns its root element; callers remove it.
 * The main menu is ui/menu.ts.
 */
import { btn, h, segmented } from './dom';
import {
  Code,
  Flag,
  Gamepad2,
  Heart,
  Keyboard,
  Medal,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  Settings as SettingsIcon,
  Smartphone,
  Sparkles,
  Trophy,
  Video,
  Volume2,
  Wrench,
  X,
  type IconNode,
  icon,
} from './icons';
import type { Quality, Settings } from './settings';
import { formatTime, ordinal } from './format';
import { chip, keybar, railScreen, screenHead } from './rail';
import type { RaceMode } from '../sim/race';
import type { MusicPlayer } from '../audio/musicPlayer';
import { musicCredits } from './musicWidget';
import { BUILD_VERSION } from '../version';

export interface PauseScreen {
  readonly el: HTMLElement;
  /** Escape on the pause screen: true when it went back from its settings step, false when there is nothing to go back from. */
  back(): boolean;
}

/**
 * Pause: a rail over the dimmed race with what is paused (event, mode, lap and
 * place) and the actions one per row; Settings is a step of its own on the same
 * rail, so Escape there comes back to the pause list instead of resuming.
 */
export function pauseMenu(o: {
  /** What is paused, as chips under the title: the event first, then mode, lap, place. */
  status?: string[];
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  /** Restart button label (default "Restart race"). */
  restartLabel?: string;
  /** Extra buttons under Restart (free roam: a new city). */
  extra?: { icon: IconNode; label: string; onClick(): void }[];
  /** The settings step works on this copy and reports every change. */
  settings: Settings;
  onSettings(s: Settings): void;
  music?: MusicPlayer;
}): PauseScreen {
  const col = h('div', { class: 'rail-col' });
  let bar = keybar([]);
  const root = railScreen('pause scrim', col, bar);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Paused');
  let step: 'pause' | 'settings' = 'pause';
  const show = (next: 'pause' | 'settings', animate = true) => {
    step = next;
    col.classList.toggle('step-enter', animate);
    if (next === 'pause') {
      col.replaceChildren(
        screenHead({ icon: Pause, title: 'Paused' }),
        ...(o.status?.length ? [h('div', { class: 'status-line' }, ...o.status.map((t, i) => chip(t, i === 0 ? Flag : undefined, i === 0 ? 'accent' : '')))] : []),
        h(
          'div',
          { class: 'menu-list' },
          btn(Play, 'Resume', o.onResume, 'big primary resume'),
          btn(RotateCcw, o.restartLabel ?? 'Restart race', o.onRestart, 'big'),
          ...(o.extra ?? []).map((x) => btn(x.icon, x.label, x.onClick, 'big')),
          btn(SettingsIcon, 'Settings', () => show('settings'), 'big open-settings'),
          btn(X, 'Quit to menu', o.onQuit, 'big'),
        ),
      );
    } else col.replaceChildren(screenHead({ icon: SettingsIcon, title: 'Settings', back: () => show('pause') }), settingsPanel(o.settings, o.onSettings, o.music));
    const nextBar = keybar([{ keys: ['Esc'], label: next === 'pause' ? 'Resume' : 'Back' }]);
    bar.replaceWith(nextBar);
    bar = nextBar;
    // Keyboard and gamepad focus stays on the rail: Resume, the open settings tab, or Settings when coming back.
    requestAnimationFrame(() => col.querySelector<HTMLElement>(next === 'settings' ? '.settings-tab.on' : animate ? '.open-settings' : '.resume')?.focus({ preventScroll: true }));
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

export interface ResultRow {
  name: string;
  car: string;
  time: number;
  estimated: boolean;
  me: boolean;
  bestLap: number | null;
}

const MODE_LABEL: Record<RaceMode, string> = { circuit: 'Circuit', sprint: 'Sprint', drift: 'Drift' };

/** Results: a rail beside the finish shots with the headline (place or score), a new best, the standings and what next. */
export function resultsScreen(o: {
  mode: RaceMode;
  /** The seed's event name (Hill Climb, River Run, ...), over the headline. */
  event?: string;
  rows: ResultRow[];
  position: number;
  driftScore?: number;
  newBest: boolean;
  tuned: boolean;
  onRetry(): void;
  onReplay(): void;
  onGarage(): void;
  onMenu(): void;
}): HTMLElement {
  const table = h('table', { class: 'results-table' });
  o.rows.forEach((r, i) =>
    table.append(
      h(
        'tr',
        { class: r.me ? 'me' : '' },
        h('td', { class: 'pos' }, String(i + 1)),
        h('td', {}, r.name, h('span', { class: 'car' }, r.car + (r.bestLap ? ` · best lap ${formatTime(r.bestLap)}` : ''))),
        h('td', { class: 'time' }, (r.estimated ? '~' : '') + formatTime(r.time)),
      ),
    ),
  );
  const drift = o.mode === 'drift';
  const headline = drift ? `${Math.round(o.driftScore ?? 0).toLocaleString()} pts` : o.position === 1 ? 'You win!' : `${ordinal(o.position)} place`;
  const retry = btn(RotateCcw, 'Retry', o.onRetry, 'big primary');
  const col = h(
    'div',
    { class: 'rail-col step-enter' },
    h(
      'div',
      { class: 'result-head' },
      h('div', { class: 'label' }, icon(Flag, { size: 14 }), o.event ? `${o.event} · ${MODE_LABEL[o.mode]}` : MODE_LABEL[o.mode]),
      h('h2', { class: 'result-title' }, icon(o.position === 1 || drift ? Trophy : Medal, { size: 34 }), h('span', { class: 'result-score' }, headline)),
      o.newBest && h('div', {}, h('span', { class: 'badge' }, icon(Sparkles, { size: 14 }), 'New best')),
      o.tuned && h('p', { class: 'result-note' }, 'Dev tuning was changed during this run, so it was not saved.'),
    ),
    !drift && h('div', { class: 'section-title' }, 'Standings'),
    !drift && table,
    h('div', { class: 'result-actions' }, retry, btn(Video, 'Replay', o.onReplay), btn(Wrench, 'Garage', o.onGarage), btn(X, 'Menu', o.onMenu)),
  );
  const root = railScreen('results', col, keybar([{ keys: ['Enter'], label: 'Retry' }]));
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Results');
  requestAnimationFrame(() => retry.focus({ preventScroll: true }));
  return root;
}

/** A settings page: its tab and the rows it shows. */
interface SettingsPage {
  id: string;
  label: string;
  icon: IconNode;
  rows(): (HTMLElement | null | false | undefined)[];
}

/** The page the settings panel opened on last, so it reopens where the player left it (this visit only). */
let lastPage = 'display';

/**
 * Settings: a row of tabs (display, sound, controls, developer, credits) over
 * the open page, so nothing needs a long scroll and the panel fits the rail's
 * column. Race options (rivals, difficulty, gearbox, traction control) live on
 * the menu's race step instead. Used on the menu's settings step and on the
 * pause screen's.
 */
export function settingsPanel(s: Settings, onChange: (s: Settings) => void, music?: MusicPlayer): HTMLElement {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    s[k] = v;
    onChange(s);
  };
  const toggle = (k: 'retro' | 'radialBlur' | 'showFps' | 'flashEffects' | 'debugTuningPanel' | 'debugCameraPanel') => onOff(s[k], (v) => set(k, v));
  const slider = (label: string, value: number, onInput: (v: number) => void) => {
    const r = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value, class: 'setting-slider', 'aria-label': label }) as HTMLInputElement;
    r.addEventListener('input', () => onInput(Number(r.value)));
    return r;
  };
  const pages: SettingsPage[] = [
    {
      id: 'display',
      label: 'Display',
      icon: Monitor,
      rows: () => [
        settingRow(
          'Graphics',
          segmented<Quality | 'auto'>(
            [
              // With Auto on, s.quality is the tier auto quality is running at.
              { value: 'auto', label: s.autoQuality ? `Auto (${{ low: 'Low', medium: 'Med', high: 'High' }[s.quality]})` : 'Auto' },
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Med' },
              { value: 'high', label: 'High' },
            ],
            s.autoQuality ? 'auto' : s.quality,
            (v) => {
              if (v === 'auto') set('autoQuality', true);
              else {
                s.autoQuality = false;
                set('quality', v);
              }
            },
          ),
          'Auto adapts to your frame rate',
        ),
        settingRow('Retro PS2 mode', toggle('retro')),
        settingRow('Speed blur', toggle('radialBlur')),
        settingRow('Flash effects', toggle('flashEffects'), 'Lightning and police strobes'),
        settingRow('FPS counter', toggle('showFps')),
      ],
    },
    {
      id: 'sound',
      label: 'Sound',
      icon: Volume2,
      rows: () => [
        settingRow('Engine volume', slider('Engine volume', s.engineVolume, (v) => set('engineVolume', v))),
        music && settingRow('Music volume', slider('Music volume', music.muted ? 0 : music.volume, (v) => music.setVolume(v))),
        h('p', { class: 'setting-note' }, 'M mutes the music, [ and ] skip tracks.'),
      ],
    },
    {
      id: 'controls',
      label: 'Controls',
      icon: Keyboard,
      rows: () => {
        // One device's bindings at a time: a key column and an action column read faster than a run-on line.
        const list = h('div', { class: 'controls-list' });
        const show = (device: keyof typeof CONTROLS) =>
          list.replaceChildren(...CONTROLS[device].flatMap(([keys, action]) => [h('span', { class: 'keys' }, ...keys.flatMap((k, i) => (i ? [' / ', h('kbd', {}, k)] : [h('kbd', {}, k)]))), h('span', {}, action)]));
        show('keyboard');
        return [
          segmented<keyof typeof CONTROLS>(
            [
              { value: 'keyboard', label: 'Keyboard', icon: Keyboard },
              { value: 'gamepad', label: 'Gamepad', icon: Gamepad2 },
              { value: 'touch', label: 'Touch', icon: Smartphone },
            ],
            'keyboard',
            show,
          ),
          list,
        ];
      },
    },
    {
      id: 'developer',
      label: 'Developer',
      icon: Code,
      rows: () => [settingRow('Physics tuning panel', toggle('debugTuningPanel'), '` or F2 in a race'), settingRow('Camera tuning panel', toggle('debugCameraPanel'), 'F3 in a race')],
    },
    { id: 'credits', label: 'Credits', icon: Heart, rows: credits },
  ];
  const pane = h('div', { class: 'settings-pane', role: 'tabpanel' });
  const tabs = pages.map((p) => h('button', { class: 'tab settings-tab', type: 'button', role: 'tab', onclick: () => open(p) }, icon(p.icon, { size: 15 }), h('span', {}, p.label)));
  const open = (p: SettingsPage) => {
    lastPage = p.id;
    tabs.forEach((t, i) => {
      const on = pages[i] === p;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', String(on));
    });
    pane.replaceChildren(...p.rows().filter((r): r is HTMLElement => !!r));
    pane.setAttribute('aria-label', p.label);
  };
  open(pages.find((p) => p.id === lastPage) ?? pages[0]);
  return h('div', { class: 'settings' }, h('nav', { class: 'tabs settings-tabs', role: 'tablist', 'aria-label': 'Settings pages' }, ...tabs), pane);
}

/** One labelled setting: the name (and an optional hint under it) on the left, its control on the right. */
export function settingRow(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('div', { class: 'setting-row' }, h('span', { class: 'name' }, label, hint && h('span', { class: 'hint' }, hint)), control);
}

/** An Off / On segmented switch. */
export function onOff(value: boolean, onChange: (v: boolean) => void): HTMLElement {
  return segmented(
    [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
    value ? 'on' : 'off',
    (v) => onChange(v === 'on'),
  );
}

/** Bindings per device for the settings dialog: keys (alternatives) and what they do. */
const CONTROLS: Record<'keyboard' | 'gamepad' | 'touch', [string[], string][]> = {
  keyboard: [
    [['W', '↑'], 'Throttle'],
    [['S', '↓'], 'Brake, reverse'],
    [['A', 'D'], 'Steer'],
    [['Space'], 'Handbrake'],
    [['Shift', 'N'], 'Nitrous'],
    [['Q', 'E'], 'Shift down, up (manual)'],
    [['R'], 'Reset car'],
    [['C'], 'Camera'],
    [['Esc'], 'Pause'],
    [['M'], 'Mute music'],
    [['[', ']'], 'Previous, next track'],
    [['`', 'F2'], 'Tuning panel'],
  ],
  gamepad: [
    [['Left stick'], 'Steer'],
    [['RT', 'LT'], 'Throttle, brake'],
    [['X'], 'Handbrake'],
    [['A', 'B'], 'Nitrous'],
    [['LB', 'RB'], 'Shift down, up'],
    [['Y'], 'Reset car'],
    [['Back'], 'Camera'],
    [['Start'], 'Pause'],
  ],
  touch: [
    [['Left half'], 'Drag to steer'],
    [['Right side'], 'Pedals, handbrake, nitrous'],
    [['Top right'], 'Pause, camera, reset'],
  ],
};

/** The credits page of the settings, with the build version at the foot. */
function credits(): HTMLElement[] {
  return [
    h(
      'div',
      { class: 'credits' },
      h('p', {}, 'Car models by ', h('b', {}, 'IceMaan'), ' (icemaan.itch.io), released as CC0. Thank you for sharing them with the world!'),
      h('p', { class: 'muted' }, 'The Proto Compact and Proto Hatch, with their bumpers, skirts, spoilers and rims, are reworked by eshell from IceMaan\'s S64 and GC14 low poly cars; the Proto Coupe is eshell\'s own.'),
      h('p', {}, 'Icons: ', h('b', {}, 'Lucide'), ' (lucide.dev), ISC license.'),
      musicCredits(),
      h('p', {}, 'Crowd sound effects from ', h('b', {}, 'freesound_community'), ' (Pixabay): "applause" (freesound_community-applause-70507.mp3) and "crowd cheering" (freesound_community-crowd-cheering-6229.mp3), Pixabay Content License.'),
      h('p', { class: 'muted' }, 'The engine voices are synthesized in the browser after the pulse train model of ', h('b', {}, 'Engine Simulator'), ' by Ange Yaghi (github.com/ange-yaghi/engine-sim, MIT): every cylinder fires in its order and its pulse travels its own header before the pipe colors it.'),
      h('p', {}, 'Built with three.js, Vite and glTF Transform. City, signs, vinyls and the Proto RS are generated procedurally. All shop and sponsor names are fictional.'),
    ),
    h('div', { class: 'build-version' }, BUILD_VERSION),
  ];
}

/** The loading card: the logo, what is loading and a sweeping bar in the rule's colors. */
export function loadingScreen(what?: string): HTMLElement {
  return h(
    'div',
    { class: 'loading', role: 'status' },
    h('div', { class: 'logo' }, 'STREET SCENE'),
    h('div', { class: 'loading-label' }, what ? `Loading ${what}` : 'Loading'),
    h('div', { class: 'loading-bar', 'aria-hidden': 'true' }, h('i')),
  );
}
