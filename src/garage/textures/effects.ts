/**
 * The textures the room redraws or lays under its light: the wash of light
 * down a wall, the dyno screen (redrawn as it runs), the soft glow sprite and
 * the contact shadow. Render only.
 */
import * as THREE from 'three';
import { canvas, drawTexture } from '../../render/textures/canvasKit';
import { PALETTE } from '../../ui/kit/palette';

/** Light washing down a wall from a strip over it: white at the top edge fading to nothing, soft at the sides. */
export function washTexture(): THREE.CanvasTexture {
  return drawTexture(
    64,
    128,
    (g) => {
      const v = g.createLinearGradient(0, 0, 0, 128);
      v.addColorStop(0, 'rgba(255,255,255,1)');
      v.addColorStop(0.25, 'rgba(255,255,255,0.45)');
      v.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = v;
      g.fillRect(0, 0, 64, 128);
      g.globalCompositeOperation = 'destination-in';
      const h = g.createLinearGradient(0, 0, 64, 0);
      h.addColorStop(0, 'rgba(0,0,0,0)');
      h.addColorStop(0.15, 'rgba(0,0,0,1)');
      h.addColorStop(0.85, 'rgba(0,0,0,1)');
      h.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = h;
      g.fillRect(0, 0, 64, 128);
    },
    { repeat: false },
  );
}

/** A pull's peak figures as the screen shows them: power (hp) and torque (lb-ft) and the rpm each peaks at. */
export interface DynoPeaks {
  hp: number;
  lbft: number;
  hpRpm: number;
  lbftRpm: number;
}

/**
 * A pull the screen draws instead of its own fake one: the player's car on the
 * dyno. The curves are normalized to their peaks over the rpm axis (0 = idle,
 * 1 = redline) and drawn up to `progress`, the furthest rpm the pull has reached.
 */
export interface DynoRun {
  /** How far along the rpm axis the curves are drawn (0..1); the pull is done at 1 and the peaks are called out. */
  progress: number;
  /** Power and torque at a point on the rpm axis, each as a share of its own peak (0..1). */
  power: (x: number) => number;
  torque: (x: number) => number;
  /** The figures the shares scale to (the live readout reads them) and the call-out once the pull is done. */
  peaks: DynoPeaks;
  /** The engine's rpm now, for the readout. */
  rpm: number;
  /** The heading, e.g. the car and the pull's number. */
  title?: string;
}

/** The screen's plot area on its canvas (px): left, right, top (of the 100%) and baseline. */
const PLOT = { x0: 24, x1: 248, top: 28, base: 128 } as const;

/**
 * The dyno screen on the wall: a run drawn as it happens on a small canvas,
 * power and torque climbing with the revs. With no run of its own (nobody on
 * the dyno) it fakes one from time t (s): a pull, the peak held for a few
 * seconds, then the next. Given a `DynoRun` it draws the player's live pull
 * from the sim's own curves instead and ends on the peak figures. `draw`
 * repaints; the showroom calls it a dozen times a second, so the upload is a
 * 256 x 144 texture now and then.
 */
export function dynoScreen(): { texture: THREE.CanvasTexture; draw: (t: number, run?: DynoRun | null) => void } {
  const [c, g] = canvas(256, 144);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const fakePower = (x: number) => Math.min(1, x * 1.25) * (1 - 0.25 * Math.max(0, x - 0.8) / 0.2) * (0.9 + 0.1 * x);
  const fakeTorque = (x: number) => 0.55 + 0.35 * Math.sin(Math.min(1, x) * Math.PI * 0.8) - 0.12 * x;
  const draw = (t: number, run?: DynoRun | null) => {
    const fakeP = Math.min(1, (t % 9) / 6);
    const p = run ? run.progress : fakeP;
    const power = run ? run.power : fakePower;
    const torque = run ? run.torque : fakeTorque;
    g.fillStyle = '#05080c';
    g.fillRect(0, 0, 256, 144);
    g.strokeStyle = 'rgba(120,220,232,0.15)';
    g.lineWidth = 1;
    for (let x = 24; x < 250; x += 28) {
      g.beginPath();
      g.moveTo(x, 22);
      g.lineTo(x, 128);
      g.stroke();
    }
    for (let y = 22; y <= 128; y += 21) {
      g.beginPath();
      g.moveTo(24, y);
      g.lineTo(248, y);
      g.stroke();
    }
    const at = (f: (x: number) => number, x: number): [number, number] => [PLOT.x0 + x * (PLOT.x1 - PLOT.x0), PLOT.base - f(x) * (PLOT.base - PLOT.top)];
    const curve = (f: (x: number) => number, color: string) => {
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath();
      const n = Math.ceil(60 * p);
      for (let i = 0; i <= n; i++) {
        const [px, py] = at(f, Math.min(p, i / 60));
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
    };
    // The fake pull's curves run to the grid's top (x 100); a live pull's stop 8% under it so the peak marker stays in view.
    const plot = (f: (x: number) => number) => (run ? (x: number) => f(x) * 0.92 : f);
    const pw = plot(power);
    const tq = plot(torque);
    curve(pw, PALETTE.orange);
    curve(tq, PALETTE.cyan);
    g.fillStyle = '#e9e7e0';
    g.font = '700 11px "Google Sans Flex", system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText(run?.title ?? 'DYNO CELL  ·  PULL 3', 6, 14);
    g.textAlign = 'right';
    g.fillStyle = PALETTE.orange;
    g.font = '800 14px "Google Sans Flex", system-ui, sans-serif';
    g.fillText(run ? `${Math.round(power(p) * run.peaks.hp)} HP` : `${Math.round(fakePower(p) * 412)} WHP`, 250, 14);
    g.fillStyle = PALETTE.cyan;
    g.font = '700 10px "Google Sans Flex", system-ui, sans-serif';
    g.fillText(`${Math.round(run ? run.rpm : 1500 + p * 6000)} RPM`, 250, 140);
    if (run && p >= 1) {
      // Done: a dot on each curve at its peak and the figures under the plot.
      const k = run.peaks;
      for (const [f, color] of [
        [pw, PALETTE.orange],
        [tq, PALETTE.cyan],
      ] as const) {
        let best = 0;
        for (let i = 1; i <= 60; i++) if (f(i / 60) > f(best)) best = i / 60;
        const [px, py] = at(f, best);
        g.fillStyle = color;
        g.beginPath();
        g.arc(px, py, 3, 0, Math.PI * 2);
        g.fill();
      }
      g.textAlign = 'left';
      g.font = '700 10px "Google Sans Flex", system-ui, sans-serif';
      g.fillStyle = PALETTE.orange;
      g.fillText(`${Math.round(k.hp)} hp @ ${Math.round(k.hpRpm)}`, 24, 140);
      g.fillStyle = PALETTE.cyan;
      g.fillText(`${Math.round(k.lbft)} lb-ft @ ${Math.round(k.lbftRpm)}`, 112, 140);
    }
    texture.needsUpdate = true;
  };
  draw(0);
  return { texture, draw };
}

/** A soft round glow (white, alpha falling off), for light spilling on the wall round a sign or a lamp. */
export function glowTexture(): THREE.CanvasTexture {
  return drawTexture(
    128,
    128,
    (g) => {
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.35, 'rgba(255,255,255,0.4)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    },
    { repeat: false },
  );
}

/** The contact shadow: a soft rounded rectangle, darkest under the car's middle. */
export function shadowTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 256;
  return drawTexture(
    w,
    h,
    (g) => {
      const img = g.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const px = Math.abs((x + 0.5) / w - 0.5) * 2;
          const py = Math.abs((y + 0.5) / h - 0.5) * 2;
          const qx = Math.max(px - 0.6, 0);
          const qy = Math.max(py - 0.72, 0);
          const d = Math.hypot(qx / 0.4, qy / 0.28);
          const a = Math.max(0, 1 - d) ** 1.8 * (0.75 + 0.25 * (1 - py));
          const i = (y * w + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
          img.data[i + 3] = Math.round(a * 255);
        }
      }
      g.putImageData(img, 0, 0);
    },
    { srgb: false, repeat: false },
  );
}
