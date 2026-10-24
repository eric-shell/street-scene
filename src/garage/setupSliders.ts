/**
 * The Tune tab's setup sliders (garageUi.ts renderPerformance): suspension, gear ratio, differential and
 * brake balance, each a row of five numbered notches between its two ends (Soft / Stiff ...), with the
 * position and a line saying what it does under them. The notches are the kit's segmented control, so a tap
 * or a click picks one; Left / Right on a focused notch steps it (the keyboard's arrows and the pad's, which
 * input/padNav.ts sends as arrow keys) and Up / Down move on to the next row. Only the picked notch is a tab
 * stop. What each position does is sim/build.ts applyBuild and drivingParams.json `setup`; the lines here
 * say it in a player's words.
 */
import { SETUP_POSITIONS, STOCK_POSITION, type SetupPosition, type SetupSlider } from '../sim/tuning';
import { h, segmented } from '../ui/kit/dom';
import { ArrowUpDown, Disc3, icon, type IconNode } from '../ui/kit/icons';
import { Cog, Split } from 'lucide';

interface SliderCopy {
  name: string;
  icon: IconNode;
  /** The left (position 1) and right (position 5) ends. */
  ends: [string, string];
  /** What each position does, left to right. */
  hints: [string, string, string, string, string];
}

/** The rows in the Tune tab's order, and what each says. */
export const SETUP_COPY: { [S in SetupSlider]: SliderCopy } = {
  suspension: {
    name: 'Suspension',
    icon: ArrowUpDown,
    ends: ['Soft', 'Stiff'],
    hints: [
      'Soft: rides over kerbs and keeps its bite on dirt, grass and cobbles. Leans more, turns in lazily.',
      'Softer: a little more give over kerbs and rough ground.',
      "Stock: the car's own springs and travel.",
      'Stiffer: flatter and quicker to turn in on smooth tarmac.',
      'Stiff: flat and sharp on smooth tarmac, but it skips over dirt and bottoms out on kerbs.',
    ],
  },
  gearing: {
    name: 'Gear ratio',
    icon: Cog,
    ends: ['Short', 'Long'],
    hints: [
      'Short: punchy off the line and out of corners, but top gear hits the limiter early, nitrous too. Tight streets.',
      'Shorter: a little more punch out of corners; the limiter sits right at the top speed.',
      "Stock: the car's own gearing; top gear runs out just past a slipstream's top speed.",
      'Longer: a touch lazier out of corners, more room past the limiter on nitrous.',
      'Long: lazy out of corners, but nitrous keeps pulling past the stock limiter to a higher top speed. Long straights.',
    ],
  },
  differential: {
    name: 'Differential',
    icon: Split,
    ends: ['Open', 'Locked'],
    hints: [
      'Open: steady in turns, but the drive fades as the inside wheel lifts, and slides die out.',
      'Looser: slides fade sooner, a little less drive out of tight turns.',
      'Stock: the driven wheels pull together and share the grip.',
      'Tighter: a touch of push on turn in, a harder drive out of the turn.',
      'Locked: the driven wheels turn as one. Pushes on turn in, drives hard out and holds a slide.',
    ],
  },
  brakeBalance: {
    name: 'Brake balance',
    icon: Disc3,
    ends: ['Rear', 'Front'],
    hints: [
      'Rear: the car rotates on the brakes into a turn, but stops longer.',
      'Rearward: a little more rotation on the brakes.',
      "Stock: the car's own brake balance.",
      'Forward: steadier on the brakes, a little push into turns.',
      'Front: stops short and straight; brake into a turn and the nose runs wide.',
    ],
  },
};

const ARROWS: Record<string, -1 | 1> = { ArrowLeft: -1, ArrowRight: 1 };

/** The readout under a row: the position and its end (or stock). */
function positionLabel(copy: SliderCopy, p: SetupPosition): string {
  return `${p} · ${p === STOCK_POSITION ? 'Stock' : copy.ends[p < STOCK_POSITION ? 0 : 1]}`;
}

/** One slider's row. `onPick` gets each new position; the row updates itself, so focus stays where it is. */
export function setupSlider(which: SetupSlider, value: SetupPosition, onPick: (p: SetupPosition) => void): HTMLElement {
  const copy = SETUP_COPY[which];
  let pos = value;
  const readout = h('span', { class: 'garage-value' });
  const hint = h('div', { class: 'setup-slider__hint muted' });
  const notches = segmented(
    SETUP_POSITIONS.map((p) => ({ value: String(p), label: String(p) })),
    String(value),
    (x) => pick(Number(x) as SetupPosition),
    '--wide setup-slider__notches',
  );
  notches.setAttribute('aria-label', `${copy.name}: ${copy.ends[0]} to ${copy.ends[1]}`);
  const buttons = [...notches.querySelectorAll<HTMLButtonElement>('.segmented__option')];
  const show = () => {
    readout.textContent = positionLabel(copy, pos);
    hint.textContent = copy.hints[pos - 1];
    buttons.forEach((b, i) => {
      const on = SETUP_POSITIONS[i] === pos;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.setAttribute('aria-label', positionLabel(copy, SETUP_POSITIONS[i]));
    });
  };
  const pick = (p: SetupPosition) => {
    if (p === pos) return;
    pos = p;
    notches.set(String(p));
    show();
    onPick(p);
  };
  // Left / Right step the slider from a focused notch and keep focus on the picked one. Taken here, they do not
  // also steer the car on the turntable, and padNav sees the press as handled.
  notches.addEventListener('keydown', (e) => {
    const d = ARROWS[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const p = Math.max(1, Math.min(SETUP_POSITIONS.length, pos + d)) as SetupPosition;
    pick(p);
    buttons[p - 1].focus();
  });
  show();
  return h(
    'div',
    { class: 'setup-slider' },
    h('div', { class: 'setup-slider__head' }, h('span', { class: 'setup-slider__name' }, icon(copy.icon, { size: 15 }), copy.name), readout),
    h('div', { class: 'setup-slider__track' }, h('span', { class: 'setup-slider__end' }, copy.ends[0]), notches, h('span', { class: 'setup-slider__end setup-slider__end--right' }, copy.ends[1])),
    hint,
  );
}
