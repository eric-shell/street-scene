/**
 * What each Customize tab shows (Model, Stance, Wheels, Body, Paint, Tint,
 * Neon and Tune; Vinyls is garageVinyls.ts): the tab list, and one builder that
 * fills the body for the open tab from the build. The builders reach the screen
 * only through TabHost, so garageUi.ts keeps the steps, saving and dialogs and
 * this file only the controls. Edits write straight into the build and call
 * `changed`, which refits the car live; Save is the screen's.
 */
import { Link2, Link2Off } from 'lucide';
import { CarAssetLibrary, MANIFEST, manifestCar, partById, partsFor } from '../render/car/carAssets';
import { BODY_PART_SLOTS, OPTIONAL_SLOTS, PartSlot, SLOT_LABELS } from '../shared/parts';
import { AXLES, Axle, AxleStance, CHROME_COLOR, CarBuild, GLOW_PATTERNS, Paint, STANCE_LIMITS, TireShape, VinylShape, WHEEL_FINISHES, WheelFinish, WheelTrim, WheelTrimMode } from '../shared/carBuild';
import { SELECTABLE_CAR_IDS, SETUP_SLIDERS, getBaseTuning } from '../sim/tuning';
import { LAUNCH_RPM, defaultAntilagRpm, defaultLaunchRpm, maxLaunchRpm, tuningForBuild } from '../sim/build';
import { FEATURES } from '../shared/features';
import { specBadges } from '../shared/carSpec';
import { h, segmented, toast } from '../ui/kit/dom';
import { ArrowUpDown, Car, Disc3, Eye, Gauge, Hammer, Layers, Paintbrush, RotateCcw, Sparkles, IconNode } from '../ui/kit/icons';
import { GarageScene } from './garageScene';
import { GaragePrefs, saveGaragePrefs } from './storage';
import { capital, choiceList, cm, color, colorPicker, field, matchBody, paintPicker, percent, PRESETS, section, slider, statLines, toggle, type PaintMatch } from './garageWidgets';
import { renderVinyls } from './garageVinyls';
import { setupSlider } from './setupSliders';
import { wheelPicker } from './wheelPicker';
import type { WheelThumbs } from './wheelThumbs';

export type Tab = 'model' | 'stance' | 'wheels' | 'body' | 'paint' | 'vinyl' | 'tint' | 'neon' | 'tune';

export const TABS: { id: Tab; label: string; icon: IconNode }[] = [
  { id: 'model', label: 'Model', icon: Car },
  { id: 'stance', label: 'Stance', icon: ArrowUpDown },
  { id: 'wheels', label: 'Wheels', icon: Disc3 },
  { id: 'body', label: 'Body', icon: Hammer },
  { id: 'paint', label: 'Paint', icon: Paintbrush },
  ...(FEATURES.vinyls ? [{ id: 'vinyl' as Tab, label: 'Vinyls', icon: Layers }] : []),
  { id: 'tint', label: 'Tint', icon: Eye },
  { id: 'neon', label: 'Neon', icon: Sparkles },
  { id: 'tune', label: 'Tune', icon: Gauge },
];

/** Model author shown under a car's name, by manifest `source`. */
export const AUTHORS: Record<string, string | undefined> = { icemaan: 'IceMaan', eshell: 'eshell' };

/** The Wheels tab's views: the wheel itself, its size and tire, its paint and the calipers'. */
export type WheelView = 'wheel' | 'fit' | 'paint';
const WHEEL_VIEWS: { value: WheelView; label: string }[] = [
  { value: 'wheel', label: 'Wheel' },
  { value: 'fit', label: 'Size & tire' },
  { value: 'paint', label: 'Paint' },
];

/** The tire stretch as the Wheels tab lists it (TIRE_SHAPES' order, render/car/tireShapes.ts draws them): none is the standard tire, full the stretched one. */
const STRETCH_CHOICES: { value: TireShape; label: string }[] = [
  { value: 'standard', label: 'None' },
  { value: 'mild', label: 'Mild' },
  { value: 'stretched', label: 'Full' },
];

/**
 * What the tab builders need of the garage screen (garageUi.ts implements it): the build being edited
 * and the scene showing it, the body they fill, the tab state they read and set, and the two calls that
 * follow an edit (`changed` refits the car, `renderTab` rebuilds the open tab).
 */
export interface TabHost {
  readonly build: CarBuild;
  readonly scene: GarageScene;
  readonly assets: CarAssetLibrary;
  /** Which cars are imported, by id (a missing id counts as available). */
  readonly availability: Record<string, boolean>;
  readonly prefs: GaragePrefs;
  /** The open tab's pane, emptied and refilled by a render. */
  readonly body: HTMLElement;
  readonly tab: Tab;
  /** The Body tab's part slot on show. */
  bodySlot: PartSlot;
  /** The axle the Wheels tab's picks dress while front and rear are unlinked. */
  wheelAxle: Axle;
  /** The Wheels tab's view on show. */
  wheelView: WheelView;
  /** The wheel maker the Wheels tab's picker shows, or null for all of them. */
  wheelMaker: string | null;
  /** The wheel picker's thumbnails, drawn once per wheel. */
  readonly wheelThumbs: WheelThumbs;
  /** The vinyl layer picked in the Vinyls tab (-1 for none). */
  selectedDecal: number;
  /** The vinyl being placed or moved on the car (index -1 for a new layer), until the next click on the body. */
  placing: { shape: VinylShape; index: number } | null;
  changed(rerender?: boolean): Promise<unknown>;
  renderTab(): void;
  /** Frame the open tab's shot again (the Body tab's slot changed). */
  reframe(): void;
}

/** Fill the body with the open tab's groups, rebuilt from the build every time (a render empties it first). */
export function renderTabContent(host: TabHost): void {
  host.body.replaceChildren();
  const b = host.build;
  const v = b.visual;
  // Wheel size steps in whole inches once the wheel is measured; the build keeps the size factor, so the
  // slider converts both ways (the inches a factor gives depend on the car and the wheel model).
  const car = host.scene.car?.wheelsReady ? host.scene.car : null;
  const id = (x: number) => x;
  // Per axle sliders. While front and rear are linked (the Stance tab's link, or the Wheels tab's for wheel
  // size), moving one moves its partner too.
  const partners = new Map<string, { el: HTMLInputElement; out: HTMLElement; fmt: (x: number) => string; toUi: (x: number) => number }>();
  const axleSlider = (axle: Axle, key: keyof AxleStance, short = false, link = host.prefs.linkAxles) => {
    const L = STANCE_LIMITS[key];
    const spec = {
      rideHeight: { label: 'Ride height', min: L[0], max: L[1], step: 0.005, fmt: cm, toUi: id, fromUi: id },
      camber: { label: 'Camber', min: L[0], max: L[1], step: 0.5, fmt: (x: number) => `${x}°`, toUi: id, fromUi: id },
      offset: { label: 'Wheel offset', min: L[0], max: L[1], step: 0.005, fmt: cm, toUi: id, fromUi: id },
      wheelSize: car
        ? (() => {
            // Front and rear may wear different wheels, so each axle measures its own.
            const ax = axle === 'front' ? 0 : 1;
            const min = Math.ceil(car.wheelInches(L[0], ax) - 1e-6);
            const max = Math.floor(car.wheelInches(L[1], ax) + 1e-6);
            return { label: 'Wheel size', min, max, step: 1, fmt: (x: number) => `${x} in`, toUi: (x: number) => Math.max(min, Math.min(max, Math.round(car.wheelInches(x, ax)))), fromUi: (x: number) => car.wheelSizeForInches(x, ax) };
          })()
        : { label: 'Wheel size', min: L[0], max: L[1], step: 0.01, fmt: percent, toUi: id, fromUi: id },
      wheelWidth: { label: 'Wheel width', min: L[0], max: L[1], step: 0.01, fmt: percent, toUi: id, fromUi: id },
    }[key];
    const label = short ? spec.label : `${axle === 'front' ? 'Front' : 'Rear'}`;
    const el = slider(label, spec.toUi(v.stance[axle][key]), spec.min, spec.max, spec.step, spec.fmt, (ui) => {
      const x = spec.fromUi(ui);
      v.stance[axle][key] = x;
      if (link) {
        const other: Axle = axle === 'front' ? 'rear' : 'front';
        v.stance[other][key] = x;
        const p = partners.get(`${other}.${key}`);
        if (p) {
          p.el.value = String(p.toUi(x));
          p.out.textContent = p.fmt(p.toUi(x));
        }
      }
      host.changed();
    });
    partners.set(`${axle}.${key}`, { el: el.querySelector('input') as HTMLInputElement, out: el.querySelector('.garage-value') as HTMLElement, fmt: spec.fmt, toUi: spec.toUi });
    return el;
  };

  switch (host.tab) {
    case 'model': {
      // Only real, imported cars; a disabled tile at the end promises more.
      const imported = MANIFEST.cars.filter((c) => SELECTABLE_CAR_IDS.includes(c.id) && host.availability[c.id] !== false);
      const cars = imported.length ? imported : MANIFEST.cars.filter((c) => SELECTABLE_CAR_IDS.includes(c.id));
      const list = choiceList(
        cars.map((c) => ({ value: c.id, label: c.displayName, sub: AUTHORS[c.source], tags: specBadges(c.engine, getBaseTuning(c.id).drivetrain.layout) })),
        b.carId,
        (id) => {
          if (id === b.carId) return;
          // A launch or antilag rpm left on the old car's stock pick follows the new car's; one the player chose stays (applyBuild clamps it).
          if (b.performance.launchRpm === defaultLaunchRpm(b.carId)) b.performance.launchRpm = defaultLaunchRpm(id);
          if ((b.performance.antilagRpm ?? defaultAntilagRpm(b.carId)) === defaultAntilagRpm(b.carId)) b.performance.antilagRpm = defaultAntilagRpm(id);
          b.carId = id;
          // Parts are per car; wheels are universal and stay.
          const wheels = v.parts.wheels;
          v.parts = wheels ? { wheels } : {};
          v.decals = [];
          // Say hello: a short blip of the new car's engine (and the body rocks with it).
          void host.changed().then(() => host.scene.blip());
        },
      );
      const soon = h('div', { class: 'garage-item garage-item--soon', 'aria-disabled': 'true', title: 'More models coming soon' }, h('span', { class: 'garage-item__label' }, 'More models soon'), h('span', { class: 'garage-item__sub muted' }, 'Coming soon'));
      soon.addEventListener('click', () => toast('More cars are on the way', Car));
      list.append(soon);
      host.body.append(section('Model', list, h('div', { class: 'muted garage-note' }, 'A new car starts from its stock body; the wheels stay.')));
      break;
    }
    case 'body': {
      // One part slot at a time: the slots as a segmented pick (a dot on those with a part fitted), then its parts.
      const slots: PartSlot[] = ['body', ...BODY_PART_SLOTS];
      const slot = host.bodySlot;
      const parts = partsFor(b.carId, slot);
      const optional = OPTIONAL_SLOTS.includes(slot);
      const items: { value: string | null; label: string; sub?: string }[] = [{ value: null, label: optional ? 'None' : 'Stock' }, ...parts.map((p) => ({ value: p.id, label: p.displayName, sub: `${p.tris} tris` }))];
      const dev = [...host.assets.devParts.entries()].filter(([, d]) => d.slot === slot).map(([id, d]) => ({ value: id, label: d.name, sub: 'Dev preview' }));
      items.push(...dev);
      const pick = segmented(
        slots.map((s) => ({ value: s, label: `${SLOT_LABELS[s]}${v.parts[s] ? ' •' : ''}` })),
        slot,
        (s) => {
          host.bodySlot = s;
          host.reframe();
          host.renderTab();
        },
      );
      host.body.append(
        section('Part', pick),
        section(
          SLOT_LABELS[slot],
          items.length > 1
            ? choiceList(items, v.parts[slot] ?? null, (id) => {
                v.parts[slot] = id;
                void host.changed(true);
              })
            : h('div', { class: 'muted garage-note garage-note--empty' }, slot === 'body' ? 'Only the stock body for this car.' : 'No parts for this slot yet. See docs/partsAuthoring.md to add one.'),
        ),
      );
      break;
    }
    case 'paint': {
      host.body.append(
        section('Body paint', paintPicker(v.paint, PRESETS.body, () => host.changed())),
        section(
          'Trim color',
          color(v.trimColor, (c) => {
            v.trimColor = c;
            host.changed();
          }),
        ),
      );
      break;
    }
    case 'wheels': {
      const w = v.wheels;
      // One axle switch scopes the tab: linked, every pick equips all four (the rear copies the front);
      // unlinked, the Front / Rear switch says which pair the wheel, size, tire and paint picks dress.
      const linked = host.prefs.linkWheels;
      const rear = !linked && host.wheelAxle === 'rear';
      const axle: Axle = rear ? 'rear' : 'front';
      const front = v.parts.wheels ?? manifestCar(b.carId).defaultWheel;
      const title = (name: string) => (linked ? capital(name) : `${capital(axle)} ${name}`);
      // The tab shows one view at a time (the wheel, its fitment, its paint), like the Body tab's slots, so the
      // 44 wheels never push the size and paint out of reach.
      host.body.append(
        section(
          'Wheels',
          segmented(WHEEL_VIEWS, host.wheelView, (x) => {
            host.wheelView = x;
            host.renderTab();
          }),
          h(
            'div',
            { class: 'row' },
            wheelLinkToggle(host),
            linked
              ? h('span', { class: 'muted garage-note' }, 'Every pick equips all four wheels.')
              : segmented(
                  AXLES.map((a) => ({ value: a, label: capital(a) })),
                  host.wheelAxle,
                  (a) => {
                    host.wheelAxle = a;
                    host.renderTab();
                  },
                ),
          ),
        ),
      );
      if (host.wheelView === 'wheel') {
        host.body.append(
          section(
            title('wheel'),
            wheelPicker({
              wheels: partsFor(b.carId, 'wheels'),
              current: rear ? (w.rearPart ?? front) : front,
              maker: host.wheelMaker,
              thumbs: host.wheelThumbs,
              onMaker: (m) => {
                host.wheelMaker = m;
                host.renderTab();
              },
              onPick: (id) => {
                if (rear) w.rearPart = id;
                else {
                  // Linked, the rear follows the front; unlinked, it keeps the wheel it wore.
                  w.rearPart = linked ? null : (w.rearPart ?? front);
                  v.parts.wheels = id;
                }
                // Each wheel model has its own profile: the Fit view's inch range follows the new one when it opens.
                void host.changed();
              },
            }),
          ),
        );
      } else if (host.wheelView === 'fit') {
        host.body.append(
          section(title('size'), axleSlider(axle, 'wheelSize', true, linked), h('div', { class: 'muted garage-note' }, 'Bigger wheels, thinner sidewalls.')),
          // Width is always set per axle, linked or not (a staggered fitment is the point of it): linked, both sliders show.
          section(
            title('width'),
            ...(linked ? [axleSlider('front', 'wheelWidth', false, false), axleSlider('rear', 'wheelWidth', false, false)] : [axleSlider(axle, 'wheelWidth', true, false)]),
            h('div', { class: 'muted garage-note' }, 'Wider wheels grow inward; the face and spokes keep their shape.'),
          ),
          section(
            title('stretch'),
            segmented(STRETCH_CHOICES, rear ? w.rearTire : w.tire, (t) => {
              if (rear) w.rearTire = t;
              else {
                w.tire = t;
                if (linked) w.rearTire = t;
              }
              host.changed();
            }),
          ),
          // Per build, not per axle: the brand's raised lettering on every tire's outer sidewall.
          section(
            'Lettering',
            segmented(
              [
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On' },
              ],
              w.lettering ? 'on' : 'off',
              (x) => {
                w.lettering = x === 'on';
                host.changed();
              },
            ),
            h('div', { class: 'muted garage-note' }, 'Raised brand lettering on the outer sidewalls.'),
          ),
        );
      } else {
        // The paint and every trim offer chrome and Match body; a trim can also wear this axle's wheel paint (and
        // the lip as the wheel ships it, the lug nuts the center cap). The trims are per build, both axles.
        const paint = rear ? w.rearPaint : w.paint;
        const face = () => (paint.match ? v.paint : paint);
        const stockChrome = partById(rear ? (w.rearPart ?? front) : front)?.lip === 'chrome';
        const capWears = () => (w.cap.mode === 'body' ? v.paint : w.cap.mode === 'paint' ? w.cap : face());
        host.body.append(
          section(
            title('paint'),
            paintPicker(
              paint,
              PRESETS.wheels,
              () => {
                if (linked) w.rearPaint = { ...w.paint };
                host.changed();
              },
              { matches: [matchBody(paint, v.paint)], finishes: WHEEL_FINISHES },
            ),
          ),
          trimSection(host, 'Lip', w.lip, [
            trimMatch(w.lip, 'stock', 'Stock', 'Stock lip', () => (stockChrome ? { color: CHROME_COLOR, finish: 'chrome' } : face()), RotateCcw),
            trimMatch(w.lip, 'face', 'Match wheel', 'Wheel paint', face),
            trimMatch(w.lip, 'body', 'Match body', 'Body paint', () => v.paint),
          ]),
          trimSection(host, 'Center cap', w.cap, [trimMatch(w.cap, 'face', 'Match wheel', 'Wheel paint', face), trimMatch(w.cap, 'body', 'Match body', 'Body paint', () => v.paint)]),
          trimSection(host, 'Lug nuts', w.lugNuts, [
            trimMatch(w.lugNuts, 'cap', 'Match cap', 'Center cap', capWears),
            trimMatch(w.lugNuts, 'face', 'Match wheel', 'Wheel paint', face),
            trimMatch(w.lugNuts, 'body', 'Match body', 'Body paint', () => v.paint),
          ]),
          // One caliper paint for all four corners, whatever the axle switch says.
          section('Calipers', paintPicker(v.calipers, PRESETS.calipers, () => host.changed(), { matches: [matchBody(v.calipers, v.paint)] })),
        );
      }
      break;
    }
    case 'vinyl':
      renderVinyls(host);
      break;
    case 'stance': {
      host.body.append(
        section('Ride height', linkToggle(host), ...AXLES.map((a) => axleSlider(a, 'rideHeight')), h('div', { class: 'muted garage-note' }, 'Visual only. Front and rear apart rake the car.')),
        ...AXLES.map((a) => section(capital(a), ...(['camber', 'offset'] as const).map((k) => axleSlider(a, k, true)))),
      );
      break;
    }
    case 'tint': {
      host.body.append(
        section(
          'Window tint',
          slider('Darkness', v.tint.darkness, 0, 0.95, 0.01, percent, (x) => {
            v.tint.darkness = x;
            host.changed();
          }),
          field(
            'Tint color',
            color(v.tint.color, (c) => {
              v.tint.color = c;
              host.changed();
            }),
          ),
        ),
      );
      break;
    }
    case 'neon': {
      const g = v.underglow;
      host.body.append(
        section(
          'Underglow',
          field(
            'Lights',
            segmented(
              [
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On' },
              ],
              g.enabled ? 'on' : 'off',
              (x) => {
                g.enabled = x === 'on';
                host.changed();
              },
            ),
          ),
          segmented(
            GLOW_PATTERNS.map((p) => ({ value: p, label: capital(p) })),
            g.pattern,
            (p) => {
              g.pattern = p;
              g.enabled = true;
              host.changed();
            },
          ),
          h('div', { class: 'muted garage-note' }, 'Alternate and chase use both colors.'),
        ),
        section(
          'Colors',
          // A swatch re-renders so the Lights switch shows the glow it turned on; the well cannot (it would close mid drag).
          h('span', { class: 'garage-row__name' }, 'Primary'),
          colorPicker(g.color, PRESETS.glow, (c, preset) => {
            g.color = c;
            g.enabled = true;
            host.changed(preset);
          }),
          h('span', { class: 'garage-row__name' }, 'Secondary'),
          colorPicker(g.color2, PRESETS.glow, (c) => {
            g.color2 = c;
            host.changed();
          }),
        ),
        section(
          'Glow',
          slider('Brightness', g.brightness, 0.2, 2, 0.05, percent, (x) => {
            g.brightness = x;
            host.changed();
          }),
          slider('Speed', g.speed, 0.25, 3, 0.05, (x) => `${x.toFixed(2)}x`, (x) => {
            g.speed = x;
            host.changed();
          }),
          slider('Spread', g.size, 0.6, 1.6, 0.05, percent, (x) => {
            g.size = x;
            host.changed();
          }),
        ),
      );
      break;
    }
    case 'tune':
      renderPerformance(host);
      break;
  }
}

/** "Link front and rear" convenience toggle for the per axle sliders. */
function linkToggle(host: TabHost): HTMLElement {
  const linked = host.prefs.linkAxles;
  return toggle(
    linked ? Link2 : Link2Off,
    'Link',
    linked,
    linked ? 'Front and rear linked' : 'Front and rear separate',
    () => {
      host.prefs.linkAxles = !linked;
      saveGaragePrefs(host.prefs);
      if (host.prefs.linkAxles) {
        // Linking starts from matching axles: the rear takes the front's settings.
        const s = host.build.visual.stance;
        // Wheel width stays per axle: a staggered fitment survives the link.
        s.rear = { ...s.front, wheelWidth: s.rear.wheelWidth };
        host.changed();
        toast('Rear now matches front', Link2);
      }
      host.renderTab();
    },
  );
}

/** The Wheels tab's link: linked, front and rear wear the same wheel, size, tire and paint; unlinked, each axle picks its own. */
function wheelLinkToggle(host: TabHost): HTMLElement {
  const linked = host.prefs.linkWheels;
  return toggle(
    linked ? Link2 : Link2Off,
    'Link',
    linked,
    linked ? 'Front and rear wheels the same' : 'Front and rear wheels separate',
    () => {
      host.prefs.linkWheels = !linked;
      saveGaragePrefs(host.prefs);
      const w = host.build.visual.wheels;
      if (host.prefs.linkWheels) {
        // Linking starts from matching axles: the rear takes the front's wheel, size, tire and paint.
        w.rearPart = null;
        w.rearTire = w.tire;
        w.rearPaint = { ...w.paint };
        host.build.visual.stance.rear.wheelSize = host.build.visual.stance.front.wheelSize;
        void host.changed().then(() => host.tab === 'wheels' && host.renderTab());
        toast('Rear wheels now match front', Link2);
      } else host.wheelAxle = 'front';
      host.renderTab();
    },
  );
}

/** The Tune tab: the stat lines, launch control and the four setup sliders. */
function renderPerformance(host: TabHost): void {
  const b = host.build;
  // The build card's stat lines, so the stats and the setup fit the column together. A slider swaps them for
  // the new setup's in place: re-rendering the tab would take focus off the notch the keyboard or pad is on.
  let stats = statLines(b);
  host.body.append(section('Stats', stats));
  // Launch control: the rpm the two-step holds at the line while the throttle is down through the countdown,
  // and on a turbo car the rpm rolling antilag holds (its own limit, as on an ECU). Each slider's bottom step
  // is Off, then LAUNCH_RPM.min up to the car's redline less the cut's depth.
  const off = LAUNCH_RPM.min - LAUNCH_RPM.step;
  const t = tuningForBuild(b.carId, b.performance);
  const top = maxLaunchRpm(t);
  const rpmSlider = (label: string, value: number, stock: number, set: (x: number) => void, note: string) => [
    slider(label, value || off, off, top, LAUNCH_RPM.step, (x) => (x <= off ? 'Off' : x === stock ? `${x} rpm · stock` : `${x} rpm`), (x) => {
      set(x <= off ? 0 : x);
      host.changed(true);
    }),
    h('div', { class: 'muted garage-note' }, note),
  ];
  host.body.append(
    section(
      'Launch',
      ...rpmSlider('Launch RPM', b.performance.launchRpm, defaultLaunchRpm(b.carId), (x) => (b.performance.launchRpm = x), 'Two-step: hold the gas at the line and the revs wait here.'),
      ...(t.engine.turbo
        ? rpmSlider('Antilag RPM', b.performance.antilagRpm ?? defaultAntilagRpm(b.carId), defaultAntilagRpm(b.carId), (x) => (b.performance.antilagRpm = x), 'Hold Shift and the gas while rolling: revs held here, boost kept up.')
        : []),
    ),
  );
  // The setup: four sliders, each a trade (sim/build.ts applyBuild), position 3 the stock car.
  host.body.append(
    section(
      'Setup',
      ...SETUP_SLIDERS.map((s) =>
        setupSlider(s, b.performance[s], (p) => {
          b.performance[s] = p;
          const next = statLines(b);
          stats.replaceWith(next);
          stats = next;
          host.changed();
        }),
      ),
    ),
  );
  host.body.append(h('div', { class: 'muted garage-note' }, 'Position 3 on every slider is the stock car. Visual parts never change performance.'));
}

/** A wheel trim section (lip, center cap, lug nuts; render/car/lugNuts.ts draws the nuts): the wheel paint picker over the trim, with its matches. Both axles. */
function trimSection(host: TabHost, name: string, trim: WheelTrim, matches: PaintMatch[]): HTMLElement {
  return section(name, paintPicker(trim, PRESETS.wheels, () => host.changed(), { matches, finishes: WHEEL_FINISHES }), h('div', { class: 'muted garage-note' }, 'Both axles.'));
}

/** A trim's match: on, the trim wears `mode`'s paint; off, it takes that paint as its own, so nothing jumps. */
function trimMatch(trim: WheelTrim, mode: WheelTrimMode, label: string, name: string, wears: () => Paint<WheelFinish>, ico?: IconNode): PaintMatch {
  return {
    label,
    ico,
    wears: () => ({ name, paint: wears() }),
    on: () => trim.mode === mode,
    set: (on) => {
      if (on) {
        trim.mode = mode;
        return;
      }
      const p = wears();
      Object.assign(trim, { mode: 'paint', color: p.color, finish: p.finish });
    },
  };
}
