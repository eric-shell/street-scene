/**
 * The full map's side panel contents: the legend and the Places tab's rows.
 * The legend is the map's own marks (you, the waypoint, the course, the
 * seed's other courses, the race shortcuts), then this city's neighbourhoods by name (one lights up while
 * hovered, a click flies to it, yours is marked), then its places and its
 * streets in sections, a row per layer with its swatch and count (water,
 * high ground and the like share a row); a layer row lights its kinds up on
 * the map while hovered and a click hides or shows them. The Places tab's
 * rows are the notable places and the drift zones, each with its kind and
 * neighbourhood, flying the map to it, with a waypoint button when the map
 * can set one. FullMap owns the state the rows act on and passes it in as
 * handlers.
 */
import { polygonBounds } from '../../city/districts/geom';
import type { Area, AreaKind } from '../../city/districts/types';
import type { World } from '../../city/world';
import type { Vec2 } from '../../sim/math';
import { KINDS, MAP_INK, deckOutline, shownOnMap, tagAnchor } from './cityMap';
import { bem, h, iconBtn } from '../kit/dom';
import { Eye, EyeOff, LocateFixed, MapPin, MapPinned, Navigation, icon, type IconNode } from '../kit/icons';
import { PALETTE } from '../kit/palette';
import { hoodPlan, type Neighbourhood } from '../../city/names/neighbourhoods';
import { isNamedPlace } from '../../city/names/placeNames';
import { placeLine, placeName } from '../../city/names/places';
import { INK, LEGEND_SECTIONS, inkOf, isShortcut, type LegendKey } from './tuning';

/** What the legend's rows do. */
export interface LegendHandlers {
  /** You: fly to the player. */
  find(): void;
  /** Waypoint: fly to it. */
  flyToWaypoint(): void;
  /** A neighbourhood: fly to it. */
  flyToHood(hood: Neighbourhood): void;
  /** A layer row was clicked: hide or show it (the row and its button, to mark the state). */
  toggle(key: LegendKey, li: HTMLElement, b: HTMLButtonElement): void;
  /** A row is hovered or focused (on), or left (off). */
  hover(key: LegendKey, on: boolean): void;
}

/** The legend and its rows by key (the waypoint's row shows and hides with it; a neighbourhood's is its button, marked while you are in it). */
export function buildLegend(world: World, course: { ink: string; label: string } | null, others: readonly { key: LegendKey; ink: string; label: string }[], on: LegendHandlers): { el: HTMLElement; rows: Map<LegendKey, HTMLElement> } {
  const counts = new Map<AreaKind, number>();
  let shortcuts = 0;
  // A shortcut driven one way only (a jump exit, a car park) carries chevrons on the map; the row's swatch shows one.
  let oneWay = false;
  for (const a of world.areas) {
    if (!shownOnMap(a) || (a.kind === 'infill' && !isNamedPlace(a))) continue;
    if (isShortcut(a)) {
      shortcuts++;
      if (a.params.jumpExit) oneWay = true;
    } else counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
    if (a.kind === 'carPark') oneWay = true;
  }
  const swatch = (kind: 'fill' | 'line' | 'dash' | 'ring' | 'icon' | 'arrow' | 'border', ink: string, fill?: string, ico?: IconNode) =>
    h('span', { class: bem('map-swatch', `--${kind}`), style: kind === 'fill' ? `background:${fill};border-color:${ink}` : kind === 'icon' ? `color:${ink}` : `border-color:${ink}` }, ico ? icon(ico, { size: 14 }) : null);
  const el = h('div', { class: 'map-legend' });
  const rows = new Map<LegendKey, HTMLElement>();
  let i = 0;
  const hover = (b: HTMLElement, key: LegendKey) => {
    b.addEventListener('pointerenter', () => on.hover(key, true));
    b.addEventListener('pointerleave', () => on.hover(key, false));
    b.addEventListener('focus', () => on.hover(key, true));
    b.addEventListener('blur', () => on.hover(key, false));
  };
  const section = (title: string, count = ''): HTMLElement => {
    const s = h('section', { class: 'map-legend__section', style: `--i:${i++}` }, h('h3', { class: 'map-legend__heading' }, title, count ? h('span', { class: 'map-legend__heading-count' }, count) : null));
    el.append(s);
    return s;
  };
  let list = h('ul', { class: 'map-legend__list' });
  el.append(list);
  const row = (key: LegendKey, sw: HTMLElement, label: string, count: string, action: 'toggle' | 'find' | 'fly', note = ''): void => {
    const state = action === 'toggle' ? h('span', { class: 'map-legend__eye' }, icon(Eye, { size: 15, className: 'map-legend__eye-open' }), icon(EyeOff, { size: 15, className: 'map-legend__eye-shut' })) : h('span', { class: 'map-legend__eye' }, icon(action === 'find' ? LocateFixed : MapPinned, { size: 15, className: 'map-legend__eye-open' }));
    const b = h(
      'button',
      { class: 'map-legend__button', type: 'button', title: (action === 'toggle' ? `Show or hide ${label.toLowerCase()}` : action === 'find' ? 'Find me' : 'Show the waypoint') + note, 'aria-pressed': action === 'toggle' ? 'true' : null },
      sw,
      h('span', { class: 'map-legend__label' }, label),
      h('span', { class: 'map-legend__count' }, count),
      state,
    );
    const li = h('li', { class: 'map-legend__row', 'data-key': key, style: `--i:${i++}` }, b);
    b.addEventListener('click', () => {
      if (action === 'find') on.find();
      else if (action === 'fly') on.flyToWaypoint();
      else on.toggle(key, li, b);
    });
    hover(b, key);
    rows.set(key, li);
    list.append(li);
  };
  row('you', swatch('icon', PALETTE.text, undefined, Navigation), 'You', '', 'find');
  row('waypoint', swatch('icon', INK.pin, undefined, MapPin), 'Waypoint', '', 'fly');
  if (course) row('route', swatch('line', course.ink), course.label, '', 'toggle');
  for (const o of others) row(o.key, swatch('line', o.ink), o.label, '', 'toggle');
  if (shortcuts) row('shortcut', swatch(oneWay ? 'arrow' : 'line', MAP_INK.shortcut), 'Race shortcuts', shortcuts > 1 ? String(shortcuts) : '', 'toggle', oneWay ? '. Chevrons point the only way through a one-way shortcut' : '');

  // The neighbourhoods: their borders as a layer, then each by name.
  const hoods = hoodPlan(world).hoods;
  if (hoods.length) {
    const s = section('Neighbourhoods', String(hoods.length));
    list = h('ul', { class: 'map-legend__list' });
    s.append(list);
    row('hoods', swatch('border', MAP_INK.border), 'Borders and names', '', 'toggle');
    const names = h('div', { class: 'map-legend__hoods' });
    for (const hd of hoods) {
      const b = h('button', { class: 'map-legend__hood', type: 'button', title: `Show ${hd.name} on the map`, style: `--i:${i++}` }, hd.name);
      b.addEventListener('click', () => on.flyToHood(hd));
      hover(b, `hood:${hd.id}`);
      rows.set(`hood:${hd.id}`, b);
      names.append(b);
    }
    s.append(names);
  }

  for (const sec of LEGEND_SECTIONS) {
    const layers = sec.layers.map((l) => ({ l, n: l.kinds.reduce((n, k) => n + (counts.get(k) ?? 0), 0) })).filter((x) => x.n);
    if (!layers.length) continue;
    const s = section(sec.title);
    list = h('ul', { class: 'map-legend__list' });
    s.append(list);
    for (const { l, n } of layers) {
      const k = l.kinds.find((k) => counts.get(k))!;
      const st = KINDS[k]!;
      const sw = k === 'roundabout' ? swatch('ring', st.ink) : st.fill ? swatch('fill', st.ink, st.fill) : swatch(st.dash ? 'dash' : 'line', st.ink);
      row(l.key, sw, l.label, n < 2 ? '' : String(n), 'toggle');
    }
  }
  return { el, rows };
}

/** A row of the Places tab. */
export interface PlaceRow {
  area: Area;
  /** Where a waypoint set from the list goes, and where the map flies (the area's middle). */
  at: Vec2;
  /** The area's bounds (m), framed by a fly-to. */
  span: { minX: number; maxX: number; minZ: number; maxZ: number };
  li: HTMLLIElement;
  far: HTMLElement;
  d: number;
}

/** What the Places rows do. */
export interface PlaceHandlers {
  fly(row: PlaceRow): void;
  hover(area: Area | null): void;
  /** Set the waypoint at a place; without it the rows have no waypoint button. */
  setWaypoint?(at: Vec2): void;
}

/** The Places tab's rows (the notable places and the drift zones), appended to nothing yet: FullMap sorts them by distance. */
export function buildPlaces(world: World, driftAreas: ReadonlySet<number>, on: PlaceHandlers): PlaceRow[] {
  const rows: PlaceRow[] = [];
  for (const a of world.areas) {
    if (!shownOnMap(a) || !(KINDS[a.kind]?.tag || driftAreas.has(a.id))) continue;
    // The expressway's deck by its drivable stretch (its planned polygon runs on past its end loops).
    const pts = a.kind === 'highway' && a.variant === 'deck' ? deckOutline(a) : a.polygon.length >= 3 ? a.polygon : a.path;
    if (!pts.length) continue;
    const span = polygonBounds(pts);
    const at = tagAnchor(world, a) ?? { x: (span.minX + span.maxX) / 2, z: (span.minZ + span.maxZ) / 2 };
    const ink = inkOf(a);
    const far = h('span', { class: 'map-places__distance' });
    const name = placeName(world, a);
    const drift = driftAreas.has(a.id);
    const note = placeLine(world, a, drift ? 'Drift zone' : undefined);
    const go = h(
      'button',
      { class: 'map-places__button', type: 'button', title: 'Show on the map' },
      h('i', { class: 'map-dot', style: `--ink:${ink}` }),
      h('span', { class: 'map-places__name' }, name, h('small', { class: bem('map-places__kind', drift ? '--drift' : '') }, note)),
      far,
    );
    const li = h('li', { class: 'map-places__item' }, go);
    const row: PlaceRow = { area: a, at, span, li, far, d: 0 };
    go.addEventListener('click', () => on.fly(row));
    go.addEventListener('pointerenter', () => on.hover(a));
    go.addEventListener('pointerleave', () => on.hover(null));
    const set = on.setWaypoint;
    if (set) {
      li.append(
        iconBtn(
          MapPin,
          'Set waypoint here',
          () => {
            set(at);
            on.fly(row);
          },
          '--small --ghost map-places__pin',
        ),
      );
    }
    rows.push(row);
  }
  return rows;
}
