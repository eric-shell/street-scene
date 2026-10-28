/**
 * The impact sounds' recipes: which bank each prop kind plays (PROP_SOUND),
 * and the small offline DSP that renders a bank's variants to samples: a Tape
 * of modal rings, filtered noise bursts, pitch-swept thuds, grains and glass,
 * one recipe per bank. Pure apart from Math.random (cosmetic), so the tests
 * render every bank headless; Sfx (sfx.ts) turns the samples into buffers.
 */
import type { ConstructionPropKind, DockPropKind, MarketPropKind, PropKind } from '../city/props';

export type WallHitKind = 'wall' | 'barrier' | 'rail';
/**
 * Prop kinds with their own impact sound (news boxes sound like garbage cans, park lamps like
 * streetlights; construction pieces, most neighbourhood furniture and the night market's pieces
 * borrow the nearest material; a wooden power pole splinters like a crate).
 */
type PropSound = Exclude<PropKind, 'newsBox' | 'parkLamp' | 'bollard' | ConstructionPropKind | MarketPropKind | DockPropKind | 'mailbox' | 'parkingMeter' | 'phoneBooth' | 'vendingMachine' | 'utilityPole'>;
export type SfxBank = 'crash' | WallHitKind | PropSound | 'firework' | 'thump';
type Bank = SfxBank;
export const PROP_SOUND: Record<PropKind, PropSound> = {
  streetlight: 'streetlight',
  trafficLight: 'trafficLight',
  garbageCan: 'garbageCan',
  bench: 'bench',
  busStop: 'busStop',
  bush: 'bush',
  planterPot: 'planterPot',
  cafeTable: 'cafeTable',
  barrel: 'barrel',
  crate: 'crate',
  dumpster: 'dumpster',
  newsBox: 'garbageCan',
  trashBags: 'trashBags',
  parkLamp: 'streetlight',
  bollard: 'streetlight',
  fencePanel: 'bench',
  trafficCone: 'trashBags',
  sawhorse: 'crate',
  waterBarrier: 'barrel',
  sandbags: 'trashBags',
  pallets: 'crate',
  // Dock clutter: a steel drum rings like a bin, a cable spool splinters like a crate.
  drum: 'garbageCan',
  cableSpool: 'crate',
  marketStall: 'cafeTable',
  fruitCrates: 'crate',
  foodCart: 'garbageCan',
  hydrant: 'hydrant',
  parkingMeter: 'trafficLight',
  mailbox: 'garbageCan',
  phoneBooth: 'busStop',
  // A wooden power pole snapping at its base: a big splinter of timber.
  utilityPole: 'crate',
  vendingMachine: 'dumpster',
};

export const rnd = (a: number, b: number) => a + Math.random() * (b - a);

// ---------- offline DSP ----------

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

/** RBJ cookbook biquad (band pass has 0 dB peak gain). */
function biquad(type: 'lp' | 'hp' | 'bp', f: number, q: number, sr: number): Biquad {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const c = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === 'lp') [b0, b1, b2] = [(1 - c) / 2, 1 - c, (1 - c) / 2];
  else if (type === 'hp') [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  else [b0, b1, b2] = [alpha, 0, -alpha];
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * c) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function run(f: Biquad, x: number): number {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1;
  f.x1 = x;
  f.y2 = f.y1;
  f.y1 = y;
  return y;
}

type FilterSpec = [type: 'lp' | 'hp' | 'bp', f: number, q: number];

/** A mono buffer that recipes add layers into. */
class Tape {
  readonly d: Float32Array;
  constructor(
    readonly sr: number,
    seconds: number,
  ) {
    this.d = new Float32Array(Math.ceil(sr * seconds));
  }

  /** Decaying sinusoids [freq, amp, decay seconds]: struck metal, wood, plastic. */
  modes(t0: number, list: [number, number, number][]): void {
    const { d, sr } = this;
    for (const [f, amp, decay] of list) {
      const start = Math.floor(t0 * sr);
      const len = Math.min(d.length - start, Math.ceil(decay * 7 * sr));
      const ph = Math.random() * Math.PI * 2;
      const w = (2 * Math.PI * f) / sr;
      for (let n = 0; n < len; n++) {
        const t = n / sr;
        d[start + n] += amp * Math.sin(ph + w * n) * Math.exp(-t / decay) * Math.min(1, t / 0.0015);
      }
    }
  }

  /** Filtered noise burst with an attack/decay envelope; rough > 0 adds a jittery grind. */
  noise(t0: number, dur: number, amp: number, decay: number, filters: FilterSpec[], attack = 0.001, rough = 0): void {
    const { d, sr } = this;
    const fs = filters.map(([type, f, q]) => biquad(type, f, q, sr));
    const mod = biquad('lp', 28, 0.7, sr);
    const start = Math.floor(t0 * sr);
    const len = Math.min(d.length - start, Math.ceil(dur * sr));
    for (let n = 0; n < len; n++) {
      const t = n / sr;
      let x = Math.random() * 2 - 1;
      for (const f of fs) x = run(f, x);
      let env = amp * Math.exp(-t / decay) * Math.min(1, t / attack);
      if (rough > 0) env *= 1 - rough + rough * Math.min(1, Math.abs(run(mod, Math.random() * 2 - 1)) * 9);
      d[start + n] += x * env;
    }
  }

  /** Sine with a falling pitch: the body thud of a heavy hit. */
  thud(t0: number, f0: number, f1: number, sweep: number, amp: number, decay: number): void {
    const { d, sr } = this;
    const start = Math.floor(t0 * sr);
    const len = Math.min(d.length - start, Math.ceil(decay * 8 * sr));
    let ph = 0;
    for (let n = 0; n < len; n++) {
      const t = n / sr;
      ph += (2 * Math.PI * (f1 + (f0 - f1) * Math.exp(-t / sweep))) / sr;
      d[start + n] += amp * Math.sin(ph) * Math.exp(-t / decay) * Math.min(1, t / 0.002);
    }
  }

  /** Many tiny filtered noise grains: crunching panels, splintering wood, gravel of debris. */
  grains(t0: number, span: number, count: number, amp: number, fMin: number, fMax: number, q: number, lenMax = 0.009): void {
    for (let i = 0; i < count; i++) {
      const k = Math.random() ** 1.7;
      const len = rnd(0.002, lenMax);
      this.noise(t0 + k * span, len * 4, amp * rnd(0.3, 1) * (1 - 0.7 * k), len, [['bp', rnd(fMin, fMax), q]]);
    }
  }

  /** Glass: a bright crack, then shards tinkling down (front loaded). */
  glass(t0: number, span: number, count: number, amp: number): void {
    this.noise(t0, 0.25, amp, 0.05, [['hp', 2800, 0.7]]);
    this.noise(t0, 0.12, amp * 0.6, 0.02, [['bp', 6500, 1.2]]);
    for (let i = 0; i < count; i++) {
      const k = Math.random() ** 2.1;
      const t = t0 + 0.01 + k * span;
      const a = amp * rnd(0.12, 0.45) * (1 - 0.65 * k);
      const f = rnd(2600, 9200);
      this.modes(t, [
        [f, a, rnd(0.006, 0.035)],
        [f * rnd(1.4, 1.9), a * 0.5, rnd(0.004, 0.02)],
      ]);
      this.noise(t, 0.012, a * 0.7, 0.003, [['hp', 5000, 0.7]]);
    }
  }

  finish(): Float32Array<ArrayBuffer> {
    const d = this.d;
    let peak = 1e-6;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    const g = 0.95 / peak;
    const fade = Math.floor(this.sr * 0.03);
    for (let i = 0; i < d.length; i++) d[i] *= g * Math.min(1, (d.length - i) / fade);
    return d as Float32Array<ArrayBuffer>;
  }
}

/** Inharmonic ratios of a struck bar / pole (free-free beam modes). */
const BAR = [1, 2.756, 5.404, 8.933];

const RECIPES: Record<Bank, { seconds: number; make(t: Tape): void }> = {
  // Car vs car: sheet metal crunch over a body thud, a short panel ring.
  crash: {
    seconds: 0.9,
    make(t) {
      t.thud(0, rnd(120, 150), 42, 0.05, 0.9, 0.14);
      t.noise(0, 0.3, 0.55, 0.07, [['bp', rnd(1400, 2200), 0.8]]);
      t.grains(0.005, 0.28, 34, 0.5, 1800, 5200, 2.5);
      const b = rnd(300, 380);
      t.modes(0.002, [1, 1.47, 2.09, 2.56, 3.9, 5.2].map((r, i) => [b * r * rnd(0.97, 1.03), 0.22 / (1 + i * 0.4), rnd(0.07, 0.22)] as [number, number, number]));
    },
  },
  // Concrete wall: heavy low thud, dull body, a gritty scrape tail.
  wall: {
    seconds: 1.0,
    make(t) {
      t.thud(0, rnd(95, 115), 34, 0.06, 1, 0.2);
      t.noise(0, 0.35, 0.6, 0.08, [['lp', 420, 0.7]]);
      t.noise(0.02, 0.8, 0.28, 0.28, [['bp', rnd(800, 1100), 1.2]], 0.03, 0.8);
      t.grains(0.01, 0.4, 14, 0.25, 1200, 3200, 2);
    },
  },
  // Road closure barrier: thud plus hollow plastic/board knock and a rattle.
  barrier: {
    seconds: 0.9,
    make(t) {
      t.thud(0, 110, 40, 0.05, 0.8, 0.15);
      t.modes(0, [
        [rnd(200, 240), 0.5, 0.09],
        [rnd(390, 430), 0.35, 0.07],
        [rnd(660, 720), 0.25, 0.05],
      ]);
      t.noise(0, 0.2, 0.45, 0.04, [['bp', 900, 1.1]]);
      t.noise(0.03, 0.6, 0.2, 0.2, [['bp', 1300, 1.4]], 0.02, 0.7);
    },
  },
  // Steel guard rail: long ringing clang with a metallic screech.
  rail: {
    seconds: 1.5,
    make(t) {
      const b = rnd(160, 200);
      t.modes(0, [
        [b, 0.5, 0.45],
        [b * 2.32, 0.4, 0.38],
        [b * 4.25, 0.3, 0.3],
        [b * 6.63, 0.2, 0.22],
        [b * 9.38, 0.12, 0.15],
        [rnd(1700, 1900), 0.12, 0.12],
        [rnd(2800, 3100), 0.08, 0.08],
      ]);
      t.noise(0, 0.05, 0.5, 0.012, [['hp', 1000, 0.7]]);
      t.thud(0, 90, 40, 0.05, 0.4, 0.1);
      t.noise(0.01, 0.6, 0.22, 0.25, [['bp', rnd(2300, 2800), 5]], 0.02, 0.85);
    },
  },
  // Streetlight: big pole clang, lamp glass, the pole hitting the road.
  streetlight: {
    seconds: 1.8,
    make(t) {
      const b = rnd(230, 290);
      t.modes(0, BAR.map((r, i) => [b * r, 0.55 / (1 + i * 0.6), 0.75 - i * 0.15] as [number, number, number]));
      t.thud(0, 120, 45, 0.05, 0.7, 0.12);
      t.glass(0.05, 0.7, 26, 0.5);
      t.modes(0.62, BAR.map((r, i) => [b * 0.8 * r, 0.25 / (1 + i), 0.35] as [number, number, number]));
      t.thud(0.62, 80, 35, 0.05, 0.4, 0.1);
    },
  },
  // Traffic light: smaller clang, plastic housing clack, lens glass.
  trafficLight: {
    seconds: 1.5,
    make(t) {
      const b = rnd(300, 360);
      t.modes(0, BAR.map((r, i) => [b * r, 0.45 / (1 + i * 0.6), 0.55 - i * 0.1] as [number, number, number]));
      t.thud(0, 125, 45, 0.05, 0.6, 0.12);
      t.modes(0.04, [
        [rnd(700, 800), 0.3, 0.03],
        [rnd(1300, 1500), 0.2, 0.02],
      ]);
      t.glass(0.04, 0.55, 20, 0.45);
    },
  },
  // Garbage can: hollow bang, then it bounces and rattles away.
  garbageCan: {
    seconds: 1.1,
    make(t) {
      const b = rnd(140, 170);
      const hollow = (at: number, a: number) => {
        t.modes(at, [
          [b, a, 0.14],
          [b * 1.71, a * 0.7, 0.11],
          [b * 2.73, a * 0.5, 0.08],
          [b * 3.6, a * 0.35, 0.06],
        ]);
        t.noise(at, 0.12, a * 0.8, 0.025, [['bp', 700, 1.4]]);
      };
      hollow(0, 0.8);
      t.thud(0, 110, 50, 0.04, 0.5, 0.08);
      hollow(rnd(0.2, 0.26), 0.35);
      hollow(rnd(0.38, 0.45), 0.2);
      hollow(rnd(0.52, 0.6), 0.1);
      t.grains(0.05, 0.6, 10, 0.15, 1500, 4000, 2);
    },
  },
  // Bench: wooden slats splintering over a metal frame clank.
  bench: {
    seconds: 1.0,
    make(t) {
      t.thud(0, 115, 45, 0.05, 0.75, 0.12);
      t.modes(0, [
        [rnd(170, 200), 0.45, 0.05],
        [rnd(330, 370), 0.35, 0.04],
        [rnd(560, 620), 0.25, 0.03],
      ]);
      t.grains(0, 0.35, 60, 0.55, 500, 1800, 1.6, 0.012);
      const b = rnd(480, 560);
      t.modes(0.01, BAR.map((r, i) => [b * r, 0.18 / (1 + i), 0.18] as [number, number, number]));
      t.grains(0.15, 0.5, 14, 0.2, 900, 2500, 2);
    },
  },
  // Firework shell: a deep boom, a sharp crack and the crackle of the stars.
  firework: {
    seconds: 2.2,
    make(t) {
      t.thud(0, rnd(70, 85), 28, 0.08, 1, 0.32);
      t.noise(0, 0.5, 0.75, 0.09, [['lp', 520, 0.7]]);
      t.noise(0, 0.06, 0.45, 0.012, [['hp', 1500, 0.7]]);
      t.noise(0.02, 1.6, 0.18, 0.6, [['lp', 260, 0.7]], 0.05);
      t.grains(0.25, 1.6, 70, 0.32, 2500, 7500, 2.5, 0.004);
    },
  },
  // Bus stop: a whole glass shelter coming down.
  busStop: {
    seconds: 2.2,
    make(t) {
      t.thud(0, 100, 36, 0.06, 0.9, 0.2);
      const b = rnd(200, 240);
      t.modes(0, BAR.map((r, i) => [b * r, 0.3 / (1 + i * 0.5), 0.5] as [number, number, number]));
      t.glass(0, 1.6, 140, 0.85);
      t.glass(0.1, 1.4, 60, 0.5);
      t.grains(0.05, 1.2, 40, 0.2, 2500, 7000, 2.2);
    },
  },
  // Bush: a leafy swish and snapping twigs, barely a thud.
  bush: {
    seconds: 0.8,
    make(t) {
      t.noise(0, 0.45, 0.6, 0.18, [['bp', rnd(2200, 3200), 0.6]], 0.015);
      t.noise(0, 0.3, 0.35, 0.1, [['hp', 5000, 0.7]], 0.01);
      t.grains(0.01, 0.35, 40, 0.4, 1800, 5200, 2.2, 0.006);
      t.thud(0, 90, 50, 0.04, 0.25, 0.06);
    },
  },
  // Planter pot: a concrete crack over a heavy thud, shards and spilling soil.
  planterPot: {
    seconds: 1.0,
    make(t) {
      t.thud(0, rnd(100, 120), 40, 0.05, 0.85, 0.14);
      t.modes(0, [
        [rnd(420, 520), 0.4, 0.03],
        [rnd(900, 1100), 0.3, 0.02],
        [rnd(1700, 2000), 0.2, 0.015],
      ]);
      t.noise(0, 0.2, 0.5, 0.05, [['bp', 1200, 0.9]]);
      t.grains(0.02, 0.5, 30, 0.35, 900, 3500, 2, 0.01);
      t.noise(0.05, 0.5, 0.2, 0.2, [['lp', 600, 0.7]], 0.02);
    },
  },
  // Cafe table: aluminium chairs clattering away in a few bounces.
  cafeTable: {
    seconds: 1.0,
    make(t) {
      const b = rnd(600, 720);
      const clank = (at: number, a: number) => t.modes(at, BAR.map((r, i) => [b * r * rnd(0.95, 1.05), a / (1 + i * 0.7), 0.12] as [number, number, number]));
      clank(0, 0.5);
      clank(rnd(0.12, 0.18), 0.35);
      clank(rnd(0.3, 0.38), 0.25);
      clank(rnd(0.5, 0.6), 0.15);
      t.thud(0, 120, 60, 0.03, 0.4, 0.06);
      t.grains(0.02, 0.4, 12, 0.2, 1500, 4000, 2);
    },
  },
  // Plastic barrel: a hollow thunk and a sloshing bounce.
  barrel: {
    seconds: 0.9,
    make(t) {
      const b = rnd(95, 120);
      t.modes(0, [
        [b, 0.7, 0.09],
        [b * 1.9, 0.4, 0.06],
        [b * 3.1, 0.25, 0.04],
      ]);
      t.noise(0, 0.1, 0.45, 0.03, [['bp', 500, 1.2]]);
      t.modes(rnd(0.25, 0.32), [
        [b * 1.05, 0.3, 0.07],
        [b * 2, 0.15, 0.05],
      ]);
      t.noise(0.02, 0.4, 0.15, 0.15, [['bp', 1200, 1]], 0.01, 0.6);
    },
  },
  // Crates: boards splintering, then the stack tumbling.
  crate: {
    seconds: 1.0,
    make(t) {
      t.thud(0, 105, 45, 0.05, 0.7, 0.1);
      t.modes(0, [
        [rnd(220, 260), 0.4, 0.04],
        [rnd(450, 520), 0.3, 0.03],
        [rnd(800, 900), 0.2, 0.02],
      ]);
      t.grains(0, 0.45, 80, 0.6, 400, 2200, 1.5, 0.014);
      t.modes(rnd(0.22, 0.3), [[rnd(240, 280), 0.25, 0.04]]);
      t.grains(0.25, 0.4, 20, 0.25, 600, 2000, 1.6);
    },
  },
  // Dumpster: a huge steel boom and the lid slamming.
  dumpster: {
    seconds: 1.6,
    make(t) {
      t.thud(0, rnd(70, 85), 30, 0.07, 1, 0.25);
      const b = rnd(110, 140);
      t.modes(0, [
        [b, 0.6, 0.5],
        [b * 1.83, 0.45, 0.4],
        [b * 2.97, 0.35, 0.3],
        [b * 4.4, 0.2, 0.2],
        [b * 6.1, 0.12, 0.12],
      ]);
      t.noise(0, 0.4, 0.6, 0.1, [['bp', 900, 0.8]]);
      t.modes(rnd(0.3, 0.36), [
        [b * 2.6, 0.3, 0.15],
        [b * 4.1, 0.2, 0.1],
      ]);
      t.grains(0.05, 0.9, 25, 0.25, 1200, 4000, 2);
    },
  },
  // Fire hydrant: a dull cast iron clunk as it shears off, then the water main letting go.
  hydrant: {
    seconds: 1.8,
    make(t) {
      t.thud(0, rnd(95, 115), 40, 0.04, 0.9, 0.12);
      const b = rnd(380, 450);
      t.modes(0, BAR.map((r, i) => [b * r, 0.32 / (1 + i), 0.06 - i * 0.01] as [number, number, number]));
      t.noise(0.04, 1.7, 0.55, 0.9, [['bp', rnd(1300, 1700), 0.45]], 0.06, 0.5);
      t.noise(0.04, 1.7, 0.3, 0.7, [['lp', 500, 0.7]], 0.08, 0.6);
      t.grains(0.1, 1.4, 40, 0.15, 2500, 6500, 1.5, 0.006);
    },
  },
  // An axle over a speed hump or an expansion joint: the suspension's dull thump and a short rattle of the chassis. Played low for a joint, higher and softer for the second axle's.
  thump: {
    seconds: 0.4,
    make(t) {
      t.thud(0, rnd(78, 92), 42, 0.045, 0.85, 0.07);
      t.noise(0, 0.1, 0.3, 0.035, [['lp', 420, 0.7]]);
      t.modes(0, [
        [rnd(150, 180), 0.12, 0.05],
        [rnd(300, 360), 0.07, 0.03],
      ]);
    },
  },
  // Trash bags: a soft thump, plastic rustle and a bottle or two.
  trashBags: {
    seconds: 0.8,
    make(t) {
      t.thud(0, 80, 45, 0.05, 0.6, 0.08);
      t.noise(0, 0.35, 0.45, 0.12, [['bp', rnd(2500, 3500), 0.5]], 0.01, 0.7);
      t.glass(0.05, 0.4, 8, 0.25);
    },
  },
};

/** All impact sound banks. */
export const SFX_BANKS = Object.keys(RECIPES) as Bank[];

/** Render one variant of an impact bank to samples (pure; used by Sfx and the tests). */
export function renderImpact(b: Bank, sampleRate: number): Float32Array<ArrayBuffer> {
  const tape = new Tape(sampleRate, RECIPES[b].seconds);
  RECIPES[b].make(tape);
  return tape.finish();
}
