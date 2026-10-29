/**
 * The Wheels tab's wheel picker: two panes side by side, filling the tab.
 * Down the left the makers (All first, then each maker with its count; a dot
 * on the maker of the wheel fitted), one tap to show just theirs. On the right
 * the wheels as tiles of their thumbnails (wheelThumbs.ts), two to a row so
 * the thumbnails read, under a heading per maker that sticks to the top of the
 * pane as that maker's wheels scroll by, so under All the hundred wheels still
 * say where you are. Makers and wheels alphabetical, a neutral order with no
 * ranking. The picker opens scrolled to the wheel fitted (and the makers to
 * its maker), and a tile asks for its thumbnail only as it scrolls into the
 * pane, so a maker's dozen wheels load, not all of them.
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

/** The last picker's tile watcher: one picker is up at a time, so a new one lets go of the last one's tiles. */
let seen: IntersectionObserver | null = null;

export interface WheelPickerOptions {
  wheels: PartEntry[];
  /** The wheel the axle on show wears. */
  current: string;
  /** The maker on show, or null for All. */
  maker: string | null;
  thumbs: WheelThumbs;
  /** The car's front offset target (mm), so the tiles show each face where this car sets it. */
  target?: number;
  onMaker(maker: string | null): void;
  onPick(id: string): void;
}

export function wheelPicker(o: WheelPickerOptions): HTMLElement {
  const groups = wheelGroups(o.wheels);
  const maker = groups.some(([g]) => g === o.maker) ? o.maker : null;
  const currentGroup = groups.find(([, list]) => list.some((p) => p.id === o.current))?.[0];

  // The makers down the left.
  const makers = h('div', { class: 'wheel-picker__makers', role: 'tablist', 'aria-label': 'Makers', 'aria-orientation': 'vertical' });
  let currentMaker: HTMLElement | null = null;
  const makerBtn = (label: string, value: string | null, count: number) => {
    const on = value === maker;
    const b = h(
      'button',
      { type: 'button', role: 'tab', class: `wheel-picker__maker${on ? ' is-selected' : ''}${value !== null && value === currentGroup ? ' is-current' : ''}`, 'aria-selected': String(on) },
      h('span', { class: 'wheel-picker__maker-name' }, label),
      h('span', { class: 'wheel-picker__count' }, String(count)),
    );
    if (value === currentGroup) b.title = `${label}: the wheel fitted is one of theirs`;
    if (on) currentMaker = b;
    b.addEventListener('click', () => o.onMaker(value));
    return b;
  };
  makers.append(makerBtn('All', null, o.wheels.length), ...groups.map(([g, list]) => makerBtn(g, g, list.length)));

  // The wheels on the right: a heading and a grid per maker shown.
  const wheels = h('div', { class: 'wheel-picker__wheels' });
  const tiles: HTMLElement[] = [];
  let currentTile: HTMLElement | null = null;
  for (const [group, list] of groups) {
    if (maker !== null && group !== maker) continue;
    const grid = h('div', { class: 'wheel-picker__grid' });
    for (const p of list) {
      const t = tile(p, group);
      if (p.id === o.current) currentTile = t;
      grid.append(t);
    }
    wheels.append(h('div', { class: 'wheel-picker__group' }, h('div', { class: 'wheel-picker__head' }, h('span', { class: 'wheel-picker__head-name' }, group), h('span', { class: 'wheel-picker__count' }, `${list.length} ${list.length === 1 ? 'wheel' : 'wheels'}`)), grid));
  }
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
    reveal(wheels, currentTile);
    reveal(makers, currentMaker);
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
