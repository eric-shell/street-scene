/**
 * Serves the Vercel functions under `api/` from `npm run dev`, so accounts work locally without `vercel dev`
 * and the dev server stays on its one port. The handlers use the Web signature (a `GET`/`POST`/... export
 * taking a `Request`, returning a `Response`), which Vercel runs as is and which is a few lines to bridge
 * from Node's request here. `.env.local` (and the other Vite env files) reach the handlers' `process.env`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, type Plugin } from 'vite';

export function apiDev(): Plugin {
  return {
    name: 'api-dev',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root;
      for (const [k, v] of Object.entries(loadEnv(server.config.mode, root, ''))) process.env[k] ??= v;
      server.middlewares.use(async (req, res, next) => {
        const name = /^\/api\/([a-z][\w-]*)(?:[/?]|$)/i.exec(req.url ?? '')?.[1];
        if (!name) return next();
        const file = join(root, 'api', `${name}.ts`);
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        try {
          const handler = (await server.ssrLoadModule(file))[req.method ?? 'GET'] as ((r: Request) => Response | Promise<Response>) | undefined;
          if (typeof handler !== 'function') {
            res.statusCode = 405;
            res.end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
          const response = await handler(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
          res.statusCode = response.status;
          response.headers.forEach((v, k) => k !== 'set-cookie' && res.setHeader(k, v));
          const cookies = response.headers.getSetCookie();
          if (cookies.length) res.setHeader('set-cookie', cookies);
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (e) {
          if (e instanceof Error) server.ssrFixStacktrace(e);
          next(e);
        }
      });
    },
  };
}
