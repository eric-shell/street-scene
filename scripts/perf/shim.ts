/**
 * Browser stubs for building the three.js scene in Node: `document.createElement` hands out a canvas whose 2D
 * context swallows every call (a Proxy), plus `window`, `Path2D` and `location`. Textures come out blank, which is
 * fine: the perf scripts count geometry and materials, never pixels. Import this module first.
 */
const mk = (): any => new Proxy(function () {} as any, {
  get: (_t, k) => {
    if (k === 'data') return new Uint8ClampedArray(4);
    if (k === 'width' || k === 'height') return 1;
    if (k === Symbol.toPrimitive) return () => 0;
    return mk();
  },
  set: () => true,
  apply: () => mk(),
});
const ctxFor = (c: any) => new Proxy({}, {
  get: (_t, k) => {
    if (k === 'canvas') return c;
    if (k === 'getImageData' || k === 'createImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1) * 4)), width: w, height: h });
    if (k === 'measureText') return () => ({ width: 10 });
    return mk();
  },
  set: () => true,
});
const g = globalThis as any;
g.document = { createElement: () => { const c: any = { width: 1, height: 1, style: {} }; c.getContext = () => ctxFor(c); return c; } };
g.window = { devicePixelRatio: 1, addEventListener() {}, innerWidth: 1280, innerHeight: 720 };
g.Path2D = class { moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} quadraticCurveTo() {} bezierCurveTo() {} };
g.location = { search: '' };
export {};
