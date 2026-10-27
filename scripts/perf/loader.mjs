/**
 * Node module hooks for the headless perf scripts: Vite-only imports (`?worker`, `?url`, `?raw`) resolve to
 * an empty string, and src modules that read `import.meta.env` get a production-shaped one injected, so
 * the scene builders load outside Vite without touching the source.
 */
export async function resolve(spec, ctx, next) {
  if (/\?(worker|url|raw)/.test(spec)) return { url: 'data:text/javascript,export default ""', shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  const r = await next(url, ctx);
  if (url.includes('/src/') && r.source) {
    const s = r.source.toString();
    if (s.includes('import.meta.env')) return { ...r, source: 'import.meta.env ??= { BASE_URL: "/", DEV: false, PROD: true, MODE: "production" };\n' + s };
  }
  return r;
}
