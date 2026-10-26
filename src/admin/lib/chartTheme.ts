/**
 * Every color a dashboard chart paints, in one place, read from the game's palette (ui/kit/palette.ts, the same
 * values as the stylesheet's _palette.scss) so a chart can never drift from the rest of the UI.
 *
 * Validated on the card surface (#221f22, --bg1) with the dataviz skill's validate_palette.js:
 *
 * - Magnitude and order are ONE hue, the game's orange accent, stepped down in OKLCH lightness to DEEP:
 *   `#fc9867 → #985432` passes `--ordinal --mode dark` (monotone L, single hue). Five rank steps across the
 *   whole ramp as ordinalStep computes them (`#fc9867,#e28659,#c9754c,#b0643f,#985432`, the funnel) pass with
 *   adjacent ΔL ≥ 0.06 and the deep end at 2.84:1, so every funnel bar also carries its number. Magnitude steps
 *   start at MAGNITUDE_FLOOR, where the dimmest bar is `#ab613c` at 3.50:1, over the 3:1 floor for a mark that
 *   must be found; the viewport ring's three steps (`#fc9867,#d37c51,#ab613c`) pass as an ordinal set too.
 * - The race types wear palette.$modes, because those are the colors the game teaches for them (menu cards,
 *   chips, course lines). As a categorical set they FAIL the validator's dark lightness band (Monokai Pro is
 *   pastel: L 0.71 to 0.89, above the 0.48 to 0.67 band) and cyan sits just under the chroma floor (0.095), but
 *   they PASS adjacent CVD separation (worst sprint↔circuit ΔE 12.3 deutan), the normal-vision floor (15.9) and
 *   3:1 contrast. So a mode is never named by color alone: every mode mark sits in its own labelled row with
 *   the mode's icon and word, and the chart is per-mode rows (small multiples), never a legend lookup.
 * - Frame-rate status (holds 60, under 60, under 30) is NOT a fill: the game's green and yellow collapse under
 *   protanopia (ΔE 2.9) and fall under the normal-vision floor (11.3). Frame-rate bars are the single orange
 *   series against the hold and floor lines; the status is a word with an icon, inked green, yellow or red.
 * - No glows: the game's UI is flat accent fills and hairlines, never soft halos (ui/styles/main.scss).
 */
import { PALETTE, type PaletteColor } from '../../ui/kit/palette';
import { MODES, isMode } from './gameVocab';

/** The series color: the game's primary accent. 7.63:1 on the card surface. */
export const ACCENT = PALETTE.orange;
/** The deep end of the accent ramp: the orange at OKLCH L 0.52 with three quarters of its chroma. 2.84:1. */
export const DEEP = '#985432';
/** The card the marks sit on, for seams between ring segments. */
export const SURFACE = PALETTE.bg1;
/** Hairlines: the chart grid and baselines, and the unfilled track behind a bar. */
export const HAIRLINE = 'rgba(252, 252, 250, 0.16)';
export const TRACK = 'rgba(252, 252, 250, 0.07)';

/** Where the smallest non-zero magnitude sits on the ramp (0 DEEP, 1 ACCENT): keeps the dimmest bar over 3:1. */
export const MAGNITUDE_FLOOR = 0.2;

type Oklch = readonly [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
};

function toOklch(hex: string): Oklch {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function toHex([L, C, H]: Oklch): string {
  const A = C * Math.cos(H);
  const B = C * Math.sin(H);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return '#' + rgb.map((c) => fromLinear(c).toString(16).padStart(2, '0')).join('');
}

const ACCENT_LCH = toOklch(ACCENT);
const DEEP_LCH = toOklch(DEEP);

/** A step of the accent ramp, `t` from 0 (DEEP) to 1 (ACCENT), interpolated in OKLCH as the validated steps were. */
export function ordinalStep(t: number): string {
  const k = Math.min(1, Math.max(0, t));
  return toHex([DEEP_LCH[0] + (ACCENT_LCH[0] - DEEP_LCH[0]) * k, DEEP_LCH[1] + (ACCENT_LCH[1] - DEEP_LCH[1]) * k, ACCENT_LCH[2]]);
}

/**
 * A bar's step by its share of the largest bar: the peak is ACCENT, the tail runs deep. It re-encodes what the
 * length says on purpose: on 8 px rows a 3 px bar and a 5 px bar are the same bar, and the shade separates them.
 * Zero returns DEEP; callers dim it, because "none" is a state, not a small value.
 */
export function magnitudeStep(value: number, max: number): string {
  if (value <= 0 || max <= 0) return DEEP;
  return ordinalStep(MAGNITUDE_FLOOR + (1 - MAGNITUDE_FLOOR) * Math.min(1, value / max));
}

/**
 * A step by rank across the WHOLE ramp: rank 0 is ACCENT, the last DEEP. For short ordered series whose values
 * bunch (a funnel that drops steeply would put every step at the bottom of a magnitude ramp). It throws away
 * the size of the gaps, so only where the bar length already carries the magnitude.
 */
export function rankStep(rank: number, count: number): string {
  if (count <= 1) return ACCENT;
  return ordinalStep((count - 1 - Math.min(Math.max(rank, 0), count - 1)) / (count - 1));
}

/**
 * Steps for the segments of one ring, ranked by VALUE: the largest is always the brightest, so shade reads as
 * amount on a proportional ring; ties take adjacent ranks, since equal segments that touch would merge. A
 * segment's shade therefore moves with the data and the legend carries the identity, in words.
 */
export function magnitudeRamp(values: number[]): string[] {
  const rankOf = new Array<number>(values.length);
  values
    .map((value, i) => ({ value, i }))
    .sort((a, b) => b.value - a.value)
    .forEach((entry, rank) => (rankOf[entry.i] = rank));
  return values.map((_, i) => ordinalStep(MAGNITUDE_FLOOR + (1 - MAGNITUDE_FLOOR) * (values.length <= 1 ? 1 : (values.length - 1 - rankOf[i]) / (values.length - 1))));
}

/** A race type's color (palette.$modes); an unknown mode is the neutral line color. */
export function modeColor(mode: string): string {
  return isMode(mode) ? PALETTE[MODES[mode].ink] : PALETTE.muted;
}

/** A palette color by name, for the few marks that wear a semantic hue. */
export function paletteColor(name: PaletteColor): string {
  return PALETTE[name];
}

/** Ring geometry in a 0-100 viewBox, shared by the ring and its skeleton so the placeholder cannot drift from it. */
export const RING_R = 42;
export const RING_STROKE = 9;

/** Read once: charts only need it to decide whether to run an entrance transition at all. */
export const PREFERS_REDUCED_MOTION = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A source row for display. An empty host is a session with no referrer and no campaign: typed, bookmarked or a
 * stripped link, which is genuinely direct. This page's own host is an internal navigation that started a fresh
 * session, a different thing again.
 */
export function labelSource(host: string): string {
  if (!host) return 'Direct / none';
  if (typeof window !== 'undefined' && host === window.location.hostname.replace(/^www\./, '')) return `${host} (internal)`;
  return host;
}

/**
 * The reader's whole-hour offset from UTC, or null in a half-hour zone (India, Nepal, parts of Australia): the
 * hourly chart buckets in UTC, and a half-hour zone cannot be shifted without misplacing counts, so its axis says
 * UTC instead of quietly showing the wrong hour.
 */
export function localHourOffset(): number | null {
  const minutes = -new Date().getTimezoneOffset();
  return minutes % 60 === 0 ? minutes / 60 : null;
}

/** `0` → `12am`, `13` → `1pm`: compact enough for a 24-column axis. */
export function formatHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}
