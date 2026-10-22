/**
 * The settings panel the main menu's settings step and the pause screen's
 * share, and the setting rows the menu's race step builds with it. Styled by
 * _settings.scss (the panel, its card on the menu's and pause rails) and
 * _setting-row.scss (rows, notes, the controls list).
 */
import { h, keyCaps, link, segmented, selectTab, tab } from '../kit/dom';
import { Code, Gamepad2, Heart, Keyboard, Monitor, Smartphone, Volume2, type IconNode } from '../kit/icons';
import type { Quality, Settings } from '../settings';
import type { MusicPlayer } from '../../audio/musicPlayer';
import { musicCredits } from '../panels/musicWidget';
import trafficModels from '../../assets/trafficModels.json';
import { BUILD_VERSION } from '../../version';

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
  const toggle = (k: 'retro' | 'radialBlur' | 'showFps' | 'flashEffects' | 'rumble' | 'debugMode') => onOff(s[k], (v) => set(k, v));
  const slider = (label: string, value: number, onInput: (v: number) => void) => {
    const r = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value, class: 'setting-row__slider', 'aria-label': label }) as HTMLInputElement;
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
        settingRow('Master', slider('Master volume', s.masterVolume, (v) => set('masterVolume', v)), 'Everything but the music'),
        settingRow('Engine', slider('Engine volume', s.engineVolume, (v) => set('engineVolume', v))),
        settingRow('Effects', slider('Effects volume', s.effectsVolume, (v) => set('effectsVolume', v)), 'Impacts, nitrous, horn'),
        settingRow('Ambience', slider('Ambience volume', s.ambienceVolume, (v) => set('ambienceVolume', v)), 'Crowds, trains, weather'),
        settingRow('Interface', slider('Interface volume', s.interfaceVolume, (v) => set('interfaceVolume', v)), 'Menu sounds'),
        music && settingRow('Music', slider('Music volume', music.muted ? 0 : music.volume, (v) => music.setVolume(v))),
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
          list.replaceChildren(...CONTROLS[device].flatMap(([keys, action]) => [h('span', { class: 'controls-list__keys' }, ...keyCaps(keys, ' / ')), h('span', {}, action)]));
        show('keyboard');
        return [
          settingRow('Gamepad rumble', toggle('rumble'), 'Hits, landings, rough ground, nitrous'),
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
      rows: () => [settingRow('Debug mode', toggle('debugMode'), 'Physics (` or F2) and camera (F3) tuning panels in races and free roam')],
    },
    { id: 'credits', label: 'Credits', icon: Heart, rows: credits },
  ];
  const pane = h('div', { class: 'settings__pane', role: 'tabpanel' });
  const tabs = pages.map((p) => tab(p.icon, h('span', {}, p.label), () => open(p), 'settings__tab'));
  const open = (p: SettingsPage) => {
    lastPage = p.id;
    selectTab(tabs, tabs[pages.indexOf(p)]);
    pane.replaceChildren(...p.rows().filter((r): r is HTMLElement => !!r));
    pane.setAttribute('aria-label', p.label);
  };
  open(pages.find((p) => p.id === lastPage) ?? pages[0]);
  return h('div', { class: 'settings' }, h('nav', { class: 'tabs settings__tabs', role: 'tablist', 'aria-label': 'Settings pages' }, ...tabs), pane);
}

/** One labelled setting: the name (and an optional hint under it) on the left, its control on the right. */
export function settingRow(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('div', { class: 'setting-row' }, h('span', { class: 'setting-row__name' }, label, hint && h('span', { class: 'setting-row__hint' }, hint)), control);
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

/** Bindings per device for the settings' Controls page: keys (alternatives) and what they do. */
const CONTROLS: Record<'keyboard' | 'gamepad' | 'touch', [string[], string][]> = {
  keyboard: [
    [['W', '↑'], 'Throttle'],
    [['S', '↓'], 'Brake, reverse'],
    [['A', 'D'], 'Steer'],
    [['Space'], 'Handbrake'],
    [['N'], 'Nitrous'],
    [['Shift'], 'Horn (hold for a long blast)'],
    [['Q', 'E'], 'Shift down, up (manual)'],
    [['R'], 'Reset car'],
    [['C'], 'Camera'],
    [['H'], 'Hide the HUD'],
    [['?'], 'Keys and tips for the screen'],
    [['Esc'], 'Pause'],
    [['M'], 'Mute music'],
    [['[', ']'], 'Previous, next track'],
    [['`', 'F2'], 'Physics panel (debug mode)'],
    [['F3'], 'Camera panel (debug mode)'],
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
    [['D-pad', 'Left stick'], 'Move around menus'],
    [['A'], 'Press'],
    [['B', 'Start'], 'Back, resume'],
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
      { class: 'settings__credits' },
      h('p', {}, 'Car models by ', h('b', {}, 'IceMaan'), ' (icemaan.itch.io), released as CC0. Thank you for sharing them with the world!'),
      h('p', { class: 'muted' }, 'The Proto Compact and Proto Hatch, with their bumpers, skirts, spoilers and rims, are reworked by eshell from IceMaan\'s S64 and GC14 low poly cars; the Proto Coupe is eshell\'s own.'),
      ...trafficModels.credits.map((c) =>
        h('p', {}, 'Traffic: ', link(c.url, `"${c.title}"`), ' by ', link(c.creatorUrl, h('b', {}, c.creator)), ', ', link(c.licenseUrl, c.license), `. ${c.changes}.`),
      ),
      h('p', {}, 'Icons: ', h('b', {}, 'Lucide'), ' (lucide.dev), ISC license.'),
      musicCredits(),
      h('p', {}, 'Crowd sound effects from ', h('b', {}, 'freesound_community'), ' (Pixabay): "applause" (freesound_community-applause-70507.mp3) and "crowd cheering" (freesound_community-crowd-cheering-6229.mp3), Pixabay Content License.'),
      h('p', { class: 'muted' }, 'The engine voices are synthesized in the browser after the pulse train model of ', h('b', {}, 'Engine Simulator'), ' by Ange Yaghi (github.com/ange-yaghi/engine-sim, MIT): every cylinder fires in its order and its pulse travels its own header before the pipe colors it.'),
      h('p', {}, 'Built with three.js, Vite and glTF Transform. City, signs, vinyls and the Proto RS are generated procedurally. All shop and sponsor names are fictional.'),
    ),
    h('div', { class: 'settings__version' }, BUILD_VERSION),
  ];
}
