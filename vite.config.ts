import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: true, port: 5175, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
