/**
 * The controls the garage's tabs and cards are made of: a titled section, the
 * one color picker every color in the garage is chosen with (a well beside the
 * shared palette of swatches), the paint picker (that color over a finish, and
 * the matches a surface can wear instead: the body's paint, the wheel's, the
 * center cap's), the link toggle, labelled sliders, the choice
 * list, and the stat lines the build card and the Tune tab share. Plain DOM
 * built with the kit's helpers; the garage partials beside this file style them.
 */
import { CHROME_COLOR, CarBuild, Paint, AccentPaint, AccentFinish } from '../shared/carBuild';
import { SETUP_SLIDERS } from '../sim/tuning';
import { tuningForBuild } from '../sim/build';
import type { SpecBadge } from '../shared/carSpec';
import { measureStats, statBars } from '../sim/stats';
import type { CarStats } from '../sim/stats';
import { btn, h, segmented, sheen, specChip } from '../ui/kit/dom';
import { KMH_PER_MPH, horsepower } from '../ui/kit/units';
import { Paintbrush, IconNode } from '../ui/kit/icons';

/** A label from a lower case id: "metallic" reads "Metallic". */
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Measured stats per car and performance build (its setup and launch rpm): measuring drives the sim for up to a minute of game time. */
const statsCache = new Map<string, CarStats>();
function statsFor(b: CarBuild): CarStats {
  const key = `${b.carId}:${SETUP_SLIDERS.map((s) => b.performance[s]).join('')}:${b.performance.launchRpm}`;
  let st = statsCache.get(key);
  if (!st) statsCache.set(key, (st = measureStats(tuningForBuild(b.carId, b.performance))));
  return st;
}

/** The measured stats the build card and the Tune tab show, in order, each bar in its ink (`.ink-*` in _tune-stat.scss). */
const STATS: readonly { ink: string; bar: keyof ReturnType<typeof statBars>; name: string; value: (s: CarStats) => string }[] = [
  { ink: 'speed', bar: 'topSpeed', name: 'Top speed', value: (s) => `${Math.round(s.topSpeed / KMH_PER_MPH)} mph` },
  { ink: 'accel', bar: 'acceleration', name: '0-60', value: (s) => `${s.zeroTo60.toFixed(2)} s` },
  { ink: 'grip', bar: 'handling', name: 'Grip', value: (s) => `${s.grip.toFixed(2)} g` },
  { ink: 'nitrous', bar: 'nitrous', name: 'Nitrous', value: (s) => `${s.nitrous.toFixed(1)} kN·s` },
  { ink: 'power', bar: 'power', name: 'Power', value: (s) => `${Math.round(horsepower(s.power))} hp` },
];

/** A build's measured stats: a line each, the measure, its bar in its ink and the value in yellow. */
export function statLines(b: CarBuild): HTMLElement {
  const st = statsFor(b);
  const bars = statBars(st);
  return h(
    'div',
    { class: 'car-card__stats' },
    ...STATS.map((t) =>
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
  /** The toggle's short label ("Match body"). */
  label: string;
  ico?: IconNode;
  /** What the surface wears while on, named in the note that replaces the controls ("Body paint"). */
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
 * A paint's controls (body, trim, wheels and their trims, calipers): its color over its finish (`finishes`: the
 * ones this surface takes; the body has no chrome), edited in place, then onChange. `matches` (Match body, Match
 * wheel...) sit in a row above: while one is on, the surface wears that paint and the picker shows it instead of
 * its controls. Chrome is one look with no color (CHROME_COLOR), so the color picker hides while it is chosen.
 */
export function paintPicker<F extends AccentFinish>(paint: Paint<F>, finishes: readonly F[], onChange: () => void, matches: PaintMatch[] = []): HTMLElement {
  const root = h('div', { class: 'garage-paint' });
  const draw = () => {
    const active = matches.find((m) => m.on());
    const worn = active?.wears();
    root.replaceChildren(
      ...(matches.length
        ? [
            h(
              'div',
              { class: 'row' },
              ...matches.map((m) => {
                const name = m.wears().name.toLowerCase();
                return toggle(m.ico ?? Paintbrush, m.label, m === active, m === active ? `Wearing the ${name}` : `Wear the ${name}`, () => {
                  m.set(m !== active);
                  onChange();
                  draw();
                });
              }),
            ),
          ]
        : []),
      ...(worn
        ? [h('div', { class: 'muted garage-note' }, h('span', { class: 'garage-dot', style: `background:${worn.paint.color}` }), `${worn.name} · ${capital(worn.paint.finish)}`)]
        : [
            ...(paint.finish === 'chrome'
              ? []
              : [
                  colorPicker(paint.color, (c) => {
                    paint.color = c;
                    onChange();
                  }),
                ]),
            segmented(
              finishes.map((f) => ({ value: f, label: capital(f) })),
              paint.finish,
              (f) => {
                // Into or out of chrome the picker comes or goes; leaving chrome starts from its silver.
                const swap = (f === 'chrome') !== (paint.finish === 'chrome');
                paint.finish = f;
                if (f === 'chrome') paint.color = CHROME_COLOR;
                onChange();
                if (swap) draw();
              },
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
    const tags = it.tags?.length ? h('span', { class: 'garage-item__tags' }, ...it.tags.map((t, i) => specChip(t, i, '--small'))) : null;
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

/** Slider readouts: a length (m) in cm, a factor as a percent. */
export const cm = (x: number) => `${Math.round(x * 100)} cm`;
export const percent = (x: number) => `${Math.round(x * 100)}%`;
