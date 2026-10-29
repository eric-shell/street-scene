/**
 * The Wheels tab's wheel picker, filling the tab: a makers filter on top (the
 * kit's multi-select: All, or any set of makers, each with its count and a dot
 * on the maker of the wheel fitted), and under it the wheels as tiles of their
 * thumbnails (wheelThumbs.ts) across the whole width, under a heading per maker
 * that sticks to the top of the pane as that maker's wheels scroll by, so under
 * All the hundred wheels still say where you are. Makers and wheels
 * alphabetical, a neutral order with no ranking. The filter shows and hides the
 * makers' groups in place, so its menu stays open for the next maker. The
 * picker opens scrolled to the wheel fitted, and a tile asks for its thumbnail
 * only as it scrolls into the pane, so a maker's dozen wheels load, not all of
 * them.
 */
import type { PartEntry } from '../shared/parts';
import { h, multiSelect, sheen } from '../ui/kit/dom';
import { ListFilter } from '../ui/kit/icons';
import type { WheelThumbs } from './wheelThumbs';

/** The wheels by maker (`group`), makers and wheels in alphabetical order; a wheel without one goes under Other, last. */
export function wheelGroups(wheels: PartEntry[]): [string, PartEntry[]][] {
  const groups = new Map<string, PartEntry[]>();
  for (const p of wheels) {
    const g = p.group ?? 'Other';
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const rank = (g: string) => (g === 'Other' ? '￿' : g);
  return [...groups]
    .sort(([a], [b]) => rank(a).localeCompare(rank(b)))
    .map(([g, list]) => [g, list.sort((a, b) => a.displayName.localeCompare(b.displayName))]);
}

/** The last picker's tile watcher: one picker is up at a time, so a new one lets go of the last one's tiles. */
let seen: IntersectionObserver | null = null;

export interface WheelPickerOptions {
  wheels: PartEntry[];
  /** The wheel the axle on show wears. */
  current: string;
  /** The makers on show (empty: all of them). */
  makers: string[];
  thumbs: WheelThumbs;
  /** The car's front offset target (mm), so the tiles show each face where this car sets it. */
  target?: number;
  onMakers(makers: string[]): void;
  onPick(id: string): void;
}

export function wheelPicker(o: WheelPickerOptions): HTMLElement {
  const groups = wheelGroups(o.wheels);
  const currentGroup = groups.find(([, list]) => list.some((p) => p.id === o.current))?.[0];

  // The wheels: a heading and a grid per maker, every maker built and the filter hiding the rest.
  const wheels = h('div', { class: 'wheel-picker__wheels' });
  const tiles: HTMLElement[] = [];
  const shown = new Map<string, HTMLElement>();
  let currentTile: HTMLElement | null = null;
  for (const [group, list] of groups) {
    const grid = h('div', { class: 'wheel-picker__grid' });
    for (const p of list) {
      const t = tile(p, group);
      if (p.id === o.current) currentTile = t;
      grid.append(t);
    }
    const el = h('div', { class: 'wheel-picker__group' }, h('div', { class: 'wheel-picker__head' }, h('span', { class: 'wheel-picker__head-name' }, group), h('span', { class: 'wheel-picker__count' }, `${list.length} ${list.length === 1 ? 'wheel' : 'wheels'}`)), grid);
    shown.set(group, el);
    wheels.append(el);
  }
  const filter = (makers: readonly string[]) => {
    for (const [g, el] of shown) el.hidden = makers.length > 0 && !makers.includes(g);
  };
  filter(o.makers);
  const makers = multiSelect(
    groups.map(([g, list]) => ({ value: g, label: g, count: list.length, mark: g === currentGroup })),
    o.makers,
    'All makers',
    (m) => {
      filter(m);
      wheels.scrollTop = 0;
      o.onMakers(m);
    },
    ListFilter,
    'wheel-picker__filter',
  );

  function tile(p: PartEntry, group: string): HTMLElement {
    const img = h('img', { class: 'wheel-picker__thumb', alt: '', draggable: 'false' }) as HTMLImageElement;
    const el = h(
      'button',
      { type: 'button', class: `wheel-picker__tile${p.id === o.current ? ' is-selected' : ''}`, title: `${group} ${p.displayName}`, 'aria-pressed': String(p.id === o.current) },
      h('span', { class: 'wheel-picker__frame' }, img),
      h('span', { class: 'wheel-picker__name' }, p.displayName),
      sheen(),
    );
    Object.assign(el, {
      load: () =>
        void o.thumbs.thumb(p, o.target).then((url) => {
          if (!url) return;
          img.src = url;
          el.classList.add('is-loaded');
        }),
    });
    tiles.push(el);
    el.addEventListener('click', () => {
      wheels.querySelectorAll('.wheel-picker__tile.is-selected').forEach((x) => {
        x.classList.remove('is-selected');
        x.setAttribute('aria-pressed', 'false');
      });
      el.classList.add('is-selected');
      el.setAttribute('aria-pressed', 'true');
      o.onPick(p.id);
    });
    return el;
  }

  // Once the panes are laid out (the picker is appended after it returns): open on the wheel fitted and its
  // maker, then watch the tiles for their turn to load. The watcher's root is the wheels pane, so it is made
  // only now, with the pane in the document; made before, it would never see a tile.
  const reveal = (pane: HTMLElement, el: HTMLElement | null) => {
    if (!el) return;
    const top = el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTop = Math.max(0, top - (pane.clientHeight - el.offsetHeight) / 2);
  };
  requestAnimationFrame(() => {
    if (currentTile && !currentTile.closest<HTMLElement>('.wheel-picker__group')!.hidden) reveal(wheels, currentTile);
    seen?.disconnect();
    seen = new IntersectionObserver(
      (entries, obs) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          obs.unobserve(e.target);
          (e.target as HTMLElement & { load?: () => void }).load?.();
        }
      },
      { root: wheels, rootMargin: '160px 0px' },
    );
    for (const t of tiles) seen.observe(t);
  });
  return h('div', { class: 'wheel-picker' }, makers, wheels);
}
