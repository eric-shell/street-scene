/**
 * The settings panel the main menu's settings step and the pause screen's
 * share, and the setting rows the menu's race step builds with it. Styled by
 * _settings.scss (the panel, its card on the menu's and pause rails) and
 * _setting-row.scss (rows, notes, the controls list).
 */
import { h, keyCaps, link, scrollHint, segmented, selectTab, tab } from '../kit/dom';
import { ChartColumn, CircleUser, Code, Gamepad2, Heart, Keyboard, Monitor, ShieldCheck, Smartphone, Volume2, type IconNode } from '../kit/icons';
import type { Quality, Settings } from '../settings';
import { MUSIC_CATALOG, type MusicPlayer } from '../../audio/musicPlayer';
import trafficModels from '../../assets/trafficModels.json';
import plantModels from '../../assets/plantModels.json';
import { BUILD_VERSION } from '../../version';
import { accountsEnabled } from '../../account/account';
import { accountPage } from './accountPage';
import { statsPage } from './statsPage';
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
 * Settings: a row of tabs (stats, account when the build has accounts, display, sound, controls, developer, privacy, credits) over
 * the open page, so nothing needs a long scroll and the panel fits the rail's
 * column; a page that still runs past the card (credits, controls) scrolls
 * inside it with the kit's fades and chevrons (scrollHint). Race options (rivals, difficulty, gearbox, traction control) live on
 * the menu's race step instead. Used on the menu's settings step and on the
 * pause screen's. It opens on `page` when given (the menu's Sign in opens Account), else the last page seen, else the first.
 */
export function settingsPanel(s: Settings, onChange: (s: Settings) => void, music?: MusicPlayer, page?: string): HTMLElement {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    s[k] = v;
    onChange(s);
  };
  const toggle = (k: 'retro' | 'radialBlur' | 'showFps' | 'flashEffects' | 'racingLine' | 'rumble' | 'debugMode') => onOff(s[k], (v) => set(k, v));
  const slider = (label: string, value: number, onInput: (v: number) => void) => {
    const r = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value, class: 'setting-row__slider', 'aria-label': label }) as HTMLInputElement;
    r.addEventListener('input', () => onInput(Number(r.value)));
    return r;
  };
  const all: (SettingsPage | false)[] = [
    // The player's numbers first: what they have earned and driven, and what there is to spend on parts.
    { id: 'stats', label: 'Stats', icon: ChartColumn, rows: statsPage },
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
          settingRow('Racing line', toggle('racingLine'), 'Brake red, hold white, gas green at the corners'),
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
  return h('div', { class: 'settings' }, h('nav', { class: 'tabs settings__tabs', role: 'tablist', 'aria-label': 'Settings pages' }, ...tabs), scrollHint(pane, 'settings__scroll'));
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
        [['W + S', 'Shift + W'], 'Line lock: burnout while standing (let go of Shift to launch)'],
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
        [['RT + LT', 'Left stick click + RT'], 'Line lock: burnout while standing'],
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
  { use: 'Wendt Strom R6', title: '2002_volkswagen_golf_r32_mk4', uid: '98e6828648084ae3b877ad69e8ad36dc', author: 'tangwang920' },
  { use: 'Kazama Rotor', title: 'Mazda RX7 FD 1999', uid: '06986b70c65b44c5a7315ed467b621a6', author: 'niev' },
  { use: 'Albrecht Kombi S', title: '1992 Audi S2 Avant', uid: '939dc6336dfe4fbd99fdb3608d58de56', author: 'tonielpro520' },
  { use: 'Dalton Fiend', title: 'Dodge Challenger SRT DEMON SDC', uid: '54d229c2c0ff4eac8bc872f50b25e36c', author: 'SDC PERFORMANCE' },
  { use: 'Nakaya Horizon GT', title: 'Nissan Skyline R33 GT-R', uid: '9107448c53f3452888f2ccf96acc3d3f', author: 'greddy295' },
  { use: 'Tachibana Zenith', title: 'Toyota Supra MK IV (1994)', uid: 'eb9bb1eb41db431cb078088ae1ce45f8', author: 'TinoD2' },
  { use: 'Tachibana Runabout', title: '1996 Toyota MR2 W20', uid: 'f66020ee62d741ebb0adc1ba351300db', author: 's0h1o9b' },
  { use: 'Nakaya Grove', title: 'Nissan Silvia 180sx [Free]', uid: 'eb3b4310304948ec8eaa4447080d2380', author: 'BlackSnow02' },
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
  { use: 'Gekko wheels', title: 'WORK LS CHIAREZZA SUV', uid: '3134884d8ecf45c9817cf5e1d231734b', author: 'jonver87' },
  { use: 'Nami wheels', title: 'Rotiform ZMO', uid: '4193e4cd0fdc481688e3a437e4e5d130', author: 'jonver87' },
  { use: 'Shizuku wheels', title: 'Rotiform Aerodisc', uid: 'ccaf76b4b4514d1e9b6351a628e75817', author: 'jonver87' },
  { use: 'Uzu wheels', title: 'Rotiform VCE', uid: '05783beda2a74aa8981fb374e9088b4f', author: 'jonver87' },
  { use: 'Kawa wheels', title: 'Rotiform SIX', uid: '35d0043f1c774ddfaa7c3983eb3bc8c0', author: 'jonver87' },
  { use: 'Taki wheels', title: 'Rotiform AVS', uid: 'cdb62e8166e64cf58fafed97348733b1', author: 'jonver87' },
  { use: 'Minato wheels', title: 'Rotiform KB1', uid: 'c6c9212941fd4a3182566141ea2caa10', author: 'jonver87' },
  { use: 'Kiri wheels', title: 'Rotiform USF', uid: 'af96ede3c79849e0967017c7af56e1c4', author: 'jonver87' },
  { use: 'Shio wheels', title: 'Rotiform MLW', uid: '7dbcd9ba45dc4ff3b53b2eb3822ec5bc', author: 'jonver87' },
  { use: 'Ame wheels', title: 'Rotiform OZR', uid: '72e5ee8f6e6b46799c00f732f414d41f', author: 'jonver87' },
  { use: 'Yuki wheels', title: 'Rotiform BM1', uid: 'abb6a1de9bd54492baff6843cad8a429', author: 'jonver87' },
  { use: 'Shigure wheels', title: 'Rotiform WRO', uid: 'd64d8d4fab944a77a6fba680551a7e67', author: 'jonver87' },
  { use: 'Umi wheels', title: 'Rotiform CCV', uid: '827bfe4138d447c28888c6c22a47609b', author: 'jonver87' },
  { use: 'Hyo wheels', title: 'Rotiform LHR', uid: '89a4f55b4d164153863a8f1350aa7786', author: 'jonver87' },
  { use: 'Tsuyu wheels', title: 'Rotiform LSR', uid: '1fe207f311bb4b50b0cf4d3fbbe549b2', author: 'jonver87' },
  { use: 'Kori wheels', title: 'Rotiform KLU', uid: '641a37e731194b3e8fdd18e6a9b1e6d9', author: 'jonver87' },
  { use: 'Mio wheels', title: 'Rotiform SNA', uid: '20dad53c5f1947cf92f113f3c2e7c2fe', author: 'jonver87' },
  { use: 'Fubuki wheels', title: 'Rotiform KPS', uid: 'c3ffecfad22d4a3a808123bac5187479', author: 'jonver87' },
  { use: 'Seseragi wheels', title: 'Rotiform PNT', uid: 'cee8b459137249e5bcfa8289d5c2759c', author: 'jonver87' },
  { use: 'Aoi wheels', title: '3D Vossen LC104T', uid: 'aa0f85f015d741a5958dc70fea79d863', author: 'jonver87' },
  { use: 'Sora wheels', title: 'Vossen LC109T', uid: '3fe9676878634ec183068252cb2d52fd', author: 'jonver87' },
  { use: 'Hikari wheels', title: 'Vossen VPS302', uid: 'ba0fafb1c9b545328948ad716a8b5747', author: 'jonver87' },
  { use: 'Kagami wheels', title: 'Vossen VPS301', uid: '4bfa99c33ba94cd08dfcf3cd53d1cd2d', author: 'jonver87' },
  { use: 'Seiun wheels', title: 'Vossen ERA3', uid: 'b5cffbf62f77419897de89413427d33d', author: 'jonver87' },
  { use: 'Getsuei wheels', title: 'Vossen GNS-1', uid: '7e9cf35d7dfd4ab083febc646a19746a', author: 'jonver87' },
  { use: 'Kirameki wheels', title: 'Vossen VPS 315T', uid: '9479e07055a14102ae8efb3b8658f9da', author: 'jonver87' },
  { use: 'Hisui wheels', title: 'Vossen CG203', uid: '38b5f76123a0461cb82b8616b734ac5f', author: 'jonver87' },
  { use: 'Tora wheels', title: 'HRE P200', uid: '7221bc7c423e401f83712d56e435a813', author: 'jonver87' },
  { use: 'Tsuchi wheels', title: 'Fifteen52 Rally Sport', uid: '1ed9ad4cbe5644ae831fe95bae84a0fc', author: 'jonver87' },
  { use: 'Homura wheels', title: 'SSR Koenig', uid: '391ab57dc25a4aa69771fbb9114f3d40', author: 'jonver87' },
  { use: 'Hane wheels', title: 'BBS E52', uid: '8168cc3dce114b19b617c17fea0ab364', author: 'jonver87' },
  { use: 'Iwa wheels', title: 'Volk Rays 21C', uid: 'd053af8f24bc4a5dbaf9d21f31ae25da', author: 'jonver87' },
  { use: 'Kiseki wheels', title: 'Enkei Nt03+m Wheels', uid: '6d31c56557b945a5abd4015884461dc4', author: 'flathat3d' },
  { use: 'Hien wheels', title: 'BBS CH-R + Goodyear Eagle F1 Supercar 3', uid: '2acc32fc79684a2c8b7df9faaa5a5c35', author: 'MozzarellaARC' },
  { use: 'Akatsuki wheels', title: 'HRE TUSK', uid: '31734356b1b14312ad5c11f24c78fd57', author: 'jonver87' },
  { use: 'Ayame wheels', title: 'Advan A3A', uid: '502e2341d5c74cb9a312af876697523e', author: 'jonver87' },
  { use: 'Botan wheels', title: 'Velare VLR F1', uid: 'db3568387f4b43d1988f73874f43e90f', author: 'jonver87' },
  { use: 'Chidori wheels', title: 'Rotiform WRG', uid: '4bb6ed6ac0e246569b18e5c8929ffd7e', author: 'jonver87' },
  { use: 'Daichi wheels', title: 'Rotiform IHR', uid: '03027fcac92a476aba1a55c1cb148595', author: 'jonver87' },
  { use: 'Enishi wheels', title: 'Kyusha Shoes Meteor FF', uid: '79d3c95516dc4e3693ce0e1fcdaf7909', author: 'jonver87' },
  { use: 'Fuyu wheels', title: 'Brixton Forged TR06', uid: 'fb3ed2107cf949cba4922a8af22635fb', author: 'jonver87' },
  { use: 'Genki wheels', title: 'Avant Garde F450', uid: 'aaf0fb4891cd474e86df0eb2dc322e48', author: 'jonver87' },
  { use: 'Haruka wheels', title: 'Avant Garde F142', uid: '0c5a53690d0d40adadf3ddaf0828c8b6', author: 'jonver87' },
  { use: 'Hasu wheels', title: 'HRE FF04', uid: 'b0d7579597a542978a00cf19ec3c9d29', author: 'jonver87' },
  { use: 'Ibuki wheels', title: 'Brixton Forged VL7', uid: '051fba725036489288a0ed6ded9a4abe', author: 'jonver87' },
  { use: 'Kaen wheels', title: 'Brixton Forged PF6', uid: '60d3005ced7f42fa9100b0aa03979269', author: 'jonver87' },
  { use: 'Kanade wheels', title: 'HRE 522M', uid: '17dfb9313e3346d59021dbcca0142762', author: 'jonver87' },
  { use: 'Karasu wheels', title: 'Vossen VFS4', uid: '2a078ce1d2b3463cab9bc3179432bf1c', author: 'jonver87' },
  { use: 'Madoka wheels', title: 'Vossen LC106', uid: 'bb90d9eb6f9c4bdc8fdc8340cfa693b6', author: 'jonver87' },
  { use: 'Mizore wheels', title: 'Vossen LC108T', uid: '124076f7e61f43109c78f329bbb4ee8b', author: 'jonver87' },
  { use: 'Momiji wheels', title: 'Vossen-x-Work VWS3', uid: 'bff5b9a09f0f42febac5fba5c2f2860c', author: 'jonver87' },
  { use: 'Nagi wheels', title: 'Vossen VPS 310T', uid: '2128c0d05b98416c9de4f3eccf2605aa', author: 'jonver87' },
  { use: 'Natsu wheels', title: 'Rotiform HVN', uid: 'c89560b091cf49e9b2cc4f0f38074d40', author: 'jonver87' },
  { use: 'Nokaze wheels', title: 'Rotiform SEA', uid: '6dd27000a1cf433490be246b67868022', author: 'jonver87' },
  { use: 'Ogi wheels', title: 'Rotiform RSC', uid: '3be8e6543dc34551b71666f4c0d262a5', author: 'jonver87' },
  { use: 'Rin wheels', title: 'Vossen CG207', uid: '91a910d8ccb944e78b036ca01a2c4eba', author: 'jonver87' },
  { use: 'Sakura wheels', title: 'Rotiform EMA', uid: '403b46a5f85a4ddfbff2de8eb1f7742e', author: 'jonver87' },
  { use: 'Sango wheels', title: 'VIP MODULAR VXS410', uid: 'b97b8008fd614027864e59b6921d7919', author: 'jonver87' },
  { use: 'Sazanami wheels', title: 'VIP MODULAR VX510', uid: '0079270fb2ed4635a276a945258d0cf1', author: 'jonver87' },
  { use: 'Shirube wheels', title: 'Brixton Forged CM16', uid: 'c47c0b869f5f48f9bb5d629c8fbf3bcb', author: 'jonver87' },
  { use: 'Sumire wheels', title: 'Vossen VFS2', uid: '671ea5f9079e4826a484e797f0b267b6', author: 'jonver87' },
  { use: 'Suzume wheels', title: 'VOLK TE37SL 3spoke', uid: '1b03d5aa04bf404baa482de0f0ecec32', author: 'jonver87' },
  { use: 'Tamashii wheels', title: 'RAYS TE037', uid: 'e4ca99c55cec42b5940107b5c5ead0f6', author: 'dermaks' },
  { use: 'Tomoe wheels', title: 'Volk Rays 21A', uid: 'd7c193d9873d4ab0b4df611fdb76a481', author: 'jonver87' },
  { use: 'Tsubaki wheels', title: 'VIP Modular VXS610', uid: '9960a18aee194a1680f9d72455115a17', author: 'jonver87' },
  { use: 'Tsutsuji wheels', title: 'Enkei Riverge', uid: 'e6a0a56973f54bcbad02188ae6fe70f9', author: 'jonver87' },
  { use: 'Ukigumo wheels', title: 'VOSSEN VFS1', uid: 'b5ecbbe9ce254c20941d9db6dc3be57b', author: 'jonver87' },
  { use: 'Usagi wheels', title: 'Vossen HC-1', uid: 'a09cf8de7a8940fa9733c46198a46fd1', author: 'jonver87' },
  { use: 'Wakaba wheels', title: 'fifteen52 Turbomac', uid: '0dbadec625c249eea309d95eb015c9f4', author: 'portfoliorodrigues' },
  { use: 'Yamabuki wheels', title: 'Work Meister S1 3P', uid: '7205c04f3cb24a7dbdaf6a304fb31f21', author: 'alexanderlyreo' },
  { use: 'Yoake wheels', title: 'WORK MEISTER CR01', uid: '9b2bb4a769de4c6098efe95001072841', author: 'dermaks' },
  { use: 'Yuzu wheels', title: 'SSR Minerva', uid: '704b405602b74a788a0678fd39ac4e51', author: 'dermaks' },
  { use: 'Zan wheels', title: 'RAYS nismo LMGT1', uid: '6ed19c4728744e0b95246b5e125ea286', author: 'dermaks' },
  { use: 'Nadeshiko wheels', title: 'SSR COLLECTION', uid: '8d2a195f7da443faa3de85b5a4708772', author: 'dermaks' },
  { use: 'Tsukushi wheels', title: 'SSR COLLECTION', uid: '8d2a195f7da443faa3de85b5a4708772', author: 'dermaks' },
  { use: 'Koyomi wheels', title: 'SSR COLLECTION', uid: '8d2a195f7da443faa3de85b5a4708772', author: 'dermaks' },
  { use: 'Hotaka wheels', title: 'SSR Longchamp XR4', uid: '6b3cc8dc828b4e319d625ef3318a26ff', author: 'dermaks' },
  { use: 'Sagi wheels', title: 'Budnik Tusk', uid: 'ab0c4c881d2d41f8a479273e81491978', author: 'dermaks' },
  { use: 'Uguisu wheels', title: 'Weds Kranze Bazreia', uid: '9f55befda4a64aeea5d6fc3586e055ae', author: 'dermaks' },
  { use: 'Yuhi wheels', title: 'BRABUS MONOBLOCK M', uid: 'a27f7cb1c38240869275ed5319573826', author: 'dermaks' },
  { use: 'Asagi wheels', title: 'Devil Japan IF', uid: '38821fe2a6b4417ab96e2f3948b65537', author: 'dermaks' },
  { use: 'Kasane wheels', title: 'WORK Equip 05', uid: 'ea0c0c37faa0465ca38d1a3365fb9dfe', author: 'dermaks' },
  { use: 'Sazanka wheels', title: 'KANSEI TANDEM', uid: '4d467ea742e94f6aa9ffa8f7f1a0a913', author: 'dermaks' },
  { use: 'Mikazuki wheels', title: 'O.Z MAE', uid: '75f3ef08221849e2ac3a17dd2ecf2386', author: 'dermaks' },
  { use: 'Inazuma wheels', title: 'WORK EMOTION T5R 2P', uid: '38c31e5755494f7fa5e53fdbc95fa313', author: 'dermaks' },
  { use: 'Hanabi wheels', title: 'SSR Starshark', uid: '58970916a3be46a48d61de853149a22a', author: 'dermaks' },
  { use: 'Minamo wheels', title: 'MAE CROWN JEWEL', uid: '2c77da7f41df431aa1db7b7c2afa92ca', author: 'dermaks' },
  { use: 'Kawasemi wheels', title: 'Spoon SW388 (Low&High Poly)', uid: '069b86d4b4a2492e92eb3349805479f9', author: 'TinoD2' },
  { use: 'Kazakiri wheels', title: 'Racing Wheel - Work Emotion CR-KAI', uid: '3025fa1677784df99abcf1cd2a30c5fa', author: 'gordeykomark' },
  { use: 'Tatsumaki wheels', title: 'Rotiform DAB', uid: '48ff08bbf17b43b4abbc2ee9113be954', author: 'blakebella' },
  { use: 'Kogane wheels', title: '[FREE] BBS LM Gold Wheels - Low poly', uid: '3aac505aa9484d088204fabef6a8a4c2', author: 'zxargon' },
  { use: 'Namida wheels', title: 'S13 Teardrops Rims', uid: 'f8fe25efca84448994f449ef9d894d54', author: 'Once_a_goat_death' },
  { use: 'Akane wheels', title: 'SSR Hasemi Prot-S', uid: '581e5099da7a4620b11c3fc424c507de', author: 'techtackofficial' },
  { use: 'Tsukimi wheels', title: 'Rotiform CVT', uid: 'ed962ed287cf4430a5af531accef5221', author: 'niev' },
  { use: 'Himawari wheels', title: 'WEDS Kranze LXZ [Mid-Poly]', uid: '2eef2cea9a634c2fbe5dc187d67ba747', author: 'blakebella' },
  { use: 'Hibiki wheels', title: 'RAYS GramLights 57DR', uid: '71a90d6c2d0a444d9d2ca7e3cf715c76', author: 'ilvskf' },
  { use: 'Kaminari wheels', title: 'Rays Gramlights 57CR', uid: '47063c38bdaa46ebaf2d2af2079c7118', author: 'ilvskf' },
  { use: 'Fuuga wheels', title: 'RAYS G025', uid: '8b14891bb44b43729d07f1e4e2744488', author: 'ilvskf' },
  { use: 'Hinoko wheels', title: 'RAYS HOMURA 2x7', uid: 'f2da4e9b0d04418aa1b53022d692ea6b', author: 'ilvskf' },
  { use: 'Shirabe wheels', title: 'Konig Countergram 5x120 Wheel / FREE MODEL', uid: 'c3bffbcaafbe4f5388f14feed6b38cca', author: 'shevchenkovisuals' },
  { use: 'Asahi wheels', title: 'Enkie Rpf1', uid: '43182083d4134e918a81f115905d5483', author: 'astrubal' },
];

/** One credit in a credits group: what it is in the game, beside the work (linked) over its author and licence. */
function credit(use: string, work: HTMLElement | string, ...meta: (Node | string)[]): HTMLElement[] {
  return [h('span', { class: 'settings__credit-use' }, use), h('div', { class: 'settings__credit-work' }, work, h('div', { class: 'settings__credit-meta' }, ...meta))];
}

/** "by Author · Licence", each linked when it has a page. */
function byLine(author: Node | string, licence: Node | string, ...more: (Node | string)[]): (Node | string)[] {
  return ['by ', author, ...more.flatMap((m) => [' · ', m]), ' · ', licence];
}

/** A titled group of credits, with an optional note on what was changed under it. */
function creditGroup(title: string, rows: HTMLElement[], note?: string): HTMLElement {
  return h(
    'section',
    { class: 'settings__credit-group' },
    h('div', { class: 'section-title' }, title),
    rows.length ? h('div', { class: 'settings__credit-list' }, ...rows) : null,
    note ? h('p', { class: 'settings__credit-note' }, note) : null,
  );
}

/** The credits page of the settings, with the build version at the foot: each kind of borrowed work in its own
 * group, one credit a row (the in-game name beside the linked work, its author and licence under it), so the
 * attributions CC BY asks for scan as a list rather than a wall of sentences. */
function credits(): HTMLElement[] {
  const donor = (c: (typeof DONOR_CREDITS)[number]) =>
    credit(c.use.replace(/ wheels$/, ''), link(`https://sketchfab.com/3d-models/${c.uid}`, c.title), ...byLine(link(`https://sketchfab.com/${c.author}`, c.author), link(CC_BY, 'CC BY 4.0')));
  const model = (use: string, c: { title: string; url: string; creator: string; creatorUrl: string; license: string; licenseUrl: string; changes: string }) =>
    credit(use, link(c.url, c.title), ...byLine(link(c.creatorUrl, c.creator), link(c.licenseUrl, c.license)), h('div', { class: 'settings__credit-change' }, `${c.changes}.`));
  const albums = MUSIC_CATALOG.artists.flatMap((artist) =>
    artist.albums.flatMap((album) =>
      credit(
        `${album.tracks.length} tracks`,
        link(album.url, album.title),
        ...byLine(link(artist.url, artist.name), link(album.licenseUrl, album.license), link(album.sourceUrl, album.source)),
        h('details', {}, h('summary', {}, 'Track list'), h('ol', { class: 'settings__credit-tracks' }, ...album.tracks.map((t) => h('li', { value: t.number }, link(t.url, t.title))))),
      ),
    ),
  );
  const pixabay = 'Pixabay Content License';
  return [
    h(
      'div',
      { class: 'settings__credits' },
      creditGroup('Cars', DONOR_CREDITS.filter((c) => !c.use.endsWith(' wheels')).flatMap(donor), 'Reduced to about 8,000 triangles at their true size, with badges, antennas, wipers and interiors removed and their materials remapped. Every car ships under a fictional name.'),
      creditGroup('Wheels', DONOR_CREDITS.filter((c) => c.use.endsWith(' wheels')).flatMap(donor), 'Reduced and fitted to one shared tire and center cap; some wear a turned lip. Every wheel ships under a fictional name.'),
      creditGroup('City', [...trafficModels.credits.flatMap((c) => model('Traffic', c)), ...plantModels.credits.flatMap((c) => model('Roadworks', c))]),
      creditGroup('Music', albums, 'Transcoded to 128 kbps and loudness normalized; otherwise unmodified.'),
      creditGroup('Sound', [
        ...credit('Crowd', '"applause", "crowd cheering"', 'by ', h('b', {}, 'freesound_community'), ' (Pixabay) · ', pixabay),
        ...credit('Camera', '"camera shutter"', 'by ', h('b', {}, 'freesound_community'), ' (Pixabay) · ', pixabay),
        ...credit('Engines', link('https://github.com/ange-yaghi/engine-sim', 'Engine Simulator'), 'pulse train model by ', h('b', {}, 'Ange Yaghi'), ' · MIT'),
      ], 'The engine voices are synthesized in the browser: every cylinder fires in its order and its pulse travels its own header before the pipe colors it.'),
      creditGroup('Built with', [
        ...credit('Engine', 'three.js, Vite, glTF Transform'),
        ...credit('Icons', link('https://lucide.dev', 'Lucide'), 'ISC license'),
      ], 'City, signs and vinyls are generated procedurally. All shop and sponsor names are fictional.'),
    ),
    h('div', { class: 'settings__version' }, BUILD_VERSION),
  ];
}
