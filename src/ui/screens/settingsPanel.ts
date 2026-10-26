/**
 * The settings panel the main menu's settings step and the pause screen's
 * share, and the setting rows the menu's race step builds with it. Styled by
 * _settings.scss (the panel, its card on the menu's and pause rails) and
 * _setting-row.scss (rows, notes, the controls list).
 */
import { h, keyCaps, link, segmented, selectTab, tab } from '../kit/dom';
import { CircleUser, Code, Gamepad2, Heart, Keyboard, Monitor, ShieldCheck, Smartphone, Volume2, type IconNode } from '../kit/icons';
import type { Quality, Settings } from '../settings';
import type { MusicPlayer } from '../../audio/musicPlayer';
import { musicCredits } from '../panels/musicWidget';
import trafficModels from '../../assets/trafficModels.json';
import plantModels from '../../assets/plantModels.json';
import { BUILD_VERSION } from '../../version';
import { accountsEnabled } from '../../account/account';
import { accountPage } from './accountPage';
import { privacyPage } from './privacyPage';
import { FEATURES } from '../../shared/features';

/** A settings page: its tab and the rows it shows. */
interface SettingsPage {
  id: string;
  label: string;
  icon: IconNode;
  rows(): (HTMLElement | null | false | undefined)[];
}

/** The page the settings panel opened on last, so it reopens where the player left it (this visit only). */
let lastPage: string | null = null;

/**
 * Settings: a row of tabs (account when the build has accounts, display, sound, controls, developer, privacy, credits) over
 * the open page, so nothing needs a long scroll and the panel fits the rail's
 * column. Race options (rivals, difficulty, gearbox, traction control) live on
 * the menu's race step instead. Used on the menu's settings step and on the
 * pause screen's. It opens on `page` when given (the menu's Sign in opens Account), else the last page seen, else the first.
 */
export function settingsPanel(s: Settings, onChange: (s: Settings) => void, music?: MusicPlayer, page?: string): HTMLElement {
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
  const all: (SettingsPage | false)[] = [
    accountsEnabled() && { id: 'account', label: 'Account', icon: CircleUser, rows: () => accountPage(s, onChange) },
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
        // One device's bindings at a time, in groups under the garage's section titles: a key column and an
        // action column read faster than a run-on line.
        const list = h('div', { class: 'controls-list' });
        const show = (device: keyof typeof CONTROLS) =>
          list.replaceChildren(
            ...CONTROLS[device].flatMap(([group, rows]) => [
              h('div', { class: 'section-title controls-list__group' }, group),
              ...rows.flatMap(([keys, action]) => [h('span', { class: 'controls-list__keys' }, ...keyCaps(keys, ' / ')), h('span', {}, action)]),
            ]),
          );
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
    ...(FEATURES.devTools
      ? [
          {
            id: 'developer',
            label: 'Developer',
            icon: Code,
            rows: () => [settingRow('Debug mode', toggle('debugMode'), 'Physics (` or F2) and camera (F3) tuning panels in races and free roam')],
          },
        ]
      : []),
    { id: 'privacy', label: 'Privacy', icon: ShieldCheck, rows: privacyPage },
    { id: 'credits', label: 'Credits', icon: Heart, rows: credits },
  ];
  const pages = all.filter((p): p is SettingsPage => !!p);
  const pane = h('div', { class: 'settings__pane', role: 'tabpanel' });
  const tabs = pages.map((p) => tab(p.icon, h('span', {}, p.label), () => open(p), 'settings__tab'));
  const open = (p: SettingsPage) => {
    lastPage = p.id;
    selectTab(tabs, tabs[pages.indexOf(p)]);
    pane.replaceChildren(...p.rows().filter((r): r is HTMLElement => !!r));
    pane.scrollTop = 0; // a new page starts at its top, not at the last page's scroll
    pane.setAttribute('aria-label', p.label);
  };
  open(pages.find((p) => p.id === (page ?? lastPage)) ?? pages[0]);
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

/** Bindings per device for the settings' Controls page, in groups: keys (alternatives; 'W + S' a combo) and what they do. */
const CONTROLS: Record<'keyboard' | 'gamepad' | 'touch', [string, [string[], string][]][]> = {
  keyboard: [
    [
      'Driving',
      [
        [['W', '↑'], 'Throttle'],
        [['S', '↓'], 'Brake, reverse'],
        [['A', 'D'], 'Steer'],
        [['Space'], 'Handbrake'],
        [['N'], 'Nitrous'],
        [['Q', 'E'], 'Shift down, up (manual)'],
        [['G'], 'Horn (hold for a long blast)'],
        [['R'], 'Reset car'],
      ],
    ],
    [
      'Launch',
      [
        [['W'], 'Two-step: hold at the line (Launch RPM)'],
        [['W + S'], 'Line lock: burnout while standing'],
        [['Shift + W'], 'Rolling antilag: hold boost on the move (turbo)'],
      ],
    ],
    [
      'View',
      [
        [['C'], 'Camera'],
        [['H'], 'Hide the HUD'],
        [['?'], 'Keys and tips for the screen'],
        [['Esc'], 'Pause'],
      ],
    ],
    [
      'Music',
      [
        [['M'], 'Mute music'],
        [['[', ']'], 'Previous, next track'],
      ],
    ],
    [
      'Debug mode',
      [
        [['`', 'F2'], 'Physics panel'],
        [['F3'], 'Camera panel'],
      ],
    ],
  ],
  gamepad: [
    [
      'Driving',
      [
        [['Left stick'], 'Steer'],
        [['RT', 'LT'], 'Throttle, brake'],
        [['X'], 'Handbrake'],
        [['A', 'B'], 'Nitrous'],
        [['LB', 'RB'], 'Shift down, up'],
        [['Right stick click'], 'Horn'],
        [['Y'], 'Reset car'],
      ],
    ],
    [
      'Launch',
      [
        [['RT'], 'Two-step: hold at the line (Launch RPM)'],
        [['RT + LT'], 'Line lock: burnout while standing'],
        [['Left stick click + RT'], 'Rolling antilag: hold boost on the move (turbo)'],
      ],
    ],
    [
      'Menus',
      [
        [['Back'], 'Camera'],
        [['Start'], 'Pause'],
        [['D-pad', 'Left stick'], 'Move around menus'],
        [['A'], 'Press'],
        [['B', 'Start'], 'Back, resume'],
      ],
    ],
  ],
  touch: [
    [
      'Driving',
      [
        [['Left half'], 'Drag to steer'],
        [['Right side'], 'Pedals, handbrake, nitrous'],
        [['Top right'], 'Pause, camera, reset'],
      ],
    ],
    [
      'Launch',
      [
        [['GAS'], 'Two-step: hold at the line'],
        [['GAS + BRAKE'], 'Line lock: burnout while standing'],
      ],
    ],
  ],
};

const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';

/** The donor models (Sketchfab, CC BY 4.0) the garage cars and wheels are made from: each credit names
 * the model, its author and the licence, as CC BY asks (docs/carDonors.md, docs/carWheels.md). */
const DONOR_CREDITS: { use: string; title: string; uid: string; author: string }[] = [
  { use: 'Proto Hatch', title: '2002_volkswagen_golf_r32_mk4', uid: '98e6828648084ae3b877ad69e8ad36dc', author: 'tangwang920' },
  { use: 'Proto Coupe', title: 'Mazda RX7 FD 1999', uid: '06986b70c65b44c5a7315ed467b621a6', author: 'niev' },
  { use: 'Proto Wagon', title: '1992 Audi S2 Avant', uid: '939dc6336dfe4fbd99fdb3608d58de56', author: 'tonielpro520' },
  { use: 'Kumo wheels', title: 'WORK VS-TX', uid: '31c76095a0754cb1b08591d63973a2c2', author: 'jonver87' },
  { use: 'Yari wheels', title: 'Work Equip 03', uid: '13c021b58f2b4c42ac747feb5457750b', author: 'jonver87' },
  { use: 'Tsume wheels', title: 'Work Equip 40', uid: 'ac9b1a3ffbd8400a9b364d0596fdcc56', author: 'jonver87' },
  { use: 'Hari wheels', title: 'WORK EMITZ', uid: '0dd4b490ee624aeda867cd5ccfe530e6', author: 'jonver87' },
  { use: 'Kasumi wheels', title: 'WORK VS-KF', uid: 'f762ae9a968d4971a9c4c61922310e44', author: 'jonver87' },
  { use: 'Raiden wheels', title: 'Work VS XV', uid: 'bb47f6dd1ab6406289c59e3c0a86be38', author: 'jonver87' },
  { use: 'Ryusei wheels', title: 'WORK VS-XX', uid: '6a1c8ab8df444530a2a0ac93487cf3bd', author: 'jonver87' },
  { use: 'Shinobi wheels', title: 'WORK ZISTANCE W5S', uid: '8a80d5dd27384671bb1beef04234f3db', author: 'jonver87' },
  { use: 'Tsurugi wheels', title: 'WORK Schwert SC2', uid: '054f59d1321e41aebeffa272d4b7f863', author: 'jonver87' },
  { use: 'Kaze wheels', title: 'Work Equip 02', uid: '57f0fcea45df47188bc8531a012d3357', author: 'jonver87' },
  { use: 'Hagane wheels', title: 'Work Euroline DH', uid: 'eab967f5fcab4581bd427ddf6b79da52', author: 'jonver87' },
  { use: 'Kagero wheels', title: 'WORK IMPORT LABEL AL4', uid: '593aed74677d49ff953e068debce4b87', author: 'jonver87' },
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
      h('p', { class: 'muted' }, 'Changes: the cars are reduced to about 8,000 triangles at their true size, with badges, antennas, wipers and interiors removed and their materials remapped; the wheels are reduced, fitted to one shared tire and center cap, and some wear a turned lip. Every car and wheel ships under a fictional name.'),
      ...trafficModels.credits.map((c) =>
        h('p', {}, 'Traffic: ', link(c.url, `"${c.title}"`), ' by ', link(c.creatorUrl, h('b', {}, c.creator)), ', ', link(c.licenseUrl, c.license), `. ${c.changes}.`),
      ),
      ...plantModels.credits.map((c) =>
        h('p', {}, 'Roadworks: ', link(c.url, `"${c.title}"`), ' by ', link(c.creatorUrl, h('b', {}, c.creator)), ', ', link(c.licenseUrl, c.license), `. ${c.changes}.`),
      ),
      h('p', {}, 'Icons: ', h('b', {}, 'Lucide'), ' (lucide.dev), ISC license.'),
      musicCredits(),
      h('p', {}, 'Crowd sound effects from ', h('b', {}, 'freesound_community'), ' (Pixabay): "applause" (freesound_community-applause-70507.mp3) and "crowd cheering" (freesound_community-crowd-cheering-6229.mp3), Pixabay Content License.'),
      h('p', { class: 'muted' }, 'The engine voices are synthesized in the browser after the pulse train model of ', h('b', {}, 'Engine Simulator'), ' by Ange Yaghi (github.com/ange-yaghi/engine-sim, MIT): every cylinder fires in its order and its pulse travels its own header before the pipe colors it.'),
      h('p', {}, 'Built with three.js, Vite and glTF Transform. City, signs and vinyls are generated procedurally. All shop and sponsor names are fictional.'),
    ),
    h('div', { class: 'settings__version' }, BUILD_VERSION),
  ];
}
