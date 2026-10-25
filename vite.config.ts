import { defineConfig } from 'vitest/config';
import { execSync } from 'node:child_process';
import pkg from './package.json' with { type: 'json' };
import { apiDev } from './scripts/apiDev.ts';

function gitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  // The account API (api/*.ts, Vercel functions) on the dev server too.
  plugins: [apiDev()],
  server: { host: true, port: 5175, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
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
