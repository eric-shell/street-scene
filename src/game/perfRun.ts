/**
 * Dev-only performance run (`?perf=<seed>&quality=medium&race=circuit&secs=40&label=base[&vs=base]`): the autopilot
 * drives a fixed course while this samples every rendered frame, so each render change has a before/after on the
 * same seed, route and tier. Measured per frame: frame dt, JS submit ms (session.render including the renderer's
 * render), GPU ms (EXT_disjoint_timer_query_webgl2 when the browser has it), and three.js renderer.info split into the
 * scene pass and the whole frame. The window is in sim ticks, not wall time, so a slow machine drives the same road.
 * Imported lazily from main.ts only when `import.meta.env.DEV`, so production bundles drop it.
 */
import type { RaceSession } from './session';
import type { GameRenderer } from '../render/scene';
import { createAi } from '../sim/ai';
import { h } from '../ui/kit/dom';
import { loadJson, saveJson } from '../shared/store';

/** Sim ticks per second, and the lead-in after the lights go green before sampling starts (s). */
const TICKS_PER_SEC = 60;
const WARMUP_SECS = 2;

export interface PerfResult {
  done: true;
  label: string;
  seed: string;
  tier: string;
  secs: number;
  frames: number;
  /** Median / p90 / p99 of the frame, JS submit and GPU times (ms); gpu is null without the timer query extension. */
  frameMs: Pct;
  submitMs: Pct;
  gpuMs: Pct | null;
  /** Share of frames slower than 16.7 and 33 ms. */
  over16: number;
  over33: number;
  /** Mean triangles and draw calls of the scene pass alone, and the draw calls of the whole frame (post included). */
  sceneTris: number;
  sceneCalls: number;
  frameCalls: number;
}
interface Pct { p50: number; p90: number; p99: number }

const pct = (a: number[], q: number): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const spread = (a: number[]): Pct => ({ p50: pct(a, 0.5), p90: pct(a, 0.9), p99: pct(a, 0.99) });
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Start sampling the live race session; resolves nothing, reports through the console, the overlay and `window.__nr.perf`. */
export function runPerf(getSession: () => RaceSession | null, gr: GameRenderer, params: URLSearchParams): void {
  const session = getSession();
  if (!session) {
    console.error('perf: no race session to measure');
    return;
  }
  const secs = Math.max(1, Number(params.get('secs') ?? 40));
  const label = params.get('label') ?? 'run';
  const vs = params.get('vs');
  const nr = (window as unknown as { __nr: Record<string, unknown> }).__nr;
  nr.perf = { done: false };

  session.devPilot = createAi(0.97);
  const renderer = gr.renderer;
  renderer.info.autoReset = false;

  // GPU timer: one query in flight at a time; its result is read a few frames later.
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const pending: WebGLQuery[] = [];
  const gpu: number[] = [];
  const poll = (): void => {
    while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = pending.shift()!;
      if (!gl.getParameter(ext!.GPU_DISJOINT_EXT)) gpu.push(Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6);
      gl.deleteQuery(q);
    }
  };

  // Split the scene pass out of the frame: its triangles and calls are read as the pass finishes.
  let sceneTris = 0;
  let sceneCalls = 0;
  const pass = gr.post.renderPass;
  const passRender = pass.render.bind(pass);
  pass.render = (...a: Parameters<typeof pass.render>) => {
    const before = { t: renderer.info.render.triangles, c: renderer.info.render.calls };
    passRender(...a);
    sceneTris = renderer.info.render.triangles - before.t;
    sceneCalls = renderer.info.render.calls - before.c;
  };

  const frameMs: number[] = [];
  const submitMs: number[] = [];
  const tris: number[] = [];
  const calls: number[] = [];
  const fullCalls: number[] = [];
  let last = 0;
  let startTick = -1;
  const render = session.render.bind(session);
  session.render = (alpha: number, dt: number) => {
    const r = session.race;
    const now = performance.now();
    if (startTick < 0 && r.phase === 'racing') startTick = r.tick + WARMUP_SECS * TICKS_PER_SEC;
    const sampling = startTick >= 0 && r.tick >= startTick;
    renderer.info.reset();
    let q: WebGLQuery | null = null;
    if (sampling && ext && !pending.length) {
      q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q!);
    }
    render(alpha, dt);
    if (q) {
      gl.endQuery(ext!.TIME_ELAPSED_EXT);
      pending.push(q);
    }
    const t1 = performance.now();
    poll();
    if (sampling) {
      if (last) frameMs.push(now - last);
      submitMs.push(t1 - now);
      tris.push(sceneTris);
      calls.push(sceneCalls);
      fullCalls.push(renderer.info.render.calls);
    }
    last = now;
    if (sampling && r.tick >= startTick + secs * TICKS_PER_SEC) finish();
  };

  function finish(): void {
    session!.render = render;
    pass.render = passRender;
    renderer.info.autoReset = true;
    const res: PerfResult = {
      done: true,
      label,
      seed: String(params.get('perf')),
      tier: params.get('quality') ?? 'default',
      secs,
      frames: frameMs.length,
      frameMs: spread(frameMs),
      submitMs: spread(submitMs),
      gpuMs: gpu.length ? spread(gpu) : null,
      over16: frameMs.filter((m) => m > 16.7).length / Math.max(1, frameMs.length),
      over33: frameMs.filter((m) => m > 33).length / Math.max(1, frameMs.length),
      sceneTris: Math.round(mean(tris)),
      sceneCalls: Math.round(mean(calls)),
      frameCalls: Math.round(mean(fullCalls)),
    };
    nr.perf = res;
    const prev = vs ? loadJson<PerfResult | null>('perf.' + vs, null) : null;
    saveJson('perf.' + label, res);
    report(res, prev);
  }
}

function report(res: PerfResult, prev: PerfResult | null): void {
  const row = (name: string, p: Pct | null, b: Pct | null | undefined) => ({
    metric: name,
    p50: p ? r2(p.p50) : 'n/a',
    p90: p ? r2(p.p90) : 'n/a',
    p99: p ? r2(p.p99) : 'n/a',
    ...(prev ? { 'p50 vs': p && b ? r2(p.p50 - b.p50) : 'n/a', 'p90 vs': p && b ? r2(p.p90 - b.p90) : 'n/a' } : {}),
  });
  const table = [row('frame ms', res.frameMs, prev?.frameMs), row('submit ms', res.submitMs, prev?.submitMs), row('gpu ms', res.gpuMs, prev?.gpuMs)];
  console.table(table);
  console.log('PERF ' + JSON.stringify(res));
  const delta = (a: number, b: number | undefined): string => (b === undefined ? '' : ` (${a - b >= 0 ? '+' : ''}${Math.round(a - b)})`);
  const lines = [
    `perf ${res.label}: seed ${res.seed}, tier ${res.tier}, ${res.frames} frames over ${res.secs} s of sim`,
    ...table.map((t) => `${t.metric.padEnd(10)} p50 ${t.p50}  p90 ${t.p90}  p99 ${t.p99}` + (prev ? `  vs ${prev.label}: p50 ${t['p50 vs']}, p90 ${t['p90 vs']}` : '')),
    `over 16.7 ms ${(res.over16 * 100).toFixed(1)}%   over 33 ms ${(res.over33 * 100).toFixed(1)}%`,
    `scene pass: ${res.sceneTris} tris${delta(res.sceneTris, prev?.sceneTris)}, ${res.sceneCalls} calls${delta(res.sceneCalls, prev?.sceneCalls)}; full frame ${res.frameCalls} calls${delta(res.frameCalls, prev?.frameCalls)}`,
    'Frame ms is vsync-pinned when there is headroom: submit and GPU ms are the sensitive rows.',
    'Triangles and calls are deterministic across machines; ms are not (compare runs on one machine).',
  ];
  document.body.append(h('pre', { style: 'position:fixed;left:8px;bottom:8px;z-index:99999;margin:0;padding:8px 10px;background:rgba(0,0,0,.8);color:#9fe;font:11px/1.35 monospace;pointer-events:none;max-width:96vw;white-space:pre-wrap' }, lines.join('\n')));
}
