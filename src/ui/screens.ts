/** Dialogs (pause, results, settings) and the settings panel. Every screen returns its root element; callers remove it. The main menu is ui/menu.ts. */
import { btn, h, iconBtn, segmented } from './dom';
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
import type { RaceMode } from '../sim/race';
import type { MusicPlayer } from '../audio/musicPlayer';
import { musicCredits } from './musicWidget';
import { BUILD_VERSION } from '../version';

export function pauseMenu(o: {
  onResume(): void;
  onRestart(): void;
  onSettings(): void;
  onQuit(): void;
  /** Restart button label (default "Restart race"). */
  restartLabel?: string;
  /** Extra buttons under Restart (free roam: a new city). */
  extra?: { icon: IconNode; label: string; onClick(): void }[];
}): HTMLElement {
  return h(
    'div',
    { class: 'screen center dim' },
    h(
      'div',
      { class: 'dialog panel', role: 'dialog', 'aria-label': 'Paused' },
      h('h2', { class: 'title' }, icon(Pause, { size: 22 }), 'Paused'),
      btn(Play, 'Resume', o.onResume, 'big primary'),
      btn(RotateCcw, o.restartLabel ?? 'Restart race', o.onRestart, 'big'),
      ...(o.extra ?? []).map((x) => btn(x.icon, x.label, x.onClick, 'big')),
      btn(SettingsIcon, 'Settings', o.onSettings, 'big'),
      btn(X, 'Quit to menu', o.onQuit, 'big'),
    ),
  );
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
        h('td', {}, r.name, h('div', { class: 'muted', style: 'font-size:12px' }, r.car + (r.bestLap ? ` · best lap ${formatTime(r.bestLap)}` : ''))),
        h('td', { class: 'time' }, (r.estimated ? '~' : '') + formatTime(r.time)),
      ),
    ),
  );
  const headline =
    o.mode === 'drift'
      ? `${Math.round(o.driftScore ?? 0).toLocaleString()} pts`
      : o.position === 1
        ? 'You win!'
        : `${ordinal(o.position)} place`;
  return h(
    'div',
    { class: 'screen center dim' },
    h(
      'div',
      { class: 'dialog panel', role: 'dialog', 'aria-label': 'Results' },
      o.event && h('div', { class: 'label' }, icon(Flag, { size: 14 }), `${o.event} · ${MODE_LABEL[o.mode]}`),
      h('h2', { class: 'title' }, icon(o.position === 1 || o.mode === 'drift' ? Trophy : Medal, { size: 24 }), headline),
      o.newBest && h('div', {}, h('span', { class: 'badge' }, icon(Sparkles, { size: 14 }), 'New best')),
      o.tuned && h('div', { class: 'muted' }, 'Dev tuning was changed during this run, so it was not saved.'),
      o.mode !== 'drift' && table,
      h('div', { class: 'row' }, btn(RotateCcw, 'Retry', o.onRetry, 'primary'), btn(Video, 'Replay', o.onReplay), btn(Wrench, 'Garage', o.onGarage), btn(X, 'Menu', o.onMenu)),
    ),
  );
}

/** A settings page in the sidebar: its tab and the rows it shows. */
interface SettingsPage {
  id: string;
  label: string;
  icon: IconNode;
  rows(): (HTMLElement | null | false | undefined)[];
}

/** The page the settings panel opened on last, so it reopens where the player left it (this visit only). */
let lastPage = 'display';

/**
 * Settings: a sidebar of pages (display, sound, controls, developer, credits)
 * beside the page itself, so nothing needs a long scroll. Race options
 * (rivals, difficulty, gearbox, traction control) live on the menu's race
 * step instead. Used on the menu's settings step and in the pause dialog.
 */
export function settingsPanel(s: Settings, onChange: (s: Settings) => void, music?: MusicPlayer): HTMLElement {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    s[k] = v;
    onChange(s);
  };
  const toggle = (k: 'retro' | 'radialBlur' | 'showFps' | 'debugTuningPanel' | 'debugCameraPanel') => onOff(s[k], (v) => set(k, v));
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
  const tabs = pages.map((p) => {
    const b = h('button', { class: 'settings-tab', type: 'button', role: 'tab', onclick: () => open(p) }, icon(p.icon, { size: 17 }), h('span', {}, p.label));
    return b;
  });
  const open = (p: SettingsPage) => {
    lastPage = p.id;
    tabs.forEach((t, i) => {
      const on = pages[i] === p;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', String(on));
    });
    pane.replaceChildren(h('h3', { class: 'section-title' }, p.label), ...p.rows().filter((r): r is HTMLElement => !!r));
    pane.setAttribute('aria-label', p.label);
  };
  open(pages.find((p) => p.id === lastPage) ?? pages[0]);
  return h('div', { class: 'settings' }, h('nav', { class: 'settings-nav', role: 'tablist', 'aria-label': 'Settings pages' }, ...tabs), pane);
}

/** The pause menu's settings: the same panel in a dialog. */
export function settingsScreen(s: Settings, onChange: (s: Settings) => void, onClose: () => void, music?: MusicPlayer): HTMLElement {
  return h(
    'div',
    { class: 'screen center dim' },
    h(
      'div',
      { class: 'dialog settings-dialog panel', role: 'dialog', 'aria-label': 'Settings' },
      h('h2', { class: 'title' }, icon(SettingsIcon, { size: 22 }), h('span', { class: 'grow' }, 'Settings'), iconBtn(X, 'Close', onClose, 'small')),
      settingsPanel(s, onChange, music),
    ),
  );
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
      h('p', {}, 'Built with three.js, Vite and glTF Transform. City, signs, vinyls and the Proto RS are generated procedurally. All shop and sponsor names are fictional.'),
    ),
    h('div', { class: 'build-version' }, BUILD_VERSION),
  ];
}

export function loadingScreen(text = 'LOADING'): HTMLElement {
  return h('div', { class: 'loading' }, text);
}
