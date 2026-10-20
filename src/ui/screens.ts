/** Menus and dialogs. Every screen returns its root element; callers remove it. */
import { btn, h, iconBtn, segmented } from './dom';
import {
  Car,
  Flag,
  Heart,
  Info,
  Medal,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  Route,
  Settings as SettingsIcon,
  Shuffle,
  Sparkles,
  Trophy,
  Video,
  Wind,
  Wrench,
  X,
  Calendar,
  Keyboard,
  Gamepad2,
  Smartphone,
  Drone,
  Music,
  Compass,
  type IconNode,
  icon,
} from './icons';
import { Difficulty, Quality, Settings } from './settings';
import { formatTime, ordinal } from './format';
import type { RaceMode } from '../sim/race';
import type { BestRecord } from '../replay/replay';
import type { MusicPlayer } from '../audio/musicPlayer';
import { musicCredits } from './musicWidget';
import { BUILD_VERSION } from '../version';

export interface MenuOptions {
  seed: string;
  isDaily: boolean;
  bests: Record<RaceMode, BestRecord | null>;
  carName: string;
  hasReplay: boolean;
  onRace(mode: RaceMode): void;
  /** Free roam: the whole city, no route, rules or rivals. */
  onFreeRoam(): void;
  onGarage(): void;
  onReplay(): void;
  onDrone(): void;
  onSettings(): void;
  onCredits(): void;
  onSeed(seed: string | null): void;
}

const MODE_INFO: Record<RaceMode, { label: string; icon: typeof Flag; sub: string }> = {
  circuit: { label: 'Circuit', icon: RotateCcw, sub: '3 laps' },
  sprint: { label: 'Sprint', icon: Route, sub: 'A to B' },
  drift: { label: 'Drift', icon: Wind, sub: 'Score attack' },
};

export function mainMenu(o: MenuOptions): HTMLElement {
  const root = h('div', { class: 'screen' });
  const modes = h('div', { class: 'modes' });
  (Object.keys(MODE_INFO) as RaceMode[]).forEach((m) => {
    const info = MODE_INFO[m];
    const best = o.bests[m];
    const card = h('button', { class: 'mode-card', type: 'button', onclick: () => o.onRace(m) });
    // A set record shows as a value (mono, secondary color); otherwise the mode's one-line description.
    const record = best ? (m === 'drift' ? `Best ${Math.round(best.score ?? 0).toLocaleString()}` : `Best ${formatTime(best.time)}`) : null;
    card.append(icon(info.icon, { size: 22 }), info.label, h('span', { class: record ? 'best record' : 'best' }, record ?? info.sub));
    modes.append(card);
  });
  const roam = h('button', { class: 'mode-card roam', type: 'button', onclick: () => o.onFreeRoam() });
  roam.append(icon(Compass, { size: 22 }), 'Free roam', h('span', { class: 'best' }, 'The whole city, no rules'));
  modes.append(roam);
  const seedInput = h('input', { type: 'text', class: 'mono', value: o.seed, maxlength: 32, 'aria-label': 'Seed', placeholder: 'Type a seed', style: 'flex:1;min-width:0' }) as HTMLInputElement;
  seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') o.onSeed(seedInput.value.trim() || null);
  });
  const event = h(
    'div',
    { class: 'event panel' },
    h('div', { class: 'event-head' }, h('span', { class: 'label' }, icon(Calendar, { size: 14 }), o.isDaily ? 'Event of the day' : 'Custom event'), h('span', { class: 'seed', title: 'City seed' }, `#${o.seed}`)),
    h(
      'div',
      { class: 'row' },
      seedInput,
      iconBtn(Play, 'Use seed', () => o.onSeed(seedInput.value.trim() || null), 'small'),
      iconBtn(Shuffle, 'Random seed', () => o.onSeed(String(Math.floor(Math.random() * 1e8))), 'small'),
      !o.isDaily && iconBtn(Calendar, 'Back to today', () => o.onSeed(null), 'small'),
    ),
  );
  // Races are the main action (the mode cards); the garage comes next, everything else shares a compact grid.
  const replay = btn(Video, 'Replay', o.onReplay, '', o.hasReplay ? 'Last race' : 'No race yet');
  if (!o.hasReplay) replay.setAttribute('disabled', '');
  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': 'Main menu' },
    btn(Wrench, 'Garage', o.onGarage, 'big', `Driving: ${o.carName}`),
    h('div', { class: 'nav-more' }, replay, btn(Drone, 'Drone flyover', o.onDrone), btn(SettingsIcon, 'Settings', o.onSettings), btn(Info, 'Credits', o.onCredits)),
  );
  // The title block is what the boot splash lands on (`.menu-head`, see ui/splash.ts).
  const menu = h('div', { class: 'menu' }, h('div', { class: 'menu-head' }, h('h1', { class: 'logo' }, 'STREET SCENE'), h('div', { class: 'tagline' }, 'Street racing after dark'), h('div', { class: 'build-version' }, BUILD_VERSION)), event, h('div', { class: 'section-title' }, 'Race'), modes, nav);
  root.append(menu);
  return root;
}

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

export function resultsScreen(o: {
  mode: RaceMode;
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
      h('h2', { class: 'title' }, icon(o.position === 1 || o.mode === 'drift' ? Trophy : Medal, { size: 24 }), headline),
      o.newBest && h('div', {}, h('span', { class: 'badge' }, icon(Sparkles, { size: 14 }), 'New best')),
      o.tuned && h('div', { class: 'muted' }, 'Dev tuning was changed during this run, so it was not saved.'),
      o.mode !== 'drift' && table,
      h('div', { class: 'row' }, btn(RotateCcw, 'Retry', o.onRetry, 'primary'), btn(Video, 'Replay', o.onReplay), btn(Wrench, 'Garage', o.onGarage), btn(X, 'Menu', o.onMenu)),
    ),
  );
}

export function settingsScreen(s: Settings, onChange: (s: Settings) => void, onClose: () => void, music?: MusicPlayer): HTMLElement {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    s[k] = v;
    onChange(s);
  };
  const toggle = (k: 'retro' | 'radialBlur' | 'manualGearbox' | 'showFps' | 'tractionControl' | 'debugTuningPanel' | 'debugCameraPanel') =>
    segmented(
      [
        { value: 'off', label: 'Off' },
        { value: 'on', label: 'On' },
      ],
      s[k] ? 'on' : 'off',
      (v) => set(k, v === 'on'),
    );
  const row = (label: string, control: HTMLElement) => h('div', { class: 'setting-row' }, h('span', { class: 'name' }, label), control);
  const section = (ic: IconNode, label: string) => h('div', { class: 'section-title' }, icon(ic, { size: 14 }), label);
  const slider = (label: string, value: number, onInput: (v: number) => void) => {
    const r = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value, style: 'width:160px', 'aria-label': label }) as HTMLInputElement;
    r.addEventListener('input', () => onInput(Number(r.value)));
    return r;
  };
  // One device's bindings at a time: a key column and an action column read faster than a run-on line.
  const controlsList = h('div', { class: 'controls-list' });
  const showControls = (device: keyof typeof CONTROLS) => {
    controlsList.replaceChildren(...CONTROLS[device].flatMap(([keys, action]) => [h('span', { class: 'keys' }, ...keys.flatMap((k, i) => (i ? [' / ', h('kbd', {}, k)] : [h('kbd', {}, k)]))), h('span', {}, action)]));
  };
  showControls('keyboard');
  return h(
    'div',
    { class: 'screen center dim' },
    h(
      'div',
      { class: 'dialog panel', role: 'dialog', 'aria-label': 'Settings' },
      h('h2', { class: 'title' }, icon(SettingsIcon, { size: 22 }), h('span', { class: 'grow' }, 'Settings'), iconBtn(X, 'Close', onClose, 'small')),
      section(Monitor, 'Display'),
      row(
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
      ),
      row('Retro PS2 mode', toggle('retro')),
      row('Speed blur', toggle('radialBlur')),
      row('FPS counter', toggle('showFps')),
      section(Car, 'Driving'),
      row('Manual gearbox (Q/E)', toggle('manualGearbox')),
      row('Traction control', toggle('tractionControl')),
      section(Trophy, 'Rivals'),
      row(
        'AI difficulty',
        segmented<Difficulty>(
          [
            { value: 'easy', label: 'Easy' },
            { value: 'medium', label: 'Med' },
            { value: 'hard', label: 'Hard' },
          ],
          s.difficulty,
          (v) => set('difficulty', v),
        ),
      ),
      row(
        'Opponents',
        segmented(
          ['0', '1', '2', '3'].map((v) => ({ value: v, label: v })),
          String(s.opponents),
          (v) => set('opponents', Number(v)),
        ),
      ),
      section(Music, 'Sound'),
      row('Engine volume', slider('Engine volume', s.engineVolume, (v) => set('engineVolume', v))),
      music && row('Music volume', slider('Music volume', music.muted ? 0 : music.volume, (v) => music.setVolume(v))),
      section(Keyboard, 'Controls'),
      segmented<keyof typeof CONTROLS>(
        [
          { value: 'keyboard', label: 'Keyboard', icon: Keyboard },
          { value: 'gamepad', label: 'Gamepad', icon: Gamepad2 },
          { value: 'touch', label: 'Touch', icon: Smartphone },
        ],
        'keyboard',
        showControls,
      ),
      controlsList,
      section(Wrench, 'Debug'),
      row('Physics tuning panel (` / F2)', toggle('debugTuningPanel')),
      row('Camera tuning panel', toggle('debugCameraPanel')),
      btn(X, 'Close', onClose, 'primary'),
    ),
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

export function creditsScreen(onClose: () => void): HTMLElement {
  return h(
    'div',
    { class: 'screen center dim' },
    h(
      'div',
      { class: 'dialog panel', role: 'dialog', 'aria-label': 'Credits' },
      h('h2', { class: 'title' }, icon(Heart, { size: 22 }), h('span', { class: 'grow' }, 'Credits'), iconBtn(X, 'Close', onClose, 'small')),
      h(
        'div',
        { style: 'line-height:1.6;font-size:16px' },
        h('p', {}, 'Car models by ', h('b', {}, 'IceMaan'), ' (icemaan.itch.io), released as CC0. Thank you for sharing them with the world!'),
        h('p', { class: 'muted' }, 'The Proto Compact and Proto Hatch, with their bumpers, skirts, spoilers and rims, are reworked by eshell from IceMaan\'s S64 and GC14 low poly cars; the Proto Coupe is eshell\'s own.'),
        h('p', {}, 'Icons: ', h('b', {}, 'Lucide'), ' (lucide.dev), ISC license.'),
        musicCredits(),
        h('p', {}, 'Crowd sound effects from ', h('b', {}, 'freesound_community'), ' (Pixabay): "applause" (freesound_community-applause-70507.mp3) and "crowd cheering" (freesound_community-crowd-cheering-6229.mp3), Pixabay Content License.'),
        h('p', {}, 'Built with three.js, Vite and glTF Transform. City, signs, vinyls and the Proto RS are generated procedurally. All shop and sponsor names are fictional.'),
      ),
      btn(X, 'Close', onClose, 'primary'),
    ),
  );
}

export function loadingScreen(text = 'LOADING'): HTMLElement {
  return h('div', { class: 'loading' }, text);
}
