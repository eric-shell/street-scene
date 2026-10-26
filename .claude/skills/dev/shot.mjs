// One look at the running game for /dev, so no session writes its own Playwright script:
//   node .claude/skills/dev/shot.mjs '<path?params>' [out.png] [--eval expr] [--keys list] [--wait ms] [--size WxH] [--clip selector]
// Opens http://localhost:5175<path> in headless Chromium on software WebGL, waits for window.__nr, settles, holds or
// presses the --keys in order, then prints one JSON line: console errors, the --eval result and the ?fps meter's text.
// The screenshot is optional and small by default (960x540): every image read stays in the conversation and is paid
// for again on each later turn, so text answers come first.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const flags = {}; const pos = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) argv[i].startsWith('--') ? (flags[argv[i].slice(2)] = argv[++i]) : pos.push(argv[i]);
const [path = '/', out] = pos;
const [width, height] = (flags.size ?? '960x540').split('x').map(Number);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width, height } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
try {
  await page.goto(new URL(path, 'http://localhost:5175').href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__nr, null, { timeout: 90_000 });
  await page.waitForTimeout(Number(flags.wait ?? 2500));
  // 'KeyW:3000' holds W for 3 s; a bare 'Escape' is one press.
  for (const step of (flags.keys ?? '').split(',').filter(Boolean)) {
    const [key, ms] = step.split(':');
    if (!ms) { await page.keyboard.press(key); continue; }
    await page.keyboard.down(key); await page.waitForTimeout(Number(ms)); await page.keyboard.up(key);
  }
  const result = flags.eval ? await page.evaluate(flags.eval) : undefined;
  const fps = await page.evaluate(() => document.querySelector('.fps-meter')?.textContent || undefined);
  if (out) await (flags.clip ? page.locator(flags.clip).first() : page).screenshot({ path: out });
  console.log(JSON.stringify({ errors, result, fps, shot: out }));
} finally {
  await browser.close();
}
