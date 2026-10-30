/**
 * The controls the garage's tabs and cards are made of: a titled section, the
 * one color picker every color in the garage is chosen with (a well beside the
 * shared palette of swatches), the paint picker (that color over a finish, and
 * the matches a surface can wear instead: the body's paint, the wheel's, the
 * center cap's), the link toggle, labelled sliders, the choice
 * list, and the stat lines the build card and the Power and Tune tabs share; and the parts
 * economy's two pieces (shared/economy.ts): a part's tag (owned, its price, or
 * the races that unlock it) and the points counter that rolls down on a buy.
 * Plain DOM built with the kit's helpers; the garage partials beside this file
 * style them.
 */
import { CHROME_COLOR, CarBuild, Paint, AccentPaint, AccentFinish } from '../shared/carBuild';
import { SETUP_SLIDERS } from '../sim/tuning';
import { tuningForBuild } from '../sim/build';
import type { SpecBadge } from '../shared/carSpec';
import { measureStats, statBars } from '../sim/stats';
import type { CarStats } from '../sim/stats';
import { btn, cycler, h, prefersReducedMotion, selectMenu, sheen, specChip } from '../ui/kit/dom';
import { KMH_PER_MPH, horsepower, pounds } from '../ui/kit/units';
import { Coins, Lock, icon, type IconNode } from '../ui/kit/icons';
import { formatPoints } from '../ui/kit/format';
import type { PartEntry } from '../shared/parts';
import { priceOf, racesToUnlock } from '../shared/economy';
import { owns, type PurchasesSave } from '../shared/purchases';
import type { StatsSave } from '../shared/stats';
import { FEATURES } from '../shared/features';

/** A label from a lower case id: "metallic" reads "Metallic". */
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Measured stats per car and performance build (its engine swap, setup and launch rpm): measuring drives the sim for up to a minute of game time. */
const statsCache = new Map<string, CarStats>();
function statsFor(b: CarBuild): CarStats {
  const key = `${b.carId}:${b.performance.swap ?? ''}:${SETUP_SLIDERS.map((s) => b.performance[s]).join('')}:${b.performance.launchRpm}`;
  let st = statsCache.get(key);
  if (!st) statsCache.set(key, (st = measureStats(tuningForBuild(b.carId, b.performance))));
  return st;
}

/** A stat line: its ink (`.ink-*` in _tune-stat.scss), its bar, its name and its value. */
interface Stat {
  ink: string;
  bar: keyof ReturnType<typeof statBars>;
  name: string;
  value: (s: CarStats) => string;
}

/** The measured stats the build card and the Power and Tune tabs show, in order, each bar in its ink. */
const STATS: readonly Stat[] = [
  { ink: 'speed', bar: 'topSpeed', name: 'Top speed', value: (s) => `${Math.round(s.topSpeed / KMH_PER_MPH)} mph` },
  { ink: 'accel', bar: 'acceleration', name: '0-60', value: (s) => `${s.zeroTo60.toFixed(2)} s` },
  { ink: 'grip', bar: 'handling', name: 'Grip', value: (s) => `${s.grip.toFixed(2)} g` },
  { ink: 'nitrous', bar: 'nitrous', name: 'Nitrous', value: (s) => `${s.nitrous.toFixed(1)} kN·s` },
  { ink: 'power', bar: 'power', name: 'Power', value: (s) => `${Math.round(horsepower(s.power))} hp` },
];

/** The weight line, on the Power and Tune tabs only (a swap moves it; the build card keeps to how the car goes). */
const WEIGHT: Stat = { ink: 'weight', bar: 'weight', name: 'Weight', value: (s) => `${Math.round(pounds(s.mass)).toLocaleString('en-US')} lb` };

/** A build's measured stats: a line each, the measure, its bar in its ink and the value in yellow; `weight` adds the car's weight last. */
export function statLines(b: CarBuild, opts: { weight?: boolean } = {}): HTMLElement {
  const st = statsFor(b);
  const bars = statBars(st);
  return h(
    'div',
    { class: 'car-card__stats' },
    ...(opts.weight ? [...STATS, WEIGHT] : STATS).map((t) =>
      h('div', { class: `car-card__stat ink-${t.ink}` }, h('span', { class: 'car-card__stat-name' }, t.name), h('span', { class: 'stat-bar' }, h('span', { class: 'stat-bar__fill', style: `width:${bars[t.bar] * 100}%` })), h('span', { class: 'car-card__stat-value' }, t.value(st))),
    ),
  );
}

export type Child = Node | false | null;

/**
 * A group: a plate with the tab's hue on its hairline, a section title (the
 * menu cards' yellow caps over a hairline) and its controls. Icons are for the
 * tabs only.
 */
export const section = (label: string, ...children: Child[]) => h('div', { class: 'garage-section' }, h('div', { class: 'section-title' }, label), ...children);

/**
 * Mark a piece a toggle shows or hides (the colors chrome hides, the Front / Rear switch the Link hides) with a key
 * naming it among its redraw's pieces, so revealNew slides it open when a redraw brings it and closed when one takes it.
 */
export function revealable<T extends HTMLElement>(el: T, key: string): T {
  el.dataset.reveal = key;
  return el;
}

/** The slide every toggle in the garage shares (revealNew): its length (ms) and the --ease-out curve (base/_tokens.scss). */
const REVEAL = { ms: 300, ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)' } as const;

/** An element's place under `root` as child indexes, so a redraw's matching parent can be found again. */
function pathFrom(root: Element, el: Element): number[] {
  const path: number[] = [];
  for (let at: Element = el; at !== root && at.parentElement; at = at.parentElement) path.unshift([...at.parentElement.children].indexOf(at));
  return path;
}

/** The flex gap above a piece (its nearest boxed ancestor's row gap), which an opening or closing piece slides in or out with it. */
function gapAbove(el: Element): number {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.display !== 'contents') return parseFloat(cs.rowGap) || 0;
  }
  return 0;
}

/** Slide a piece open (`open`) from nothing or closed to nothing: height, the gap above it and opacity together. */
function slide(el: HTMLElement, height: number, open: boolean): Animation {
  const shut = { height: '0px', marginTop: `${-gapAbove(el)}px`, opacity: 0 };
  const full = { height: `${height}px`, marginTop: '0px', opacity: 1 };
  el.style.overflow = 'hidden';
  const a = el.animate(open ? [shut, full] : [full, shut], { duration: REVEAL.ms, easing: REVEAL.ease, fill: open ? 'none' : 'forwards' });
  a.onfinish = a.oncancel = () => {
    el.style.overflow = '';
  };
  return a;
}

/**
 * Redraw `root` with `draw`, sliding toggled pieces like a slide toggle: each revealable the redraw brought (by
 * key) opens from nothing as it fades in, and each it took away stays where it stood, inert, while it closes and
 * fades out, so the rows around them glide instead of jumping. One slide for every toggle in the garage; reduced
 * motion just redraws.
 */
export function revealNew(root: HTMLElement, draw: () => void): void {
  const keyed = () => [...root.querySelectorAll<HTMLElement>('[data-reveal]')];
  if (prefersReducedMotion()) return draw();
  // Before: each piece's key, place and height, so one the redraw drops can stand in its old place as it closes.
  const before = keyed().map((el) => ({ el, key: el.dataset.reveal!, path: pathFrom(root, el), height: el.getBoundingClientRect().height }));
  draw();
  const after = keyed();
  const kept = new Set(after.map((el) => el.dataset.reveal));
  const had = new Set(before.map((b) => b.key));
  for (const el of after) if (!had.has(el.dataset.reveal!)) slide(el, el.getBoundingClientRect().height, true);
  for (const b of before) {
    if (kept.has(b.key) || !root.isConnected) continue;
    // Back where it stood: under the redraw's parent at the same place, out of the keys and the focus order.
    let parent: Element | undefined = root;
    for (const i of b.path.slice(0, -1)) parent = parent?.children[i];
    if (!parent) continue;
    const ghost = b.el;
    delete ghost.dataset.reveal;
    ghost.inert = true;
    ghost.setAttribute('aria-hidden', 'true');
    parent.insertBefore(ghost, parent.children[b.path[b.path.length - 1]] ?? null);
    slide(ghost, b.height, false).finished.then(() => ghost.remove(), () => ghost.remove());
  }
}

/** A group with controls at the right end of its title, past the hairline (the Link toggles). */
export function sectionWith(label: string, aside: Node[], ...children: Child[]): HTMLElement {
  const el = section(label, ...children);
  el.querySelector('.section-title')!.append(h('span', { class: 'garage-section__aside' }, ...aside));
  return el;
}

/** A name over a control too tall for a row (a color picker): the rows' name, on a line of its own. */
export const rowName = (label: string) => h('span', { class: 'garage-row__name' }, label);

/** A line of help under a group's controls. */
export const note = (text: string) => h('div', { class: 'muted garage-note' }, text);

/** A swatch: a chamfered chip of color, marked while it is the color in use. */
function swatch(hex: string, current: string, onPick: (el: HTMLElement) => void): HTMLElement {
  const s = h('button', { type: 'button', class: `garage-swatch${hex.toLowerCase() === current.toLowerCase() ? ' is-selected' : ''}`, style: `--swatch:${hex}`, title: hex, 'aria-label': hex }, sheen());
  s.addEventListener('click', () => onPick(s));
  return s;
}

/** The color well on its own (the picker's). */
function well(value: string, onInput: (c: string) => void): HTMLInputElement {
  const el = h('input', { type: 'color', value }) as HTMLInputElement;
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

/**
 * The one palette every color in the garage is picked from (body, trim, wheels, calipers, tint, underglow,
 * vinyls), nine to a row (_garage-swatch.scss): the loud street colors, the deep ones, then the neutrals and
 * metals. One list everywhere, so a color found on one surface is a tap away on every other; the rows are named
 * for the random builds, which draw a body from the colors and a wheel from the metals.
 */
export const SWATCHES = {
  loud: ['#d11f3f', '#ff6a00', '#ffcc1f', '#7cff4f', '#3dff9a', '#19e6ff', '#1f6bff', '#8b3dff', '#ff3df2'],
  deep: ['#7a0f22', '#b84a12', '#c9a227', '#4f6b1f', '#1f7a4d', '#0f6f80', '#14306e', '#4b1a7a', '#a3124f'],
  metal: ['#f2f2f2', '#e8eaee', '#c9ced8', '#9aa3ad', '#3a3d44', '#1a1b1f', '#0b0b0d', '#d4af37', '#b08d57'],
} as const;
export const PALETTE: readonly string[] = [...SWATCHES.loud, ...SWATCHES.deep, ...SWATCHES.metal];

/**
 * A color: the well beside the palette's swatches, kept in step. A swatch sets the well and is marked, a color
 * from the well marks none. `preset` says whether a swatch picked it.
 */
export function colorPicker(value: string, onInput: (c: string, preset: boolean) => void): HTMLElement {
  const sw = h('div', { class: 'garage-swatches' });
  const w = well(value, (c) => {
    sw.querySelectorAll('.garage-swatch.is-selected').forEach((x) => x.classList.remove('is-selected'));
    onInput(c, false);
  });
  for (const p of PALETTE) {
    sw.append(
      swatch(p, value, (s) => {
        w.value = p;
        sw.querySelectorAll('.garage-swatch').forEach((x) => x.classList.toggle('is-selected', x === s));
        onInput(p, true);
      }),
    );
  }
  return h('div', { class: 'garage-color' }, w, sw);
}

/**
 * Another paint a surface can wear instead of its own (the body's, the wheel's, the center cap's, the lip as the
 * wheel ships it): a toggle in the picker's row. At most one of a picker's matches is on.
 */
export interface PaintMatch {
  /** Its option's label in the picker's dropdown ("Match body"). */
  label: string;
  /** What the surface wears while on ("Body paint"); the dropdown shows its color. */
  wears: () => { name: string; paint: Paint<AccentFinish> };
  on: () => boolean;
  /** Turn it on (any other match goes off) or off (the surface takes back a paint of its own). */
  set: (on: boolean) => void;
}

/** Match body for an accent (wheels, calipers): matched, it follows the body; unmatched, it starts from the body's paint, so nothing jumps. */
export function matchBody<F extends AccentFinish>(a: AccentPaint<F>, body: Paint): PaintMatch {
  return {
    label: 'Match body',
    wears: () => ({ name: 'Body paint', paint: body }),
    on: () => a.match,
    set: (on) => {
      a.match = on;
      if (!on) Object.assign(a, { color: body.color, finish: body.finish });
    },
  };
}

/**
 * A paint's controls (body, wheels and their trims, calipers): its color over its finish (`finishes`: the ones this
 * surface takes; the body has no chrome), edited in place, then onChange. With `matches` (Stock chrome, Match body,
 * Match wheel...) a dropdown leads, Custom first: a match wears that paint and hides the controls, Custom brings them
 * back. Each option shows the color it wears. Chrome is one look with no color (CHROME_COLOR), so the color picker
 * hides while it is chosen. What a pick shows or hides slides (revealNew).
 */
export function paintPicker<F extends AccentFinish>(paint: Paint<F>, finishes: readonly F[], onChange: () => void, matches: PaintMatch[] = []): HTMLElement {
  const root = h('div', { class: 'garage-paint' });
  const draw = () => {
    const active = matches.find((m) => m.on());
    root.replaceChildren(
      ...(matches.length
        ? [
            field(
              'Paint',
              selectMenu(
                [{ value: 'custom', label: 'Custom', swatch: paint.color }, ...matches.map((m, i) => ({ value: String(i), label: m.label, swatch: m.wears().paint.color }))],
                active ? String(matches.indexOf(active)) : 'custom',
                (v) => {
                  if (v === 'custom') active?.set(false);
                  else matches[Number(v)].set(true);
                  onChange();
                  revealNew(root, draw);
                },
                'What this surface wears',
              ),
            ),
          ]
        : []),
      ...(active
        ? []
        : [
            ...(paint.finish === 'chrome'
              ? []
              : [
                  revealable(
                    colorPicker(paint.color, (c) => {
                      paint.color = c;
                      // Custom's chip in the dropdown follows the color picked.
                      root.querySelector<HTMLElement>('.dropdown__summary > .dropdown__swatch')?.style.setProperty('background', c);
                      onChange();
                    }),
                    'colors',
                  ),
                ]),
            revealable(
              cycler(
              finishes.map((f) => ({ value: f, label: capital(f) })),
              paint.finish,
              (f) => {
                // Into or out of chrome the picker comes or goes; leaving chrome starts from its silver.
                const swap = (f === 'chrome') !== (paint.finish === 'chrome');
                paint.finish = f;
                if (f === 'chrome') paint.color = CHROME_COLOR;
                onChange();
                if (!swap) return;
                // The redraw replaces the cycler: focus follows to the new one, so the keys keep stepping it.
                const focused = root.contains(document.activeElement);
                revealNew(root, draw);
                if (focused) root.querySelector<HTMLElement>('.cycler')?.focus({ preventScroll: true });
              },
              ),
              'finish',
            ),
          ]),
    );
  };
  draw();
  return root;
}

/**
 * A garage toggle (front and rear linked, match body, mirror): a short label that never changes, so the
 * button keeps its size, lit in the tab's hue while on (_garage-toggle.scss); the title says it in full.
 */
export function toggle(ico: IconNode, label: string, on: boolean, title: string, onClick: () => void): HTMLButtonElement {
  const b = btn(ico, label, onClick, `--small garage-toggle${on ? ' --primary' : ''}`);
  b.title = title;
  b.setAttribute('aria-pressed', String(on));
  return b;
}

/** A row in a group: the name on the left, its control on the right (the settings' rows). */
export const field = (label: string, control: Node) => h('div', { class: 'garage-row' }, h('span', { class: 'garage-row__name' }, label), control);

/** A slider on one line: its name, the track and the value in yellow, so a group of them stays short. */
export function slider(label: string, value: number, min: number, max: number, step: number, fmt: (x: number) => string, onInput: (x: number) => void): HTMLElement {
  const out = h('span', { class: 'garage-value' }, fmt(value));
  const el = h('input', { type: 'range', min, max, step, value, 'aria-label': label }) as HTMLInputElement;
  el.addEventListener('input', () => {
    const x = Number(el.value);
    out.textContent = fmt(x);
    onInput(x);
  });
  return h('label', { class: 'garage-slider' }, h('span', { class: 'garage-slider__name' }, label), el, out);
}

/** One pick in a list: its name, a sub line, and spec tags (drivetrain code, engine) on their own row, each in its ink. */
export interface Choice<T> {
  value: T;
  label: string;
  sub?: string;
  tags?: SpecBadge[];
  /** Extra content after the label (a layer's color dot). */
  extra?: Node;
}

/** A list of picks (`grid`: two to a row), the current one marked; a click marks it and calls onPick. */
export function choiceList<T extends string | number | null>(items: Choice<T>[], current: T, onPick: (x: T) => void, grid = false): HTMLElement {
  const list = h('div', { class: grid ? 'garage-grid' : 'garage-list' });
  for (const it of items) {
    // Hover a spec tag for its long form.
    const tags = it.tags?.length ? h('span', { class: 'garage-item__tags' }, ...it.tags.map((t) => specChip(t, '--small'))) : null;
    const el = h(
      'button',
      { type: 'button', class: `garage-item${it.value === current ? ' is-selected' : ''}${tags ? ' garage-item--car' : ''}` },
      h('span', { class: 'garage-item__label' }, it.label),
      it.sub ? h('span', { class: 'garage-item__sub muted' }, it.sub) : null,
      it.extra ?? null,
      tags,
      sheen(),
    );
    el.addEventListener('click', () => {
      list.querySelectorAll('.garage-item').forEach((x) => x.classList.remove('is-selected'));
      el.classList.add('is-selected');
      onPick(it.value);
    });
    list.append(el);
  }
  return list;
}

/** Slider readouts: a length (m) in cm or mm, a factor as a percent. */
export const cm = (x: number) => `${Math.round(x * 100)} cm`;
export const mm = (x: number) => `${Math.round(x * 1000)} mm`;
export const percent = (x: number) => `${Math.round(x * 100)}%`;

// ---------------------------------------------------------------------------
// The parts economy: what a part costs this car, and the balance
// ---------------------------------------------------------------------------

/** Where a part stands for a car: owned (stock included), buyable at its price, or locked for some more races. */
export type PartTag = { state: 'owned' } | { state: 'buy'; price: number } | { state: 'locked'; races: number; price: number };

/** A part's standing for `carId`, from the ledgers read once per render (`saved`, `stats`). */
export function partTag(carId: string, part: PartEntry, saved: PurchasesSave, stats: StatsSave): PartTag {
  if (owns(carId, part.id, saved)) return { state: 'owned' };
  const price = priceOf(part, carId);
  const races = racesToUnlock(part, stats);
  return races > 0 ? { state: 'locked', races, price } : { state: 'buy', price };
}

/** "3 more races" / "1 more race". */
export const moreRaces = (n: number) => `${n} more ${n === 1 ? 'race' : 'races'}`;

/**
 * A part's tag as a pick shows it (_part-tag.scss): nothing for an owned part in the wheel grid (`quiet`), "Owned"
 * in a list, the price, or a lock with the races still to finish. Null with the economy off: no prices anywhere.
 */
export function partTagEl(tag: PartTag, quiet = false): HTMLElement | null {
  if (!FEATURES.economy) return null;
  if (tag.state === 'owned') return quiet ? null : h('span', { class: 'part-tag part-tag--owned' }, 'Owned');
  if (tag.state === 'locked') return h('span', { class: 'part-tag part-tag--locked', title: `Finish ${moreRaces(tag.races)} to unlock` }, icon(Lock, { size: 12 }), moreRaces(tag.races));
  return h('span', { class: 'part-tag part-tag--price' }, formatPoints(tag.price));
}

/** How long the counter takes to roll to a new balance (s), and how long its flash lasts after (s). */
const COUNTER = { roll: 0.9, flash: 0.9 } as const;

/**
 * The points balance as a live counter (_points-counter.scss): the coin, the number in tabular figures, "pts".
 * `set` rolls the number to a new balance on an eased count (timed, so every frame rate rolls alike) with a
 * brief flash in the accent, red going down (a buy) and green going up; reduced motion jumps straight there.
 */
export class PointsCounter {
  readonly el: HTMLElement;
  private readonly num: HTMLElement;
  private shown: number;
  private raf = 0;
  private flashTimer = 0;

  constructor(value: number, cls = '') {
    this.shown = value;
    this.num = h('b', { class: 'points-counter__value' }, value.toLocaleString());
    this.el = h('span', { class: `points-counter${cls ? ` ${cls}` : ''}`, title: 'Points to spend on parts', 'aria-label': `${value.toLocaleString()} points to spend` }, icon(Coins, { size: 16 }), this.num, h('span', { class: 'points-counter__unit' }, 'pts'));
  }

  set(to: number): void {
    const from = this.shown;
    cancelAnimationFrame(this.raf);
    this.el.setAttribute('aria-label', `${to.toLocaleString()} points to spend`);
    if (to === from) return;
    this.el.classList.remove('is-spent', 'is-earned');
    void this.el.offsetWidth;
    this.el.classList.add(to < from ? 'is-spent' : 'is-earned');
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.el.classList.remove('is-spent', 'is-earned'), (COUNTER.roll + COUNTER.flash) * 1000);
    if (prefersReducedMotion()) {
      this.shown = to;
      this.num.textContent = to.toLocaleString();
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / (COUNTER.roll * 1000));
      const e = 1 - Math.pow(1 - k, 3);
      this.shown = Math.round(from + (to - from) * e);
      this.num.textContent = this.shown.toLocaleString();
      if (k < 1 && this.el.isConnected) this.raf = requestAnimationFrame(step);
      else {
        this.shown = to;
        this.num.textContent = to.toLocaleString();
      }
    };
    this.raf = requestAnimationFrame(step);
  }
}
