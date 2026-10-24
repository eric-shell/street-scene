/**
 * What a gate looks like, apart from its steel: the START / FINISH themes
 * (LED pair, the two neon colors, the sign's label and glow), the label to
 * glow mapping (green START, amber LAP, pink FINISH), and the canvas textures
 * the gantry and the light rig wear: the neon sign face, the beam ramp, the
 * light pool and the soft dot the particles share. Also the two constants the
 * painted line, the gantry and the celebration agree on (the line's height
 * over the road, world up). Render only.
 */
import * as THREE from 'three';
import { canvas } from '../textures/canvasKit';
import type { GateKind } from './finishLine';

/** Height of the painted checkered line above the road (m). */
export const LINE_Y = 0.05;

export interface Theme {
  led: [THREE.Color, THREE.Color];
  neonA: THREE.Color;
  neonB: THREE.Color;
  text: string;
  glow: string;
}

/** The finish theme, shared by the circuit's start/finish gate (themes are only read, never changed). */
const FINISH_THEME: Theme = { led: [new THREE.Color(1, 0.08, 0.12), new THREE.Color(1, 0.95, 0.85)], neonA: new THREE.Color(2.6, 0.25, 1.9), neonB: new THREE.Color(0.25, 2.2, 3), text: 'FINISH', glow: '#ff2d7a' };

export const THEMES: Record<GateKind, Theme> = {
  finish: FINISH_THEME,
  startFinish: FINISH_THEME,
  start: { led: [new THREE.Color(0.1, 1, 0.35), new THREE.Color(0.9, 1, 0.95)], neonA: new THREE.Color(0.2, 2.6, 1.2), neonB: new THREE.Color(0.25, 2.2, 3), text: 'START', glow: '#2dff9a' },
};

/** Sign glow by label: green START, amber LAP n, pink FINISH. */
export function signGlow(text: string, fallback: string): string {
  if (text.startsWith('START')) return '#2dff9a';
  if (text.startsWith('FINISH')) return '#ff2d7a';
  if (text.startsWith('LAP') || text.startsWith('FINAL')) return '#ffc22d';
  return fallback;
}

/** Neon sign face: dark panel, checkered ends, glowing letters. */
function drawSign(ctx: CanvasRenderingContext2D, w: number, h: number, text: string, glow: string, sub: string): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#0b0c16');
  g.addColorStop(1, '#040408');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const cell = h / 4;
  for (const x0 of [0, w - cell * 3]) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 4; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#101010' : '#e8e8e8';
        ctx.fillRect(x0 + i * cell, j * cell, cell, cell);
      }
    }
  }
  ctx.strokeStyle = glow;
  ctx.lineWidth = 6;
  ctx.shadowColor = glow;
  ctx.shadowBlur = 18;
  ctx.strokeRect(cell * 3 + 14, 12, w - cell * 6 - 28, h - 24);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const size = Math.round(h * 0.62);
  ctx.font = `900 ${size}px "Google Sans Flex", "Arial Black", Impact, sans-serif`;
  const tw = ctx.measureText(text).width;
  const maxW = w - cell * 6 - 80;
  if (tw > maxW) ctx.font = `900 ${Math.floor((size * maxW) / tw)}px "Google Sans Flex", "Arial Black", Impact, sans-serif`;
  ctx.shadowBlur = 42;
  ctx.fillStyle = glow;
  ctx.fillText(text, w / 2, h * 0.47);
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#fff6fb';
  ctx.fillText(text, w / 2, h * 0.47);
  if (sub) {
    ctx.shadowBlur = 8;
    ctx.font = `700 ${Math.round(h * 0.12)}px "Google Sans Flex", sans-serif`;
    ctx.fillStyle = '#c9d4ff';
    ctx.fillText(sub, w / 2, h * 0.86);
  }
  ctx.shadowBlur = 0;
}

export interface SignFace {
  texture: THREE.CanvasTexture;
  /** Redraw with new text (no-op when unchanged). */
  set(text: string, glow: string, sub: string): void;
}

export function signTexture(text: string, glow: string, sub: string): SignFace {
  const [c, ctx] = canvas(1536, 256);
  let cur = '';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  const state = { text, glow, sub };
  const draw = () => {
    drawSign(ctx, c.width, c.height, state.text, state.glow, state.sub);
    cur = `${state.text}|${state.glow}|${state.sub}`;
    t.needsUpdate = true;
  };
  draw();
  // Redraw once the display font has loaded (it is usually ready by race time).
  document.fonts?.load(`900 64px "Google Sans Flex"`).then(draw, () => undefined);
  return {
    texture: t,
    set(text2, glow2, sub2) {
      if (`${text2}|${glow2}|${sub2}` === cur) return;
      state.text = text2;
      state.glow = glow2;
      state.sub = sub2;
      draw();
    },
  };
}

/** Vertical gradient: bright at the bottom (v = 0), black at the top. */
export function beamTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(4, 128);
  const g = ctx.createLinearGradient(0, 128, 0, 0);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.25, '#7a7a7a');
  g.addColorStop(0.7, '#1a1a1a');
  g.addColorStop(1, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

/** Soft pool of light on the road: warm center, neon tinted ends. */
export function poolTexture(a: string, b: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 128);
  const blob = (x: number, r: number, color: string, alpha: number) => {
    const g = ctx.createRadialGradient(x, 64, 0, x, 64, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
  };
  ctx.globalCompositeOperation = 'lighter';
  blob(128, 64, '#ffe2c4', 0.9);
  blob(20, 40, a, 0.8);
  blob(236, 40, b, 0.8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function dotTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(32, 32);
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, '#ffffff');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

/** World up, the axis the gantries and the burst directions yaw around. */
export const UP = new THREE.Vector3(0, 1, 0);
