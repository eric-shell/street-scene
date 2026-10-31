/**
 * What each Customize tab shows (Model, Power, Tune, Stance, Wheels, Body, Lights, Paint
 * and Tint; Vinyls is garageVinyls.ts): the tab list, and one builder that fills
 * the body for the open tab from the build. The builders reach the screen only
 * through TabHost, so garageUi.ts keeps the steps, saving and dialogs and this
 * file only the controls. Edits write straight into the build and call
 * `changed`, which refits the car live; Save is the screen's.
 *
 * Parts are bought (shared/economy.ts, shared/purchases.ts): the Wheels and
 * Body tabs tag each part with its price for this car, a lock and the races
 * still to finish, or nothing once owned. A pick the car does not own is put
 * on the car to preview and the screen offers it (TabHost.offer): bought, it
 * stays; declined, the pick goes back, so the build only ever keeps owned parts.
 * A new model drops the wheels it does not own, once confirmed.
 */
import { Link2, Link2Off } from 'lucide';
import { CarAssetLibrary, MANIFEST, manifestCar, partById, partsFor } from '../render/car/carAssets';
import { BODY_PART_SLOTS, isRemovalPart, OPTIONAL_SLOTS, PartEntry, PartSlot, SLOT_LABELS, STOCK_NODES } from '../shared/parts';
import { loadPurchases, owns, ownsFeature, stripParts, unownedParts, type PurchasesSave } from '../shared/purchases';
import { featureBuyable, partBuyable, type Buyable } from '../shared/economy';
import { loadStats, type StatsSave } from '../shared/stats';
import { ACCENT_FINISHES, AXLES, AccentFinish, Axle, AxleStance, BANNER_HEIGHTS, BODY_FEATURES, BodyFeature, CarBuild, FEATURE_LABELS, GLOW_PATTERNS, PAINT_FINISHES, Paint, STANCE_LIMITS, TireShape, VinylShape, WheelTrim, WheelTrimMode } from '../shared/carBuild';
import { SETUP_SLIDERS, getBaseTuning, type CarTuning } from '../sim/tuning';
import { GARAGE_CAR_IDS } from '../shared/garageCars';
import { LAUNCH_RPM, defaultAntilagRpm, defaultLaunchRpm, maxLaunchRpm, tuningForBuild } from '../sim/build';
import { FEATURES } from '../shared/features';
import { specBadges } from '../shared/carSpec';
import { cycler, h, multiSelect, onOffSwitch, segmented, toast } from '../ui/kit/dom';
import { ArrowUpDown, Car, Disc3, Eye, Gauge, Hammer, Layers, ListFilter, Paintbrush, Sparkles, Zap, IconNode } from '../ui/kit/icons';
import { GarageScene } from './garageScene';
import { GaragePrefs, StanceLink, saveGaragePrefs } from './storage';
import { capital, choiceList, cm, colorPicker, field, matchBody, mm, note, paintPicker, featureTag, partTag, partTagEl, percent, revealable, rowName, section, sectionWith, slider, statLines, toggle, type PaintMatch } from './garageWidgets';
import { renderVinyls } from './garageVinyls';
import { setupSlider } from './setupSliders';
import { wheelPicker } from './wheelPicker';
import type { WheelThumbs } from './wheelThumbs';

export type Tab = 'model' | 'power' | 'stance' | 'wheels' | 'paint' | 'vinyl' | 'tune' | 'body' | 'tint' | 'neon';

/** The tabs in order: the car, its engine and its setup first, then how it sits, its parts, its lights, its look, and the tint last. */
export const TABS: { id: Tab; label: string; icon: IconNode }[] = [
  { id: 'model', label: 'Model', icon: Car },
  { id: 'power', label: 'Power', icon: Zap },
  { id: 'tune', label: 'Tune', icon: Gauge },
  { id: 'stance', label: 'Stance', icon: ArrowUpDown },
  { id: 'wheels', label: 'Wheels', icon: Disc3 },
  { id: 'body', label: 'Body', icon: Hammer },
  { id: 'neon', label: 'Lights', icon: Sparkles },
  { id: 'paint', label: 'Paint', icon: Paintbrush },
  ...(FEATURES.vinyls ? [{ id: 'vinyl' as Tab, label: 'Vinyls', icon: Layers }] : []),
  { id: 'tint', label: 'Tint', icon: Eye },
];

/** A car's maker: the first word of its name (Wendt Strom R6 is a Wendt). */
const carMaker = (displayName: string) => displayName.split(' ')[0];

/** Model author shown under a car's name, by manifest `source`. */
export const AUTHORS: Record<string, string | undefined> = { icemaan: 'IceMaan', eshell: 'eshell' };

/**
 * The Paint tab's surfaces, listed in this order: the body, the roof (only on a car with a roof piece, matching the
 * body or a contrast), the mirror caps (only on a car whose manifest boxes them, chrome too), the calipers, the wheels (the face, the lip and the center cap) and the hardware (the lug nuts
 * and the bolts). The one last touched frames the camera.
 */
/** Body slots with no "No parts for this slot yet" line: a car without parts for them does not list them. */
const HIDE_WHEN_EMPTY: PartSlot[] = ['splitter', 'canards', 'diffuser', 'exhaust', 'mirrors', 'headlights', 'taillights'];
/** Part slots the Lights tab lists (the lamps) instead of the Body tab. */
export const LIGHT_SLOTS: readonly PartSlot[] = ['headlights', 'taillights'];

export const PAINT_SURFACES = ['body', 'roof', 'mirrors', 'calipers', 'wheels', 'hardware'] as const;
export type PaintSurface = (typeof PAINT_SURFACES)[number];

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
  /** The Body tab's part slot last touched (the camera frames it). */
  bodySlot: PartSlot;
  /** The Lights tab's lamp slot last touched (the camera frames it), or null for the underglow's wide shot. */
  lightsSlot: PartSlot | null;
  /** The Paint tab's surface last touched (the camera frames it). */
  paintSurface: PaintSurface;
  /** The axle the Wheels tab's wheel and the Paint tab's wheel paint dress while front and rear are unlinked. */
  wheelAxle: Axle;
  /** The wheel makers the Wheels tab's picker shows (empty: all of them). */
  wheelMakers: string[];
  /** The car makers the Model tab lists (empty: all of them). */
  carMakers: string[];
  /** The wheel picker's thumbnails, drawn once per wheel. */
  readonly wheelThumbs: WheelThumbs;
  /** The vinyl layer picked in the Vinyls tab (-1 for none). */
  selectedDecal: number;
  /** The vinyl being placed or moved on the car (index -1 for a new layer), until the next click on the body. */
  placing: { shape: VinylShape; index: number } | null;
  changed(rerender?: boolean): Promise<unknown>;
  renderTab(): void;
  /**
   * A part or feature the car does not own was just put on to preview: offer it (the buy dialog, or the races still to finish
   * when it is locked). Bought, it stays on; declined, `revert` takes the pick back and the tab re-renders.
   */
  offer(item: Buyable, revert: () => void): void;
  /** Ask before an edit that loses something: `go` on yes, `cancel` on no (the dialog closed). */
  confirm(ico: IconNode, title: string, text: string, yes: string, go: () => void, cancel: () => void): void;
  /** Frame the open tab's shot again (the Body tab's slot or the Paint tab's surface changed). */
  reframe(): void;
}

/**
 * A group that frames the camera on what it edits once touched (a click, a tap or focus inside it): the Paint
 * tab's surfaces and the Body tab's slots are all listed, so the shot follows the one in hand.
 */
function framing(el: HTMLElement, host: TabHost, touch: () => boolean): HTMLElement {
  const go = () => {
    if (touch()) host.reframe();
  };
  el.addEventListener('pointerdown', go);
  el.addEventListener('focusin', go);
  return el;
}

/**
 * A part slot's section: Stock (or None), its parts with what each costs this car, the dev drops and the switches
 * that dress the slot; null when the car has no parts for a slot that hides when empty (the aero, trim and lamps).
 */
function partSection(host: TabHost, slot: PartSlot, saved: PurchasesSave, stats: StatsSave): HTMLElement | null {
  const b = host.build;
  const v = b.visual;
  const parts = partsFor(b.carId, slot);
  const optional = OPTIONAL_SLOTS.includes(slot);
  // The aero and trim slots exist only for cars that ship parts for them: no menu at all otherwise.
  if (!parts.length && HIDE_WHEN_EMPTY.includes(slot) && ![...host.assets.devParts.values()].some((d) => d.slot === slot)) return null;
  // An optional slot's empty choice is Stock when the car carries a stock piece there (read off the model, or off the
  // parts that hide it while the model loads); a part that removes that piece is listed first as None.
  const stockNode = STOCK_NODES[slot];
  const stock = !optional || (stockNode !== undefined && (host.scene.car?.hasNode(stockNode) ?? parts.some((p) => p.hides.includes(stockNode))));
  const item = (p: PartEntry) => ({ value: p.id, label: p.displayName, extra: partTagEl(partTag(b.carId, p, saved, stats)) ?? undefined });
  const items: { value: string | null; label: string; sub?: string; extra?: Node }[] = [
    ...parts.filter(isRemovalPart).map(item),
    { value: null, label: stock ? 'Stock' : 'None' },
    ...parts.filter((p) => !isRemovalPart(p)).map(item),
  ];
  const dev = [...host.assets.devParts.entries()].filter(([, d]) => d.slot === slot).map(([id, d]) => ({ value: id, label: d.name, sub: 'Dev preview' }));
  items.push(...dev);
  const group = section(
    SLOT_LABELS[slot],
    items.length > 1
      ? choiceList(items, v.parts[slot] ?? null, (id) => {
          const was = v.parts[slot];
          v.parts[slot] = id;
          void host.changed(true);
          // A part this car does not own is a preview until it is bought.
          const part = id ? parts.find((p) => p.id === id) : undefined;
          if (part && !owns(b.carId, part.id))
            host.offer(partBuyable(part, b.carId), () => {
              if (was === undefined) delete v.parts[slot];
              else v.parts[slot] = was;
            });
        })
      : note('No parts for this slot yet.'),
    ...slotFeatures(b.carId, slot).map((f) => featureSwitch(host, f)),
  );
  group.dataset.slot = slot;
  return group;
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
  // Per axle sliders. While the panel's front and rear are linked (its Link), moving one moves its partner too.
  const partners = new Map<string, { el: HTMLInputElement; out: HTMLElement; fmt: (x: number) => string; toUi: (x: number) => number }>();
  const axleSlider = (axle: Axle, key: keyof AxleStance) => {
    const link = host.prefs.linkAxles[key];
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
      const imported = MANIFEST.cars.filter((c) => GARAGE_CAR_IDS.includes(c.id) && host.availability[c.id] !== false);
      // Alphabetical by maker and model: each fictional maker sorts where its real one would.
      const cars = [...(imported.length ? imported : MANIFEST.cars.filter((c) => GARAGE_CAR_IDS.includes(c.id)))].sort((a, z) => a.displayName.localeCompare(z.displayName));
      const list = choiceList(
        cars.map((c) => ({ value: c.id, label: c.displayName, sub: AUTHORS[c.source], tags: specBadges(c.engine, getBaseTuning(c.id).drivetrain.layout) })),
        b.carId,
        (id) => {
          if (id === b.carId) return;
          // Parts are per car; wheels are universal and stay, unless the new car does not own them (bought per car).
          const wheels = v.parts.wheels;
          const lost = unownedParts({ ...v, parts: wheels ? { wheels } : {} }, id);
          const go = () => {
            // A launch or antilag rpm left on the old car's stock pick follows the new car's; one the player chose stays (applyBuild clamps it).
            // Swaps are per car: the new one starts on its own engine.
            followEngine(b.performance, b.carId, b.performance.swap, id, undefined);
            delete b.performance.swap;
            b.carId = id;
            v.parts = wheels ? { wheels } : {};
            stripParts(v, lost);
            v.decals = [];
            // Say hello: a short blip of the new car's engine (and the body rocks with it).
            void host.changed(lost.length > 0).then(() => host.scene.blip());
          };
          if (!lost.length) return go();
          const name = manifestCar(id).displayName;
          host.confirm(Car, `Switch to the ${name}?`, `Switching to the ${name} resets these parts to stock: ${lost.map((p) => p.name).join(', ')}. Parts and features are bought per car.`, 'Switch', go, () => host.renderTab());
        },
      );
      // The makers filter, as the Wheels tab's: it hides the other makers' tiles in place, so its menu stays open
      // for the next maker. Makers alphabetical, the one of the car fitted dotted.
      const tiles = [...list.children] as HTMLElement[];
      const makers = [...new Set(cars.map((c) => carMaker(c.displayName)))].sort((a, z) => a.localeCompare(z));
      const filter = (m: readonly string[]) => tiles.forEach((t, i) => (t.hidden = m.length > 0 && !m.includes(carMaker(cars[i].displayName))));
      filter(host.carMakers);
      const pick = multiSelect(
        makers.map((m) => ({ value: m, label: m, count: cars.filter((c) => carMaker(c.displayName) === m).length, mark: m === carMaker(manifestCar(b.carId).displayName) })),
        host.carMakers,
        'All makers',
        (m) => {
          filter(m);
          host.carMakers = m;
        },
        ListFilter,
      );
      const soon = h('div', { class: 'garage-item garage-item--soon', 'aria-disabled': 'true', title: 'More models coming soon' }, h('span', { class: 'garage-item__label' }, 'More models soon'), h('span', { class: 'garage-item__sub muted' }, 'Coming soon'));
      soon.addEventListener('click', () => toast('More cars are on the way', Car));
      list.append(soon);
      host.body.append(section('Model', pick, list, note('A new car starts from its stock body; the wheels stay.')));
      break;
    }
    case 'stance': {
      // Everything about how the car sits on its wheels, front and rear side by side: the body's height and
      // the wheels' angle, track, size, width and tire. Each panel links its own front and rear.
      const w = v.wheels;
      const linked = host.prefs.linkAxles.tire;
      // Linked, one stretch sets both tires; unlinked, each axle picks its own.
      const stretchPick = (axle: Axle | null) =>
        cycler(STRETCH_CHOICES, axle === 'rear' ? w.rearTire : w.tire, (t) => {
          if (axle !== 'rear') w.tire = t;
          if (axle !== 'front') w.rearTire = t;
          host.changed();
        });
      const axlePanel = (label: string, key: keyof AxleStance, ...notes: HTMLElement[]) => sectionWith(label, [linkToggle(host, key)], ...AXLES.map((a) => axleSlider(a, key)), ...notes);
      host.body.append(
        axlePanel('Ride height', 'rideHeight', note('Visual only. Front and rear apart rake the car.')),
        axlePanel('Camber', 'camber'),
        axlePanel('Spacing', 'offset'),
        axlePanel('Wheel size', 'wheelSize', note('Bigger wheels, thinner sidewalls.')),
        axlePanel('Wheel width', 'wheelWidth', note('Wider wheels grow inward; the face and spokes keep their shape.')),
        sectionWith(
          'Tires',
          [linkToggle(host, 'tire')],
          ...(linked ? [revealable(field('Stretch', stretchPick(null)), 'stretch')] : AXLES.map((a) => revealable(field(`${capital(a)} stretch`, stretchPick(a)), `stretch-${a}`))),
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
      // The ledgers, read once for every tile's tag.
      const saved = loadPurchases();
      const stats = loadStats();
      // The picker fills the tab (the section grows to the body's height) with its own scrolling panes.
      const group = sectionWith(
        linked ? 'Wheel' : `${capital(host.wheelAxle)} wheel`,
        [wheelLink(host)],
        linked ? revealable(note('Every pick equips all four wheels.'), 'linked-note') : axleSwitch(host),
        wheelPicker({
          wheels: partsFor(b.carId, 'wheels'),
          current: rear ? (w.rearPart ?? front) : front,
          makers: host.wheelMakers,
          thumbs: host.wheelThumbs,
          target: manifestCar(b.carId).targetOffset?.front,
          // The picker filters in place (the menu stays open for the next maker); the host keeps the pick for re-renders.
          onMakers: (m) => {
            host.wheelMakers = m;
          },
          tag: (p) => partTagEl(partTag(b.carId, p, saved, stats), true),
          onPick: (id) => {
            const was = { front: v.parts.wheels, rear: w.rearPart };
            if (rear) w.rearPart = id;
            else {
              // Linked, the rear follows the front; unlinked, it keeps the wheel it wore.
              w.rearPart = linked ? null : (w.rearPart ?? front);
              v.parts.wheels = id;
            }
            void host.changed();
            // A wheel this car does not own is a preview until it is bought.
            const part = partsFor(b.carId, 'wheels').find((p) => p.id === id);
            if (part && !owns(b.carId, id))
              host.offer(partBuyable(part, b.carId), () => {
                if (was.front === undefined) delete v.parts.wheels;
                else v.parts.wheels = was.front;
                w.rearPart = was.rear;
              });
          },
        }),
      );
      group.classList.add('garage-section--fill');
      host.body.append(group);
      break;
    }
    case 'paint': {
      // Every surface listed, in PAINT_SURFACES' order; the one in hand frames the camera.
      const w = v.wheels;
      // The wheel paints and trims: the face is per axle (the Link and Front / Rear say which), the trims (lip, cap,
      // lug nuts, hardware) are per build, both axles, each wearing its own paint or another surface's (the axle on
      // show's face, the cap, the body, the lip as the wheel ships it).
      const linked = host.prefs.linkWheels;
      const rear = !linked && host.wheelAxle === 'rear';
      const paint = rear ? w.rearPaint : w.paint;
      const wheelId = rear ? (w.rearPart ?? v.parts.wheels ?? manifestCar(b.carId).defaultWheel) : (v.parts.wheels ?? manifestCar(b.carId).defaultWheel);
      const face = (): Paint<AccentFinish> => (paint.match ? v.paint : paint);
      const capWears = (): Paint<AccentFinish> => (w.cap.mode === 'body' ? v.paint : w.cap.mode === 'paint' ? w.cap : face());
      const body = (): Paint<AccentFinish> => v.paint;
      // The loaded model knows best (a stock Roof piece or a roof part); until it loads, the catalog's roof parts.
      const roofShown = host.scene.car?.hasRoof() ?? partsFor(b.carId, 'roof').length > 0;
      const surface = (s: PaintSurface, el: HTMLElement) =>
        framing(el, host, () => {
          if (host.paintSurface === s) return false;
          host.paintSurface = s;
          return true;
        });
      host.body.append(
        // The body alone takes no chrome.
        surface('body', section('Body', paintPicker(v.paint, PAINT_FINISHES, () => host.changed()))),
        // A contrast roof is real paint or a wrap, so the body's finishes; only cars with a roof piece list it.
        ...(roofShown ? [surface('roof', section('Roof', paintPicker(v.roof, PAINT_FINISHES, () => host.changed(), [matchBody(v.roof, v.paint)]), note('The roof panel only: the pillars keep the body paint.')))] : []),
        // Mirror caps take chrome too, like a factory brightwork option; only cars with boxed caps list them.
        ...(manifestCar(b.carId).mirrorCaps || partsFor(b.carId, 'mirrors').length ? [surface('mirrors', section('Mirror caps', paintPicker(v.mirrors, ACCENT_FINISHES, () => host.changed(), [matchBody(v.mirrors, v.paint)]), note('The mirror housings and their stalks.')))] : []),
        // One caliper paint for all four corners, whatever the axle switch says.
        surface('calipers', section('Calipers', paintPicker(v.calipers, ACCENT_FINISHES, () => host.changed(), [matchBody(v.calipers, v.paint)]), note('One paint for all four corners.'))),
        surface(
          'wheels',
          sectionWith(
            linked ? 'Wheel' : `${capital(host.wheelAxle)} wheel`,
            [wheelLink(host)],
            linked ? null : axleSwitch(host),
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
        ),
        surface(
          'wheels',
          trimSection(host, 'Lip', w.lip, [
            trimMatch(w.lip, 'face', 'Match wheel', 'Wheel paint', face),
            trimMatch(w.lip, 'body', 'Match body', 'Body paint', body),
          ]),
        ),
        surface('wheels', trimSection(host, 'Center cap', w.cap, [trimMatch(w.cap, 'face', 'Match wheel', 'Wheel paint', face), trimMatch(w.cap, 'body', 'Match body', 'Body paint', body)])),
        surface(
          'hardware',
          trimSection(host, 'Lug nuts', w.lugNuts, [
            trimMatch(w.lugNuts, 'cap', 'Match cap', 'Center cap', capWears),
            trimMatch(w.lugNuts, 'face', 'Match wheel', 'Wheel paint', face),
            trimMatch(w.lugNuts, 'body', 'Match body', 'Body paint', body),
          ]),
        ),
        // The bolt hardware shows for a wheel model that draws any.
        ...(hasHardware(wheelId)
          ? [
              surface(
                'hardware',
                revealable(trimSection(host, 'Bolts', w.hardware, [
                  trimMatch(w.hardware, 'cap', 'Match cap', 'Center cap', capWears),
                  trimMatch(w.hardware, 'face', 'Match wheel', 'Wheel paint', face),
                  trimMatch(w.hardware, 'body', 'Match body', 'Body paint', body),
                ]), 'bolts'),
              ),
            ]
          : []),
        // Last, the paint switches only this car has.
        ...featureSection(host, PAINT_FEATURES),
      );
      break;
    }
    case 'vinyl':
      renderVinyls(host);
      break;
    case 'tint': {
      // The glass in the lit room, catching the shop's lights: the side and rear windows' tint (the windshield stays
      // clear), then the banner across the windshield's top, whose controls show while it is on: the tint's film
      // under the glass, or with Vinyl on a vinyl over it, painted like every other surface (Custom or Match body).
      const banner = v.banner;
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
          note('The side and rear windows; the windshield stays clear.'),
        ),
        section(
          'Windshield banner',
          field(
            'Banner',
            onOffSwitch(banner.enabled, (on) => {
              banner.enabled = on;
              void host.changed(true);
            }, 'Windshield banner'),
          ),
          ...(banner.enabled
            ? [
                revealable(
                  field(
                    'Height',
                    cycler(BANNER_HEIGHTS.map((x) => ({ value: x, label: capital(x) })), banner.height, (x) => {
                      banner.height = x;
                      host.changed();
                    }),
                  ),
                  'banner-height',
                ),
                revealable(
                  field(
                    'Vinyl',
                    onOffSwitch(banner.vinyl, (on) => {
                      banner.vinyl = on;
                      void host.changed(true);
                    }, 'Vinyl banner'),
                  ),
                  'banner-vinyl',
                ),
                banner.vinyl
                  ? revealable(paintPicker(banner.paint, PAINT_FINISHES, () => host.changed(), [matchBody(banner.paint, v.paint)]), 'banner-paint')
                  : revealable(note('The window tint, under the glass.'), 'banner-tint'),
              ]
            : []),
        ),
      );
      break;
    }
    case 'neon': {
      // The car's lights: the lamps (the tail lamps' part list when the car has some, framed on the lamp once touched) and
      // the underglow, shot low and wide so the glow reads on the floor.
      const g = v.underglow;
      const lamp = (slot: PartSlot) => {
        const group = partSection(host, slot, loadPurchases(), loadStats()) ?? section(SLOT_LABELS[slot], note('Coming soon.'));
        return framing(group, host, () => {
          if (host.lightsSlot === slot) return false;
          host.lightsSlot = slot;
          return true;
        });
      };
      const glow = (el: HTMLElement) =>
        framing(el, host, () => {
          if (host.lightsSlot === null) return false;
          host.lightsSlot = null;
          return true;
        });
      host.body.append(
        lamp('headlights'),
        lamp('taillights'),
        glow(section(
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
          note('Strobe and chase use both colors; a black secondary strobes on and off.'),
        )),
        glow(section(
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
        )),
        glow(section(
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
        )),
      );
      break;
    }
    case 'body': {
      // Every body part slot listed (a part list each, or a line while a slot has none yet); the one in hand frames the
      // camera. Each part shows what it costs this car (owned, its price, or the races that unlock it).
      const saved = loadPurchases();
      const stats = loadStats();
      for (const slot of BODY_PART_SLOTS) {
        if (LIGHT_SLOTS.includes(slot)) continue;
        const group = partSection(host, slot, saved, stats);
        if (!group) continue;
        host.body.append(
          framing(group, host, () => {
            if (host.bodySlot === slot) return false;
            host.bodySlot = slot;
            return true;
          }),
        );
      }
      // Last, the shape switches only this car has.
      host.body.append(...featureSection(host, BODY_SHAPE_FEATURES));
      // A slot picked from elsewhere (the dev part drop) scrolls into view; one already in view stays put.
      if (host.bodySlot !== BODY_PART_SLOTS[0]) requestAnimationFrame(() => host.body.querySelector(`[data-slot='${host.bodySlot}']`)?.scrollIntoView({ block: 'nearest' }));
      break;
    }
    case 'power':
      renderPower(host);
      break;
    case 'tune':
      renderPerformance(host);
      break;
  }
}

/**
 * Move a build's launch and antilag rpm from one engine's stock picks to another's (a car change or an engine swap):
 * a value left on the old stock pick follows the new one; one the player chose stays (applyBuild clamps it).
 */
function followEngine(p: CarBuild['performance'], fromCar: string, fromSwap: string | undefined, toCar: string, toSwap: string | undefined): void {
  if (p.launchRpm === defaultLaunchRpm(fromCar, fromSwap)) p.launchRpm = defaultLaunchRpm(toCar, toSwap);
  if ((p.antilagRpm ?? defaultAntilagRpm(fromCar, fromSwap)) === defaultAntilagRpm(fromCar, fromSwap)) p.antilagRpm = defaultAntilagRpm(toCar, toSwap);
}

/** An engine's peak figures off its torque curve, as the maker quotes them: PS and N·m, before the sim's drivetrain calibration (torqueMul). */
function engineFigures(t: CarTuning): string {
  const curve = t.engine.torqueCurve;
  const nm = Math.max(...curve.map(([, tq]) => tq));
  const kw = Math.max(...curve.map(([rpm, tq]) => (tq * rpm * Math.PI) / 30000));
  return `${Math.round(kw / 0.73549875)} PS · ${nm} N·m`;
}

/**
 * The Power tab: the car's own engine and the swaps it offers (manifest `engineSwaps`, physics in drivingParams.json
 * `swaps`), each with its peak figures and spec tags, over the build's measured stats. A pick refits the voice, the
 * rev model and the dyno (garageUi configureEngine) and re-measures the stats.
 */
function renderPower(host: TabHost): void {
  const b = host.build;
  const car = manifestCar(b.carId);
  const drive = getBaseTuning(b.carId).drivetrain.layout;
  const swaps = car.engineSwaps ?? [];
  host.body.append(section('Stats', statLines(b, { weight: true })));
  const stock = { value: null, label: `Stock ${car.engine.layout}`, sub: engineFigures(tuningForBuild(b.carId, { ...b.performance, swap: undefined })), tags: specBadges(car.engine, drive) };
  const list = choiceList<string | null>(
    [stock, ...swaps.map((s) => ({ value: s.id, label: s.name, sub: engineFigures(tuningForBuild(b.carId, { ...b.performance, swap: s.id })), tags: specBadges(s.engine, drive, s.name) }))],
    b.performance.swap ?? null,
    (id) => {
      const swap = id ?? undefined;
      if (swap === b.performance.swap) return;
      followEngine(b.performance, b.carId, b.performance.swap, b.carId, swap);
      if (swap) b.performance.swap = swap;
      else delete b.performance.swap;
      // Hear it: a short blip on the new engine, and the stats for it.
      void host.changed().then(() => host.scene.blip());
      host.renderTab();
    },
  );
  const fitted = swaps.find((s) => s.id === b.performance.swap);
  host.body.append(
    section(
      'Engine swaps',
      list,
      swaps.length ? note(fitted ? fitted.note : 'Your car runs its own engine. A swap changes the power, the weight and the sound.') : note('No engine swaps for this car yet.'),
    ),
  );
}

/** Which tab lists each unique feature: the shapes on Body, the paint on Paint. A feature that dresses a part slot sits in that slot's section instead (`SLOT_FEATURES`). */
const BODY_SHAPE_FEATURES: readonly BodyFeature[] = ['shavedHatch', 'shavedRubstrip', 'halfCupHandles'];
const PAINT_FEATURES: readonly BodyFeature[] = ['blackGrille'];
/** The body part slot a feature belongs to: its switch sits under that slot's part list. */
const SLOT_FEATURES: Partial<Record<BodyFeature, PartSlot>> = { fogLights: 'frontBumper', shavedMarkers: 'fenders', windSplitters: 'roof' };

/**
 * A feature's switch row, with its tag (owned, price or locked). Switching on one the car does not own previews it
 * and offers it (TabHost.offer); anything but Buy switches it back off.
 */
function featureSwitch(host: TabHost, f: BodyFeature): HTMLElement {
  const v = host.build.visual;
  const { carId } = host.build;
  const tag = partTagEl(featureTag(carId, f, loadPurchases(), loadStats()));
  const set = (f: BodyFeature, on: boolean) => {
    v.features = BODY_FEATURES.filter((x) => (x === f ? on : v.features.includes(x)));
  };
  const row = field(
    FEATURE_LABELS[f],
    onOffSwitch(v.features.includes(f), (on) => {
      set(f, on);
      host.changed();
      if (on && !ownsFeature(carId, f)) host.offer(featureBuyable(f, FEATURE_LABELS[f]), () => set(f, false));
    }, FEATURE_LABELS[f]),
  );
  if (tag) row.firstElementChild?.append(tag);
  return row;
}

/** The features of `slot` the car's manifest offers. */
const slotFeatures = (carId: string, slot: PartSlot): BodyFeature[] => BODY_FEATURES.filter((f) => SLOT_FEATURES[f] === slot && manifestCar(carId).bodyFeatures?.[f]);

/** A tab's Unique features panel: a switch for each of `features` the car's manifest offers (bodyFeatures), or nothing when it offers none. */
function featureSection(host: TabHost, features: readonly BodyFeature[]): HTMLElement[] {
  const offered = features.filter((f) => manifestCar(host.build.carId).bodyFeatures?.[f]);
  if (!offered.length) return [];
  return [
    section(
      'Unique features',
      ...offered.map((f) => featureSwitch(host, f)),
    ),
  ];
}

/** A Stance panel's link: linked, front and rear of that panel sit the same; unlinked, each axle has its own. */
function linkToggle(host: TabHost, key: StanceLink): HTMLElement {
  const linked = host.prefs.linkAxles[key];
  return toggle(
    linked ? Link2 : Link2Off,
    'Link',
    linked,
    linked ? 'Front and rear linked' : 'Front and rear separate',
    () => {
      host.prefs.linkAxles[key] = !linked;
      saveGaragePrefs(host.prefs);
      if (!linked) {
        // Linking starts from matching axles: the rear takes the front's setting.
        const v = host.build.visual;
        if (key === 'tire') v.wheels.rearTire = v.wheels.tire;
        else v.stance.rear[key] = v.stance.front[key];
        host.changed();
        toast('Rear now matches front', Link2);
      }
      host.renderTab();
    },
  );
}

/**
 * The wheels' link, at the right of the Wheels tab's picker and the Paint tab's wheel paint titles: linked, front and
 * rear wear the same wheel and paint; unlinked, the Front / Rear switch (axleSwitch) says which pair a pick dresses.
 */
function wheelLink(host: TabHost): HTMLElement {
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
        // Linking starts from matching axles: the rear takes the front's wheel and paint.
        w.rearPart = null;
        w.rearPaint = { ...w.paint };
        host.changed();
        toast('Rear wheels now match front', Link2);
      } else host.wheelAxle = 'front';
      host.renderTab();
    },
  );
}

/** The Front / Rear switch while the wheels are unlinked: which pair the Wheels and Paint tabs' picks dress. */
function axleSwitch(host: TabHost): HTMLElement {
  return revealable(h(
    'div',
    { class: 'row' },
    segmented(
      AXLES.map((a) => ({ value: a, label: capital(a) })),
      host.wheelAxle,
      (a) => {
        host.wheelAxle = a;
        host.renderTab();
      },
    ),
  ), 'axle-switch');
}

/** The Tune tab: the stat lines, launch control and the four setup sliders. */
function renderPerformance(host: TabHost): void {
  const b = host.build;
  // The build card's stat lines, so the stats and the setup fit the column together. A slider swaps them for
  // the new setup's in place: re-rendering the tab would take focus off the notch the keyboard or pad is on.
  let stats = statLines(b, { weight: true });
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
          const next = statLines(b, { weight: true });
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
function trimMatch(trim: WheelTrim, mode: WheelTrimMode, label: string, name: string, wears: () => Paint<AccentFinish>): PaintMatch {
  return {
    label,
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
