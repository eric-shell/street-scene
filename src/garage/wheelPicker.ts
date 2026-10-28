/**
 * The Wheels tab's wheel picker: the makers as a row of filter buttons (All
 * first, each with its count; a dot on the maker of the wheel in use), then
 * the wheels as tiles of their thumbnails (wheelThumbs.ts) with the name and
 * maker under each, several to a row: one grid however the makers split (most
 * have a single wheel), makers and wheels alphabetical, a neutral order with
 * no ranking. A tile
 * asks for its thumbnail only once it scrolls into view, so a maker's dozen
 * wheels load, not all of them.
 */
import type { PartEntry } from '../shared/parts';
import { h, sheen } from '../ui/kit/dom';
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

/** Tiles ask for their thumbnails as they come near the tab's scrolling view. */
let seen: IntersectionObserver | null = null;
function watcher(): IntersectionObserver {
  return (seen ??= new IntersectionObserver(
    (entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.unobserve(e.target);
        (e.target as HTMLElement & { load?: () => void }).load?.();
      }
    },
    { rootMargin: '160px 0px' },
  ));
}

export interface WheelPickerOptions {
  wheels: PartEntry[];
  /** The wheel the axle on show wears. */
  current: string;
  /** The maker on show, or null for All. */
  maker: string | null;
  thumbs: WheelThumbs;
  onMaker(maker: string | null): void;
  onPick(id: string): void;
}

export function wheelPicker(o: WheelPickerOptions): HTMLElement {
  const groups = wheelGroups(o.wheels);
  const maker = groups.some(([g]) => g === o.maker) ? o.maker : null;
  const currentGroup = groups.find(([, list]) => list.some((p) => p.id === o.current))?.[0];
  const makerBtn = (label: string, value: string | null, count: number) => {
    const b = h(
      'button',
      { type: 'button', class: `wheel-picker__maker${value === maker ? ' is-selected' : ''}${value !== null && value === currentGroup ? ' is-current' : ''}`, 'aria-pressed': String(value === maker) },
      label,
      h('span', { class: 'wheel-picker__count' }, String(count)),
    );
    if (value === currentGroup) b.title = `${label}: the wheel fitted is one of theirs`;
    b.addEventListener('click', () => o.onMaker(value));
    return b;
  };
  const grid = h('div', { class: 'wheel-picker__grid' });
  // One picker is up at a time: a new one lets go of the last one's tiles.
  const watch = watcher();
  watch.disconnect();
  for (const [group, list] of groups) {
    if (maker !== null && group !== maker) continue;
    for (const p of list) grid.append(tile(p, group));
  }
  function tile(p: PartEntry, group: string): HTMLElement {
    const img = h('img', { class: 'wheel-picker__thumb', alt: '', draggable: 'false' }) as HTMLImageElement;
    const el = h(
      'button',
      { type: 'button', class: `wheel-picker__tile${p.id === o.current ? ' is-selected' : ''}`, title: `${group} ${p.displayName}`, 'aria-pressed': String(p.id === o.current) },
      h('span', { class: 'wheel-picker__frame' }, img),
      h('span', { class: 'wheel-picker__name' }, p.displayName),
      h('span', { class: 'wheel-picker__maker-name' }, group),
      sheen(),
    );
    Object.assign(el, {
      load: () =>
        void o.thumbs.thumb(p).then((url) => {
          if (!url) return;
          img.src = url;
          el.classList.add('is-loaded');
        }),
    });
    watch.observe(el);
    el.addEventListener('click', () => {
      grid.querySelectorAll('.wheel-picker__tile.is-selected').forEach((x) => {
        x.classList.remove('is-selected');
        x.setAttribute('aria-pressed', 'false');
      });
      el.classList.add('is-selected');
      el.setAttribute('aria-pressed', 'true');
      o.onPick(p.id);
    });
    return el;
  }
  return h('div', { class: 'wheel-picker' }, h('div', { class: 'wheel-picker__makers' }, makerBtn('All', null, o.wheels.length), ...groups.map(([g, list]) => makerBtn(g, g, list.length))), grid);
}
