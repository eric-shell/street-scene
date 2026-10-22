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

const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';

/** The donor models (Sketchfab, CC BY 4.0) the garage cars and rims are made from: each credit names
 * the model, its author and the licence, as CC BY asks (docs/carDonors.md, docs/carWheels.md). */
const DONOR_CREDITS: { use: string; title: string; uid: string; author: string }[] = [
  { use: 'Proto Hatch', title: '2002_volkswagen_golf_r32_mk4', uid: '98e6828648084ae3b877ad69e8ad36dc', author: 'tangwang920' },
  { use: 'Proto Coupe', title: 'Mazda RX7 FD 1999', uid: '06986b70c65b44c5a7315ed467b621a6', author: 'niev' },
  { use: 'Proto Wagon', title: '1992 Audi S2 Avant', uid: '939dc6336dfe4fbd99fdb3608d58de56', author: 'tonielpro520' },
  { use: 'Kiba rims', title: 'BBS RS16 Tuner Car Wheel', uid: '4e50d45e5ff04d00927a50c150e088c1', author: 'TinoD2' },
  { use: 'Hoshi rims', title: 'Mugen M7 Tuner Car Wheel', uid: '3efc6a0cb9cc44d9adf24e226991a261', author: 'TinoD2' },
  { use: 'Rensa rims', title: 'Work Equip 03 Car Wheel', uid: '58330f40b725444e8c00bdbbfd88cc98', author: 'TinoD2' },
  { use: 'Tsuki rims', title: 'Work Meister S1 3P Wheel', uid: '7205c04f3cb24a7dbdaf6a304fb31f21', author: 'alexanderlyreo' },
  { use: 'Ginga rims', title: 'Stance Wheel R13x10"', uid: '6c8a9dc226b64454a3af8dc37f7359ec', author: 'terllok' },
  { use: 'Hibana rims', title: 'Wire rim', uid: 'bda093957f8e47a7b27270de6c3e0d14', author: '3dpeter' },
  { use: 'Senko rims', title: 'Concept car Rim', uid: 'e36860f9f8de4d8e8429cb07007142f2', author: 'LagzDesign' },
  { use: 'Arashi rims', title: 'Car Wheel / rim', uid: '232904121fff4e558b55ce724df7e47f', author: 'UnforgettableName' },
];

/** The credits page of the settings, with the build version at the foot. */
function credits(): HTMLElement[] {
  return [
    h(
      'div',
      { class: 'settings__credits' },
      ...DONOR_CREDITS.map((c) =>
        h('p', {}, `${c.use}: `, link(`https://sketchfab.com/3d-models/${c.uid}`, `"${c.title}"`), ' by ', link(`https://sketchfab.com/${c.author}`, h('b', {}, c.author)), ', ', link(CC_BY, 'CC BY 4.0'), '.'),
      ),
      h('p', { class: 'muted' }, 'Changes: the cars are reduced to about 8,000 triangles at their true size, with badges, antennas, wipers and interiors removed and their materials remapped; the rims are reduced, fitted to one shared tire and center cap, and some wear a turned lip. Every car and rim ships under a fictional name.'),
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
