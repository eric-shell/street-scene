import { defineConfig } from 'vitest/config';
import type { Plugin, PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pkg from './package.json' with { type: 'json' };
import { apiDev } from './scripts/apiDev.ts';

function gitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

/**
 * The admin dashboard (src/admin/, React) is its own page, so players never download React: `/dashboard`
 * serves dashboard.html on the dev and preview servers, as vercel.json's rewrite does in production.
 */
function dashboardRoute(): Plugin {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    if (req.url && /^\/dashboard\/?(?:\?|$)/.test(req.url)) req.url = req.url.replace(/^\/dashboard\/?/, '/dashboard.html');
    next();
  };
  return {
    name: 'dashboard-route',
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

/**
 * React's plugin for the dashboard only: its transform runs on src/admin, and its Fast Refresh preamble is
 * injected into dashboard.html alone, so the game's page and modules are built exactly as before.
 */
function reactForDashboard(): PluginOption[] {
  const onlyDashboard = (p: Plugin): Plugin => {
    const hook = p.transformIndexHtml;
    if (!hook) return p;
    const handler = typeof hook === 'function' ? hook : hook.handler;
    const scoped: typeof handler = function (this: unknown, html, ctx) {
      return ctx.path.endsWith('dashboard.html') ? (handler as (this: unknown, h: string, c: typeof ctx) => ReturnType<typeof handler>).call(this, html, ctx) : html;
    } as typeof handler;
    return { ...p, transformIndexHtml: typeof hook === 'function' ? scoped : { ...hook, handler: scoped } };
  };
  return (react({ include: /\/src\/admin\/.*\.tsx?$/ }) as Plugin[]).map(onlyDashboard);
}

/**
 * The game's page enters through boot.ts (the splash), which imports main.ts dynamically, so Vite only fetches
 * the game's chunks once boot.ts has run. Preloading them from the HTML starts that download with the page's own
 * instead, a round trip or more sooner on a phone.
 */
function preloadGame(): Plugin {
  return {
    name: 'preload-game',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle || !ctx.path.endsWith('/index.html')) return;
        const chunks = Object.values(ctx.bundle).filter((c) => c.type === 'chunk');
        const main = chunks.find((c) => c.facadeModuleId?.endsWith('/src/main.ts'));
        if (!main) return;
        const files = new Set<string>();
        const visit = (file: string) => {
          if (files.has(file)) return;
          files.add(file);
          const c = chunks.find((x) => x.fileName === file);
          c?.imports.forEach(visit);
        };
        visit(main.fileName);
        return [...files].filter((f) => !html.includes(f)).map((f) => ({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: `/${f}` }, injectTo: 'head' as const }));
      },
    },
  };
}

export default defineConfig({
  // The account API (api/*.ts, Vercel functions) on the dev server too.
  plugins: [apiDev(), dashboardRoute(), ...reactForDashboard(), preloadGame()],
  server: { host: true, port: 5175, strictPort: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    // Three pages: the game, the admin dashboard with its own chunks (React and visx stay out of the game's), and
    // the 404 page, which Vercel serves as dist/404.html for any path that is not a file.
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        dashboard: fileURLToPath(new URL('./dashboard.html', import.meta.url)),
        notFound: fileURLToPath(new URL('./404.html', import.meta.url)),
      },
    },
  },
  // DevTools traces every style rule back to its .scss partial (dev only; builds ship no maps).
  css: { devSourcemap: true },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_HASH__: JSON.stringify(gitHash()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
