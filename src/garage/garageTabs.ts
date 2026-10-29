/**
 * What each Customize tab shows (Model, Stance, Wheels, Paint, Tune, Body and
 * Style; Vinyls is garageVinyls.ts): the tab list, and one builder that fills
 * the body for the open tab from the build. The builders reach the screen only
 * through TabHost, so garageUi.ts keeps the steps, saving and dialogs and this
 * file only the controls. Edits write straight into the build and call
 * `changed`, which refits the car live; Save is the screen's.
 */
import { Link2, Link2Off } from 'lucide';
import { CarAssetLibrary, MANIFEST, manifestCar, partById, partsFor } from '../render/car/carAssets';
import { BODY_PART_SLOTS, OPTIONAL_SLOTS, PartSlot, SLOT_LABELS } from '../shared/parts';
import { ACCENT_FINISHES, AXLES, AccentFinish, Axle, AxleStance, CHROME_COLOR, CarBuild, GLOW_PATTERNS, PAINT_FINISHES, Paint, STANCE_LIMITS, TireShape, VinylShape, WheelTrim, WheelTrimMode } from '../shared/carBuild';
import { SELECTABLE_CAR_IDS, SETUP_SLIDERS, getBaseTuning } from '../sim/tuning';
import { LAUNCH_RPM, defaultAntilagRpm, defaultLaunchRpm, maxLaunchRpm, tuningForBuild } from '../sim/build';
import { FEATURES } from '../shared/features';
import { specBadges } from '../shared/carSpec';
import { cycler, h, onOffSwitch, segmented, toast } from '../ui/kit/dom';
import { ArrowUpDown, Car, Disc3, Gauge, Hammer, Layers, Moon, Paintbrush, RotateCcw, IconNode } from '../ui/kit/icons';
import { GarageScene } from './garageScene';
import { GaragePrefs, saveGaragePrefs } from './storage';
import { capital, choiceList, cm, colorPicker, field, matchBody, mm, note, paintPicker, percent, rowName, section, slider, statLines, toggle, type PaintMatch } from './garageWidgets';
import { renderVinyls } from './garageVinyls';
import { setupSlider } from './setupSliders';
import { wheelPicker } from './wheelPicker';
import type { WheelThumbs } from './wheelThumbs';

export type Tab = 'model' | 'stance' | 'wheels' | 'paint' | 'vinyl' | 'tune' | 'body' | 'style';

/** The tabs in order: the car and how it sits first, then its look, its setup, its parts, and the Style tab's night look last. */
export const TABS: { id: Tab; label: string; icon: IconNode }[] = [
  { id: 'model', label: 'Model', icon: Car },
  { id: 'stance', label: 'Stance', icon: ArrowUpDown },
  { id: 'wheels', label: 'Wheels', icon: Disc3 },
  { id: 'paint', label: 'Paint', icon: Paintbrush },
  ...(FEATURES.vinyls ? [{ id: 'vinyl' as Tab, label: 'Vinyls', icon: Layers }] : []),
  { id: 'tune', label: 'Tune', icon: Gauge },
  { id: 'body', label: 'Body', icon: Hammer },
  { id: 'style', label: 'Style', icon: Moon },
];

/** Model author shown under a car's name, by manifest `source`. */
export const AUTHORS: Record<string, string | undefined> = { icemaan: 'IceMaan', eshell: 'eshell' };

/**
 * The Paint tab's surfaces, one on show at a time (like the Body tab's slots): the body, the wheels (the
 * face, the lip and the center cap), the hardware (the lug nuts and the bolts) and the calipers.
 */
export const PAINT_SURFACES = ['body', 'wheels', 'hardware', 'calipers'] as const;
export type PaintSurface = (typeof PAINT_SURFACES)[number];
const SURFACE_LABELS: Record<PaintSurface, string> = { body: 'Body', wheels: 'Wheels', hardware: 'Hardware', calipers: 'Calipers' };

/** The tire stretch as the Stance tab lists it (TIRE_SHAPES' order, render/car/tireShapes.ts draws them): none is the standard tire, full the stretched one. */
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
  /** The Paint tab's surface on show. */
  paintSurface: PaintSurface;
  /** The axle the Wheels tab's wheel and the Paint tab's wheel paint dress while front and rear are unlinked. */
  wheelAxle: Axle;
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
  /** Frame the open tab's shot again (the Body tab's slot or the Paint tab's surface changed). */
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
  // Per axle sliders. While front and rear are linked (the Stance tab's link), moving one moves its partner too.
  const partners = new Map<string, { el: HTMLInputElement; out: HTMLElement; fmt: (x: number) => string; toUi: (x: number) => number }>();
  const axleSlider = (axle: Axle, key: keyof AxleStance, link = host.prefs.linkAxles) => {
    const L = STANCE_LIMITS[key];
    const spec = {
      rideHeight: { min: L[0], max: L[1], step: 0.005, fmt: cm, toUi: id, fromUi: id },
      camber: { min: L[0], max: L[1], step: 0.5, fmt: (x: number) => `${x}°`, toUi: id, fromUi: id },
      // The track offset in whole mm, as a tuner reads an offset (the user, 2026-10-28).
      offset: { min: L[0], max: L[1], step: 0.001, fmt: mm, toUi: id, fromUi: id },
      wheelSize: car
        ? (() => {
            // Front and rear may wear different wheels, so each axle measures its own.
            const ax = axle === 'front' ? 0 : 1;
            const min = Math.ceil(car.wheelInches(L[0], ax) - 1e-6);
            const max = Math.floor(car.wheelInches(L[1], ax) + 1e-6);
            return { min, max, step: 1, fmt: (x: number) => `${x} in`, toUi: (x: number) => Math.max(min, Math.min(max, Math.round(car.wheelInches(x, ax)))), fromUi: (x: number) => car.wheelSizeForInches(x, ax) };
          })()
        : { min: L[0], max: L[1], step: 0.01, fmt: percent, toUi: id, fromUi: id },
      // Wheel width in half inches once the wheel is measured (the lip's edge to the barrel's back on this car),
      // the same way as the size: the build keeps the width factor and the slider converts both ways.
      wheelWidth: car
        ? (() => {
            const ax = axle === 'front' ? 0 : 1;
            const min = Math.ceil(car.wheelWidthInches(L[0], ax) * 2 - 1e-6) / 2;
            const max = Math.floor(car.wheelWidthInches(L[1], ax) * 2 + 1e-6) / 2;
            return { min, max, step: 0.5, fmt: (x: number) => `${x} in`, toUi: (x: number) => Math.max(min, Math.min(max, Math.round(car.wheelWidthInches(x, ax) * 2) / 2)), fromUi: (x: number) => car.wheelWidthForInches(x, ax) };
          })()
        : { min: L[0], max: L[1], step: 0.01, fmt: percent, toUi: id, fromUi: id },
    }[key];
    const el = slider(capital(axle), spec.toUi(v.stance[axle][key]), spec.min, spec.max, spec.step, spec.fmt, (ui) => {
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
      host.body.append(section('Model', list, note('A new car starts from its stock body; the wheels stay.')));
      break;
    }
    case 'stance': {
      // Everything about how the car sits on its wheels, front and rear side by side: the body's height and
      // the wheels' angle, track, size, width and tire. One link moves both axles together.
      const w = v.wheels;
      const linked = host.prefs.linkAxles;
      // Linked, one stretch sets both tires; unlinked, each axle picks its own.
      const stretchPick = (axle: Axle | null) =>
        cycler(STRETCH_CHOICES, axle === 'rear' ? w.rearTire : w.tire, (t) => {
          if (axle !== 'rear') w.tire = t;
          if (axle !== 'front') w.rearTire = t;
          host.changed();
        });
      host.body.append(
        section('Ride height', linkToggle(host), ...AXLES.map((a) => axleSlider(a, 'rideHeight')), note('Visual only. Front and rear apart rake the car.')),
        section('Camber', ...AXLES.map((a) => axleSlider(a, 'camber'))),
        section('Wheel offset', ...AXLES.map((a) => axleSlider(a, 'offset'))),
        section('Wheel size', ...AXLES.map((a) => axleSlider(a, 'wheelSize')), note('Bigger wheels, thinner sidewalls.')),
        // Width is always set per axle, linked or not: a staggered fitment is the point of it.
        section('Wheel width', ...AXLES.map((a) => axleSlider(a, 'wheelWidth', false)), note('Wider wheels grow inward; the face and spokes keep their shape. Never linked.')),
        section(
          'Tires',
          ...(linked ? [field('Stretch', stretchPick(null))] : AXLES.map((a) => field(`${capital(a)} stretch`, stretchPick(a)))),
          // Per build, not per axle: the brand's raised lettering on every tire's outer sidewall.
          field(
            'Lettering',
            onOffSwitch(w.lettering, (on) => {
              w.lettering = on;
              host.changed();
            }, 'Tire lettering'),
          ),
          note('Raised brand lettering on the outer sidewalls.'),
        ),
      );
      break;
    }
    case 'wheels': {
      const w = v.wheels;
      // Linked, a pick equips all four (the rear copies the front); unlinked, the Front / Rear switch says
      // which pair the pick dresses.
      const linked = host.prefs.linkWheels;
      const rear = !linked && host.wheelAxle === 'rear';
      const front = v.parts.wheels ?? manifestCar(b.carId).defaultWheel;
      // The picker fills the tab (the section grows to the body's height) with its own scrolling panes.
      const group = section(
        linked ? 'Wheel' : `${capital(host.wheelAxle)} wheel`,
        h('div', { class: 'row' }, ...wheelAxleTools(host), linked ? h('span', { class: 'muted garage-note' }, 'Every pick equips all four wheels.') : null),
        wheelPicker({
          wheels: partsFor(b.carId, 'wheels'),
          current: rear ? (w.rearPart ?? front) : front,
          maker: host.wheelMaker,
          thumbs: host.wheelThumbs,
          target: manifestCar(b.carId).targetOffset?.front,
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
            void host.changed();
          },
        }),
      );
      group.classList.add('garage-section--fill');
      host.body.append(group);
      break;
    }
    case 'paint': {
      // One surface at a time, like the Body tab's slots: the surfaces on a cycler, then its paint.
      const surface = host.paintSurface;
      host.body.append(
        section(
          'Surface',
          cycler(
            PAINT_SURFACES.map((s) => ({ value: s, label: SURFACE_LABELS[s] })),
            surface,
            (s) => {
              host.paintSurface = s;
              host.reframe();
              rerenderFromPicker(host);
            },
          ),
        ),
      );
      const w = v.wheels;
      // The wheel paints and trims: the face is per axle (the Link and Front / Rear say which), the trims (lip, cap,
      // lug nuts, hardware) are per build, both axles, each wearing its own paint or another surface's (the axle on
      // show's face, the cap, the body, the lip as the wheel ships it).
      const linked = host.prefs.linkWheels;
      const rear = !linked && host.wheelAxle === 'rear';
      const paint = rear ? w.rearPaint : w.paint;
      const wheelId = rear ? (w.rearPart ?? v.parts.wheels ?? manifestCar(b.carId).defaultWheel) : (v.parts.wheels ?? manifestCar(b.carId).defaultWheel);
      const face = (): Paint<AccentFinish> => (paint.match ? v.paint : paint);
      const stockChrome = partById(wheelId)?.lip === 'chrome';
      const capWears = (): Paint<AccentFinish> => (w.cap.mode === 'body' ? v.paint : w.cap.mode === 'paint' ? w.cap : face());
      const body = (): Paint<AccentFinish> => v.paint;
      switch (surface) {
        case 'body':
          // The body alone takes no chrome.
          host.body.append(section('Body paint', paintPicker(v.paint, PAINT_FINISHES, () => host.changed())));
          break;
        case 'wheels':
          host.body.append(
            section(
              linked ? 'Wheel paint' : `${capital(host.wheelAxle)} wheel paint`,
              h('div', { class: 'row' }, ...wheelAxleTools(host)),
              paintPicker(
                paint,
                ACCENT_FINISHES,
                () => {
                  if (linked) w.rearPaint = { ...w.paint };
                  host.changed();
                },
                [matchBody(paint, v.paint)],
              ),
            ),
            trimSection(host, 'Lip', w.lip, [
              trimMatch(w.lip, 'stock', 'Stock', 'Stock lip', () => (stockChrome ? { color: CHROME_COLOR, finish: 'chrome' } : face()), RotateCcw),
              trimMatch(w.lip, 'face', 'Match wheel', 'Wheel paint', face),
              trimMatch(w.lip, 'body', 'Match body', 'Body paint', body),
            ]),
            trimSection(host, 'Center cap', w.cap, [trimMatch(w.cap, 'face', 'Match wheel', 'Wheel paint', face), trimMatch(w.cap, 'body', 'Match body', 'Body paint', body)]),
          );
          break;
        case 'hardware':
          host.body.append(
            trimSection(host, 'Lug nuts', w.lugNuts, [
              trimMatch(w.lugNuts, 'cap', 'Match cap', 'Center cap', capWears),
              trimMatch(w.lugNuts, 'face', 'Match wheel', 'Wheel paint', face),
              trimMatch(w.lugNuts, 'body', 'Match body', 'Body paint', body),
            ]),
            // The bolt hardware shows for a wheel model that draws any.
            ...(hasHardware(wheelId)
              ? [
                  trimSection(host, 'Bolts', w.hardware, [
                    trimMatch(w.hardware, 'cap', 'Match cap', 'Center cap', capWears),
                    trimMatch(w.hardware, 'face', 'Match wheel', 'Wheel paint', face),
                    trimMatch(w.hardware, 'body', 'Match body', 'Body paint', body),
                  ]),
                ]
              : []),
          );
          break;
        case 'calipers':
          // One caliper paint for all four corners, whatever the axle switch says.
          host.body.append(section('Calipers', paintPicker(v.calipers, ACCENT_FINISHES, () => host.changed(), [matchBody(v.calipers, v.paint)]), note('One paint for all four corners.')));
          break;
      }
      break;
    }
    case 'vinyl':
      renderVinyls(host);
      break;
    case 'style': {
      // The Style tab's night look, shown with the room's lights down: the glass, then the underglow.
      const g = v.underglow;
      host.body.append(
        section(
          'Window tint',
          slider('Darkness', v.tint.darkness, 0, 0.95, 0.01, percent, (x) => {
            v.tint.darkness = x;
            host.changed();
          }),
          rowName('Tint color'),
          colorPicker(v.tint.color, (c) => {
            v.tint.color = c;
            host.changed();
          }),
        ),
        section(
          'Underglow',
          field(
            'Lights',
            onOffSwitch(g.enabled, (on) => {
              g.enabled = on;
              host.changed();
            }, 'Underglow lights'),
          ),
          cycler(
            GLOW_PATTERNS.map((p) => ({ value: p, label: capital(p) })),
            g.pattern,
            (p) => {
              g.pattern = p;
              g.enabled = true;
              host.changed();
            },
          ),
          note('Alternate and chase use both colors.'),
        ),
        section(
          'Glow colors',
          // A swatch re-renders so the Lights switch shows the glow it turned on; the well cannot (it would close mid drag).
          rowName('Primary'),
          colorPicker(g.color, (c, preset) => {
            g.color = c;
            g.enabled = true;
            host.changed(preset);
          }),
          rowName('Secondary'),
          colorPicker(g.color2, (c) => {
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
    case 'body': {
      // One part slot at a time: the slots on a cycler (a ringed dot on those with a part fitted), then its parts.
      const slots: PartSlot[] = ['body', ...BODY_PART_SLOTS];
      const slot = host.bodySlot;
      const parts = partsFor(b.carId, slot);
      const optional = OPTIONAL_SLOTS.includes(slot);
      const items: { value: string | null; label: string; sub?: string }[] = [{ value: null, label: optional ? 'None' : 'Stock' }, ...parts.map((p) => ({ value: p.id, label: p.displayName, sub: `${p.tris} tris` }))];
      const dev = [...host.assets.devParts.entries()].filter(([, d]) => d.slot === slot).map(([id, d]) => ({ value: id, label: d.name, sub: 'Dev preview' }));
      items.push(...dev);
      const pick = cycler(
        slots.map((s) => ({ value: s, label: SLOT_LABELS[s], mark: !!v.parts[s] })),
        slot,
        (s) => {
          host.bodySlot = s;
          host.reframe();
          rerenderFromPicker(host);
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
    case 'tune':
      renderPerformance(host);
      break;
  }
}

/** The Stance tab's link: linked, front and rear sit the same (height, camber, offset, wheel size and tire); unlinked, each axle has its own. */
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
        // Linking starts from matching axles: the rear takes the front's settings and tire.
        const s = host.build.visual.stance;
        const w = host.build.visual.wheels;
        // Wheel width stays per axle: a staggered fitment survives the link.
        s.rear = { ...s.front, wheelWidth: s.rear.wheelWidth };
        w.rearTire = w.tire;
        host.changed();
        toast('Rear now matches front', Link2);
      }
      host.renderTab();
    },
  );
}

/**
 * The wheels' link and, unlinked, the Front / Rear switch, for the Wheels tab's picker and the Paint tab's wheel
 * paint: linked, front and rear wear the same wheel and paint; unlinked, the switch says which pair a pick dresses.
 */
function wheelAxleTools(host: TabHost): Node[] {
  const linked = host.prefs.linkWheels;
  const link = toggle(
    linked ? Link2 : Link2Off,
    'Link',
    linked,
    linked ? 'Front and rear wheels the same' : 'Front and rear wheels separate',
    () => {
      host.prefs.linkWheels = !linked;
      saveGaragePrefs(host.prefs);
      const w = host.build.visual.wheels;
      if (host.prefs.linkWheels) {
        // Linking starts from matching axles: the rear takes the front's wheel and paint.
        w.rearPart = null;
        w.rearPaint = { ...w.paint };
        host.changed();
        toast('Rear wheels now match front', Link2);
      } else host.wheelAxle = 'front';
      host.renderTab();
    },
  );
  return linked
    ? [link]
    : [
        link,
        segmented(
          AXLES.map((a) => ({ value: a, label: capital(a) })),
          host.wheelAxle,
          (a) => {
            host.wheelAxle = a;
            host.renderTab();
          },
        ),
      ];
}

/**
 * Re-render the tab for a pick on its leading cycler (the Paint tab's surface, the Body tab's slot), which the
 * render replaces: keyboard and pad focus moves to the new one, so left and right keep stepping it.
 */
function rerenderFromPicker(host: TabHost): void {
  const focused = document.activeElement?.classList.contains('cycler') ?? false;
  host.renderTab();
  const next = host.body.querySelector<HTMLElement>('.cycler');
  if (focused) next?.focus({ preventScroll: true });
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
  const rpmSlider = (label: string, value: number, stock: number, set: (x: number) => void, text: string) => [
    slider(label, value || off, off, top, LAUNCH_RPM.step, (x) => (x <= off ? 'Off' : x === stock ? `${x} rpm · stock` : `${x} rpm`), (x) => {
      set(x <= off ? 0 : x);
      host.changed(true);
    }),
    note(text),
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
  // Pops & bangs: cosmetic (visual build), so it never moves the stats; it scales the backfire's flames and sound.
  host.body.append(
    section(
      'Pops & bangs',
      slider('Pops', b.visual.popsBangs, 0, 2, 0.25, (x) => (x <= 0 ? 'Off' : x === 1 ? '100% · stock' : `${Math.round(x * 100)}%`), (x) => {
        b.visual.popsBangs = x;
        host.changed();
      }),
      note('How often the exhaust pops and flames on a lift, a shift or the limiter. Sight and sound together; no effect on performance.'),
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
  host.body.append(note('Position 3 on every slider is the stock car. Visual parts never change performance.'));
}

/** Whether a wheel model draws any Chrome (bolt hardware); the trims are per build, so the group shows when this axle's wheel has some. */
function hasHardware(id: string): boolean {
  return partById(id)?.materialSlots.includes('Chrome') ?? true;
}

/** A wheel trim's group (lip, center cap, lug nuts, bolts; render/car/lugNuts.ts draws the nuts): the paint picker over the trim, with its matches. Both axles. */
function trimSection(host: TabHost, name: string, trim: WheelTrim, matches: PaintMatch[]): HTMLElement {
  return section(name, paintPicker(trim, ACCENT_FINISHES, () => host.changed(), matches), note('Both axles.'));
}

/** A trim's match: on, the trim wears `mode`'s paint; off, it takes that paint as its own, so nothing jumps. */
function trimMatch(trim: WheelTrim, mode: WheelTrimMode, label: string, name: string, wears: () => Paint<AccentFinish>, ico?: IconNode): PaintMatch {
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
