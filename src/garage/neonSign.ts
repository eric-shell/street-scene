/**
 * Neon signs for the garage: lettering bent from glass tube (the glyph
 * outlines stroked, so each letter is a tube tracing its shape, as real neon
 * logos are), a hot near-white core inside a colored tube inside a soft halo,
 * on a dark backer with standoffs, a transformer box, a glow spilling onto the
 * wall and a light of its own. One letter can be on its last legs: it sits on
 * a layer of its own and stutters every few seconds, its dark glass showing
 * when it drops out.
 *
 * Canvas drawn (once, and again when the display font arrives); the glow
 * values past 1 feed the bloom. Render only.
 */
import * as THREE from 'three';
import { canvasTexture, glowTexture, noise } from './showroomTextures';

/** Saturated tube colors (the UI palette is pastel; gas in glass is not). */
export const NEON = { orange: '#ff7a2e', pink: '#ff2f6d', cyan: '#2fe4ff' } as const;

interface NeonLine {
  /** Words and their tube colors. */
  words: { text: string; color: string }[];
  /** CSS font (size is fitted), e.g. 'italic 900'. */
  weight: string;
  /** Baseline middle as a fraction of the canvas height, and the width the line fills (fraction). */
  y: number;
  fit: number;
  /** Extra space between letters (fraction of the font size). */
  spacing: number;
}

export interface NeonSpec {
  /** Canvas size (px) and the sign's width (m); the height follows the canvas. */
  canvas: [number, number];
  width: number;
  /** Tube thickness (px). */
  tube: number;
  lines: NeonLine[];
  /** Straight tube rules: from (x0, y) to (x1, y), fractions of the canvas, slanted with the italics. */
  rules: { x0: number; x1: number; y: number; color: string; slant: number }[];
  /** A tube border round the lettering, inset (fraction of the height), and its color. */
  border?: { inset: number; color: string; radius: number };
  /** Which letter flickers: line index and letter index counted across the line's words (spaces excluded). */
  flicker?: [number, number];
  /** Backer panel color, or null for tubes straight on the wall. */
  backer: number | null;
  /** The light it throws: color, intensity and reach (m). */
  light: [string, number, number];
}

/** The garage's main sign: STREET SCENE over a swoosh and CUSTOM GARAGE, the last E failing. */
export const MAIN_SIGN: NeonSpec = {
  canvas: [1280, 480],
  width: 6.2,
  tube: 8,
  lines: [
    {
      words: [
        { text: 'STREET', color: NEON.orange },
        { text: 'SCENE', color: NEON.pink },
      ],
      weight: 'italic 900',
      y: 0.4,
      fit: 0.84,
      spacing: 0.02,
    },
    { words: [{ text: 'CUSTOM GARAGE', color: NEON.cyan }], weight: 'italic 700', y: 0.84, fit: 0.46, spacing: 0.32 },
  ],
  rules: [
    { x0: 0.1, x1: 0.62, y: 0.66, color: NEON.cyan, slant: 0 },
    { x0: 0.66, x1: 0.9, y: 0.66, color: NEON.cyan, slant: 0 },
  ],
  flicker: [0, 10],
  backer: 0x121114,
  light: ['#ff6a52', 10, 10],
};

/** A smaller sign over the workbench. */
export const OPEN_SIGN: NeonSpec = {
  canvas: [640, 256],
  width: 1.9,
  tube: 7,
  lines: [
    {
      words: [
        { text: 'OPEN', color: NEON.cyan },
        { text: 'LATE', color: NEON.pink },
      ],
      weight: '800',
      y: 0.52,
      fit: 0.72,
      spacing: 0.06,
    },
  ],
  rules: [],
  border: { inset: 0.14, color: NEON.cyan, radius: 0.18 },
  backer: null,
  light: ['#7fd8ff', 3.5, 5],
};

const FAMILY = '"Google Sans Flex", system-ui, sans-serif';

/** The failing letter's level (0..1) at time t (s): steady, a stutter every ten seconds, now and then dead for two. */
export function neonFlicker(t: number): number {
  const c = t % 9.7;
  if (c < 0.75) return noise(Math.floor(t * 19)) > 0.45 ? 1 : 0.04;
  const d = t % 31;
  if (d > 26.5 && d < 28.6) return 0.03;
  return 1;
}

/** Stroke a tube: a wide halo, a tighter glow, the colored glass, then the hot core; or the dark glass of an unlit tube. */
function tube(g: CanvasRenderingContext2D, stroke: () => void, color: string, T: number, lit: boolean): void {
  g.lineJoin = 'round';
  g.lineCap = 'round';
  if (!lit) {
    g.shadowBlur = 0;
    g.strokeStyle = 'rgba(64,52,60,0.85)';
    g.lineWidth = T;
    stroke();
    g.strokeStyle = 'rgba(190,190,210,0.28)';
    g.lineWidth = T * 0.22;
    stroke();
    return;
  }
  g.shadowColor = color;
  for (const [blur, alpha, w] of [
    [T * 6, 0.5, T * 1.4],
    [T * 2.2, 0.85, T],
  ] as const) {
    g.shadowBlur = blur;
    g.globalAlpha = alpha;
    g.strokeStyle = color;
    g.lineWidth = w;
    stroke();
  }
  g.shadowBlur = 0;
  g.globalAlpha = 1;
  g.strokeStyle = color;
  g.lineWidth = T;
  stroke();
  g.strokeStyle = new THREE.Color(color).lerp(new THREE.Color(1, 1, 1), 0.7).getStyle();
  g.lineWidth = T * 0.34;
  stroke();
}

/**
 * Draw the sign. `layer` 'base' is everything but the failing letter (that
 * one as dark glass); 'letter' is the failing letter alone, lit.
 */
function drawSign(g: CanvasRenderingContext2D, spec: NeonSpec, layer: 'base' | 'letter'): void {
  const [W, H] = spec.canvas;
  const T = spec.tube;
  g.clearRect(0, 0, W, H);
  const base = layer === 'base';
  spec.lines.forEach((line, li) => {
    const probe = 100;
    g.font = `${line.weight} ${probe}px ${FAMILY}`;
    const text = line.words.map((w) => w.text).join(' ');
    let w0 = 0;
    for (const ch of text) w0 += g.measureText(ch).width + (ch === ' ' ? 0 : line.spacing * probe);
    const size = (probe * line.fit * W) / w0;
    g.font = `${line.weight} ${size}px ${FAMILY}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    let x = (W - line.fit * W) / 2;
    const y = line.y * H;
    let n = 0;
    for (const word of line.words) {
      for (const ch of word.text) {
        const adv = g.measureText(ch).width;
        if (ch !== ' ') {
          const failing = spec.flicker !== undefined && spec.flicker[0] === li && spec.flicker[1] === n;
          if (base) {
            // Standoffs: the glass clips that hold the tube off the backer.
            g.fillStyle = 'rgba(150,150,160,0.55)';
            for (const k of [0.3, 0.72]) {
              g.beginPath();
              g.arc(x + adv * k, y + size * 0.36, T * 0.45, 0, Math.PI * 2);
              g.fill();
            }
          }
          if (base || failing) {
            const cx = x;
            tube(g, () => g.strokeText(ch, cx, y), word.color, T, !(base && failing));
          }
          n++;
        }
        x += adv + (ch === ' ' ? 0 : line.spacing * size);
      }
      x += g.measureText(' ').width;
    }
  });
  if (!base) return;
  for (const r of spec.rules) {
    const y = r.y * H;
    tube(
      g,
      () => {
        g.beginPath();
        g.moveTo(r.x0 * W, y);
        g.lineTo(r.x1 * W, y - r.slant * H);
        g.stroke();
      },
      r.color,
      T,
      true,
    );
  }
  const b = spec.border;
  if (b) {
    const i = b.inset * H;
    const rad = b.radius * H;
    tube(
      g,
      () => {
        g.beginPath();
        g.roundRect(i, i, W - 2 * i, H - 2 * i, rad);
        g.stroke();
      },
      b.color,
      T,
      true,
    );
  }
}

type Disposable = { dispose(): void };

export class NeonSign {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;
  private readonly letterMat: THREE.MeshBasicMaterial | null = null;
  private readonly disposables: Disposable[] = [];
  private readonly lightBase: number;

  constructor(readonly spec: NeonSpec) {
    const track = <T extends Disposable>(x: T): T => (this.disposables.push(x), x);
    const [W, H] = spec.canvas;
    const w = spec.width;
    const h = (w * H) / W;
    const layer = (which: 'base' | 'letter') => {
      const t = track(canvasTexture(W, H, (g) => drawSign(g, spec, which)));
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      // Draw again once the display font is in (the first draw may use the fallback).
      void document.fonts
        ?.load(`${spec.lines[0].weight} 100px "Google Sans Flex"`)
        .then(() => {
          drawSign((t.image as HTMLCanvasElement).getContext('2d')!, spec, which);
          t.needsUpdate = true;
        })
        .catch(() => undefined);
      return t;
    };
    const tubeMat = (map: THREE.Texture) => track(new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, color: new THREE.Color(1.8, 1.8, 1.8), toneMapped: true }));
    const plane = track(new THREE.PlaneGeometry(w, h));
    // The glow it throws on the wall, wider than the sign.
    const tint = new THREE.Color(spec.light[0]);
    const halo = new THREE.Mesh(
      track(new THREE.PlaneGeometry(w * 1.9, h * 2.6)),
      track(new THREE.MeshBasicMaterial({ map: track(glowTexture()), color: tint.clone().multiplyScalar(0.32), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })),
    );
    halo.position.z = 0.005;
    this.group.add(halo);
    if (spec.backer !== null) {
      const backer = new THREE.Mesh(track(new THREE.BoxGeometry(w * 1.02, h * 1.04, 0.06)), track(new THREE.MeshStandardMaterial({ color: spec.backer, roughness: 0.55, metalness: 0.5 })));
      backer.position.z = 0.04;
      this.group.add(backer);
      // The transformer box beside it and the conduit feeding it.
      const box = new THREE.Mesh(track(new THREE.BoxGeometry(0.34, 0.42, 0.16)), track(new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.6, metalness: 0.4 })));
      box.position.set(w / 2 + 0.45, -h / 2 + 0.1, 0.08);
      this.group.add(box);
    }
    const tubes = new THREE.Mesh(plane, tubeMat(layer('base')));
    tubes.position.z = 0.09;
    tubes.renderOrder = 2;
    this.group.add(tubes);
    if (spec.flicker) {
      this.letterMat = tubeMat(layer('letter'));
      const letter = new THREE.Mesh(plane, this.letterMat);
      letter.position.z = 0.092;
      letter.renderOrder = 3;
      this.group.add(letter);
    }
    const [color, intensity, reach] = spec.light;
    this.lightBase = intensity;
    this.light = new THREE.PointLight(color, intensity, reach, 1.4);
    this.light.position.set(0, -h * 0.2, 0.9);
    this.group.add(this.light);
  }

  /** Stutter the failing letter (and the light a touch with it). */
  update(time: number): void {
    if (!this.letterMat) return;
    const k = neonFlicker(time);
    this.letterMat.opacity = k;
    this.light.intensity = this.lightBase * (0.93 + 0.07 * k);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
