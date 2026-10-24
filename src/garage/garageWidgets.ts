/**
 * The controls the garage's tabs and cards are made of: a titled section, color
 * wells with their preset swatches, the paint picker (finish, accent and
 * metal), the link toggle, labelled sliders, the choice list, and the stat
 * lines the build card and the Tune tab share. Plain DOM built with the kit's
 * helpers; the garage partials beside this file style them.
 */
import { CarBuild, PAINT_FINISHES, Paint, AccentPaint } from '../shared/carBuild';
import { SETUP_SLIDERS } from '../sim/tuning';
import { tuningForBuild } from '../sim/build';
import type { SpecBadge } from '../shared/carSpec';
import { measureStats, statBars } from '../sim/stats';
import type { CarStats } from '../sim/stats';
import { btn, h, segmented, sheen, specChip } from '../ui/kit/dom';
import { KMH_PER_MPH } from '../ui/kit/units';
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

/** A swatch: a chamfered chip of color, marked while it is the color in use. */
function swatch(hex: string, current: string, onPick: (el: HTMLElement) => void): HTMLElement {
  const s = h('button', { type: 'button', class: `garage-swatch${hex.toLowerCase() === current.toLowerCase() ? ' is-selected' : ''}`, style: `--swatch:${hex}`, title: hex, 'aria-label': hex }, sheen());
  s.addEventListener('click', () => onPick(s));
  return s;
}

export function color(value: string, onInput: (c: string) => void): HTMLInputElement {
  const el = h('input', { type: 'color', value }) as HTMLInputElement;
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

/**
 * Preset swatches per colored surface: the body's loud street colors (two rows), wheel metals, caliper brights,
 * neon. The swatches sit nine to a row (_garage-swatch.scss), so every list is a multiple of nine: no row half full.
 */
export const PRESETS = {
  body: [
    ...['#d11f3f', '#ff6a00', '#ffcc1f', '#3dff9a', '#19e6ff', '#1f6bff', '#8b3dff', '#ff3df2', '#f2f2f2'],
    ...['#7a0f22', '#b84a12', '#c9a227', '#1f7a4d', '#0f6f80', '#14306e', '#9aa3ad', '#2a2c33', '#0b0b0d'],
  ],
  wheels: ['#c9ced8', '#e8eaee', '#7d838c', '#3a3d44', '#1a1b1f', '#f2f2f2', '#b08d57', '#d4af37', '#d11f3f'],
  calipers: ['#c41e3a', '#ffcc1f', '#ff6a00', '#1f6bff', '#3dff9a', '#ff3df2', '#d4af37', '#f2f2f2', '#1a1b1f'],
  glow: ['#00e5ff', '#ff3df2', '#7cff4f', '#ffe14d', '#ff2e5b', '#7a5cff', '#ffffff', '#ff8a00', '#ff1a1a'],
} as const;

/**
 * A color well and its preset swatches, kept in step: a swatch sets the well and is marked, a color from
 * the well marks none. `preset` says whether a swatch picked it.
 */
export function colorPicker(value: string, presets: readonly string[], onInput: (c: string, preset: boolean) => void): HTMLElement {
  const sw = h('div', { class: 'garage-swatches' });
  const well = color(value, (c) => {
    sw.querySelectorAll('.garage-swatch.is-selected').forEach((x) => x.classList.remove('is-selected'));
    onInput(c, false);
  });
  for (const p of presets) {
    sw.append(
      swatch(p, value, (s) => {
        well.value = p;
        sw.querySelectorAll('.garage-swatch').forEach((x) => x.classList.toggle('is-selected', x === s));
        onInput(p, true);
      }),
    );
  }
  return h('div', { class: 'row' }, well, sw);
}

/**
 * Every paint's controls (body, wheels, calipers): its color over its finish, edited in place, then onChange.
 * An accent (wheels, calipers) gets a Match body toggle beside any `tools`: matched, it wears the body's paint
 * and shows that instead of its controls; unmatched, it starts from the body's paint, so nothing jumps.
 */
export function paintPicker(paint: Paint | AccentPaint, presets: readonly string[], onChange: () => void, accent?: { body: Paint; tools?: Node[] }): HTMLElement {
  const root = h('div', { class: 'garage-paint' });
  const a = accent && 'match' in paint ? paint : null;
  const draw = () => {
    const tools: Node[] = [...(accent?.tools ?? [])];
    if (accent && a) {
      tools.push(
        toggle(Paintbrush, 'Match body', a.match, a.match ? 'Wearing the body paint' : 'Wear the body paint', () => {
          a.match = !a.match;
          if (!a.match) Object.assign(a, { color: accent.body.color, finish: accent.body.finish });
          onChange();
          draw();
        }),
      );
    }
    root.replaceChildren(
      ...(tools.length ? [h('div', { class: 'row' }, ...tools)] : []),
      ...(accent && a?.match
        ? [h('div', { class: 'muted garage-note' }, h('span', { class: 'garage-dot', style: `background:${accent.body.color}` }), `Body paint · ${capital(accent.body.finish)}`)]
        : [
            colorPicker(paint.color, presets, (c) => {
              paint.color = c;
              onChange();
            }),
            segmented(
              PAINT_FINISHES.map((f) => ({ value: f, label: capital(f) })),
              paint.finish,
              (f) => {
                paint.finish = f;
                onChange();
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
