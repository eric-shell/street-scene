/**
 * Browser tests (Playwright, `npm run e2e`) for what Vitest cannot reach: the
 * boot splash, the menu, the music player and anything else that needs a real
 * page. They run against the dev server on port 5175 and start it when it is
 * not already up. One worker: there is one server and WebGL runs on software
 * rendering in headless Chromium, so parallel pages would only fight for CPU.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5175',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5175',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
