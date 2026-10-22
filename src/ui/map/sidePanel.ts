/**
 * The full map's side panel contents: the legend (what this city has, with
 * counts; a row lights its kind up on the map, a click hides or shows it, You
 * finds you and Waypoint flies to it) and the Places tab's rows (the notable
 * places and the drift zones, each flying the map to it, with a waypoint
 * button when the map can set one). FullMap owns the state the rows act on
 * and passes it in as handlers.
 */
import { polygonBounds } from '../../city/districts/geom';
import type { Area, AreaKind } from '../../city/districts/types';
import type { World } from '../../city/world';
import type { Vec2 } from '../../sim/math';
import { KINDS, MAP_INK, shownOnMap, tagAnchor } from './cityMap';
import { bem, h, iconBtn } from '../kit/dom';
import { Eye, EyeOff, LocateFixed, MapPin, MapPinned, Navigation, icon, type IconNode } from '../kit/icons';
import { PALETTE } from '../kit/palette';
import { placeName } from './places';
import { INK, LEGEND_ORDER, inkOf, isShortcut, kindNote, type LegendKey } from './tuning';

/** What the legend's rows do. */
export interface LegendHandlers {
  /** You: fly to the player. */
  find(): void;
  /** Waypoint: fly to it. */
  flyToWaypoint(): void;
  /** A layer row was clicked: hide or show it (the row and its button, to mark the state). */
  toggle(key: LegendKey, li: HTMLElement, b: HTMLButtonElement): void;
  /** A row is hovered or focused (on), or left (off). */
  hover(key: LegendKey, on: boolean): void;
}

/** The legend list and its rows by key (the waypoint's row shows and hides with it). */
export function buildLegend(world: World, course: { ink: string; label: string } | null, on: LegendHandlers): { list: HTMLElement; rows: Map<LegendKey, HTMLLIElement> } {
  const counts = new Map<AreaKind, number>();
  let shortcuts = 0;
  for (const a of world.areas) {
    if (!shownOnMap(a)) continue;
    if (isShortcut(a)) shortcuts++;
    else counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  }
  const swatch = (kind: 'fill' | 'line' | 'dash' | 'ring' | 'icon', ink: string, fill?: string, ico?: IconNode) =>
    h('span', { class: bem('map-swatch', `--${kind}`), style: kind === 'fill' ? `background:${fill};border-color:${ink}` : kind === 'icon' ? `color:${ink}` : `border-color:${ink}` }, ico ? icon(ico, { size: 14 }) : null);
  const list = h('ul', { class: 'map-legend' });
  const rows = new Map<LegendKey, HTMLLIElement>();
  let i = 0;
  const row = (key: LegendKey, sw: HTMLElement, label: string, count: string, action: 'toggle' | 'find' | 'fly'): void => {
    const state = action === 'toggle' ? h('span', { class: 'map-legend__eye' }, icon(Eye, { size: 15, className: 'map-legend__eye-open' }), icon(EyeOff, { size: 15, className: 'map-legend__eye-shut' })) : h('span', { class: 'map-legend__eye' }, icon(action === 'find' ? LocateFixed : MapPinned, { size: 15, className: 'map-legend__eye-open' }));
    const b = h(
      'button',
      { class: 'map-legend__button', type: 'button', title: action === 'toggle' ? `Show or hide ${label.toLowerCase()}` : action === 'find' ? 'Find me' : 'Show the waypoint', 'aria-pressed': action === 'toggle' ? 'true' : null },
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
    b.addEventListener('pointerenter', () => on.hover(key, true));
    b.addEventListener('pointerleave', () => on.hover(key, false));
    b.addEventListener('focus', () => on.hover(key, true));
    b.addEventListener('blur', () => on.hover(key, false));
    rows.set(key, li);
    list.append(li);
  };
  row('you', swatch('icon', PALETTE.text, undefined, Navigation), 'You', '', 'find');
  row('waypoint', swatch('icon', INK.pin, undefined, MapPin), 'Waypoint', '', 'fly');
  if (course) row('route', swatch('line', course.ink), course.label, '', 'toggle');
  if (shortcuts) row('shortcut', swatch('line', MAP_INK.shortcut), 'Race shortcuts', shortcuts > 1 ? String(shortcuts) : '', 'toggle');
  for (const k of LEGEND_ORDER) {
    const n = counts.get(k) ?? 0;
    const st = KINDS[k];
    if (!n || !st) continue;
    const sw = k === 'roundabout' ? swatch('ring', st.ink) : st.fill ? swatch('fill', st.ink, st.fill) : swatch(st.dash ? 'dash' : 'line', st.ink);
    // Infill is frontage filler: a count of it says nothing.
    row(k, sw, st.label, k === 'infill' || n < 2 ? '' : String(n), 'toggle');
  }
  return { list, rows };
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
    const pts = a.polygon.length >= 3 ? a.polygon : a.path;
    if (!pts.length) continue;
    const span = polygonBounds(pts);
    const at = tagAnchor(world, a) ?? { x: (span.minX + span.maxX) / 2, z: (span.minZ + span.maxZ) / 2 };
    const ink = inkOf(a);
    const far = h('span', { class: 'map-places__distance' });
    const name = placeName(a);
    const drift = driftAreas.has(a.id);
    const note = drift ? 'Drift zone' : kindNote(name, KINDS[a.kind]?.label ?? '');
    const go = h(
      'button',
      { class: 'map-places__button', type: 'button', title: 'Show on the map' },
      h('i', { class: 'map-dot', style: `--ink:${ink}` }),
      h('span', { class: 'map-places__name' }, name, note ? h('small', { class: bem('map-places__kind', drift ? '--drift' : '') }, note) : null),
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
