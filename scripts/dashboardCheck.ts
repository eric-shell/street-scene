/**
 * Renders the admin dashboard against fixture data at several widths and screenshots it loading and loaded,
 * with an open visitor's detail. Every `/api/admin` request is answered in the browser from
 * scripts/dashboardFixtures.ts, so it writes nothing, touches no database and needs no sign-in.
 *
 *   npm run check:dashboard -- [baseUrl] [outDir]      (default http://localhost:5175 and .; WIDTHS=412,360 narrows)
 *
 * Reports, per width: page errors, horizontal overflow (the document wider than the screen, and the elements
 * that nothing can scroll), and the GUTTER: content that escaped the page's own padding without the document
 * ever scrolling, which an overflow check alone misses (a card can sit flush with the screen edge, or a few px
 * past it). Anything inside a horizontal scroller is exempt: the visitor table is meant to extend inside its
 * own. The stubs HOLD their answers for HOLD_MS so the skeleton is on screen long enough to measure and
 * screenshot; answered at once, the skeleton would never render here and would drift unseen. Also checks that
 * paging lands the Visitors heading back at the top of the viewport.
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Page, type Route } from '@playwright/test';
import { buildFixtures } from './dashboardFixtures.ts';

const BASE = process.argv[2] ?? 'http://localhost:5175';
const OUT = process.argv[3] ?? '.';
/** Desktop, small laptop, tablet, Pixel 8, the narrow end of Android: below 721 px the table becomes cards. */
const WIDTHS = process.env.WIDTHS ? process.env.WIDTHS.split(',').map(Number) : [1440, 1024, 768, 412, 360];
/** How long the stubs sit on their answers (ms). Don't take the delay out. */
const HOLD_MS = 1500;

const fx = buildFixtures();

async function stub(page: Page, errors: string[]): Promise<void> {
  const hold = async (route: Route, body: unknown) => {
    await new Promise((r) => setTimeout(r, HOLD_MS));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  };
  await page.route('**/api/admin?*', async (route) => {
    const url = new URL(route.request().url());
    const op = url.searchParams.get('op');
    const method = route.request().method();
    if (op === 'session') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ email: 'admin@example.com', name: 'Harness Admin' }) });
    if (op === 'visitors') return hold(route, { visitors: fx.visitors });
    if (op === 'insights') return hold(route, { ...fx.insights, windowDays: Number(url.searchParams.get('days') ?? 30) });
    if (op === 'visitor') {
      if (method !== 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      const detail = fx.details.get(url.searchParams.get('id') ?? '') ?? fx.details.get(fx.target.id);
      return hold(route, detail);
    }
    return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Unknown op"}' });
  });
  // The dashboard must never send game analytics; fail loudly if it tries.
  await page.route('**/api/analytics*', (route) => {
    errors.push(`dashboard sent analytics: ${route.request().url()}`);
    return route.abort();
  });
}

interface Overflow {
  pageScrollW: number;
  pageClientW: number;
  bodyOverflows: boolean;
  offenders: { tag: string; cls: string; scrollW: number; clientW: number }[];
}

/** Elements wider than their own box that nothing can scroll: what a wide table does to a phone. */
function measureOverflow(): Overflow {
  const de = document.documentElement;
  const offenders: Overflow['offenders'] = [];
  const clipped = (el: Element) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return true;
    return false;
  };
  for (const el of document.querySelectorAll<HTMLElement>('main, section, div, table, ul')) {
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && getComputedStyle(el).overflowX === 'visible' && !clipped(el)) {
      offenders.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 70), scrollW: el.scrollWidth, clientW: el.clientWidth });
    }
  }
  return { pageScrollW: de.scrollWidth, pageClientW: de.clientWidth, bodyOverflows: de.scrollWidth > de.clientWidth + 1, offenders: offenders.slice(0, 6) };
}

/** The heights the skeleton must reserve: the totals row, the insight grid, and the first visitor row or card (px). */
function measureShape(): Record<string, number> {
  const h = (sel: string) => Math.round(document.querySelector(sel)?.getBoundingClientRect().height ?? -1);
  return { totals: h('.dashboard__totals'), insights: h('.insights__grid'), row: h('.visitor-table__row, .visitor-card') };
}

interface Gutter {
  left: number;
  right: number;
  offenders: { tag: string; cls: string; left: number; right: number }[];
}

/** Content outside the page's content box (.dashboard minus its padding), scrollers and read-only lists exempt. */
function measureGutter(): Gutter {
  const container = document.querySelector<HTMLElement>('.dashboard');
  if (!container) return { left: 0, right: 0, offenders: [] };
  const cs = getComputedStyle(container);
  const box = container.getBoundingClientRect();
  const left = box.left + parseFloat(cs.paddingLeft);
  const right = box.right - parseFloat(cs.paddingRight);
  const inScroller = (el: Element) => {
    for (let p = el.parentElement; p && p !== container; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return true;
    return false;
  };
  const offenders: Gutter['offenders'] = [];
  for (const el of container.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || el.closest('.sr-only')) continue;
    if (r.right <= right + 0.5 && r.left >= left - 0.5) continue;
    if (inScroller(el)) continue;
    offenders.push({ tag: el.tagName.toLowerCase(), cls: String(el.getAttribute('class') ?? '').slice(0, 60), left: Math.round(r.left), right: Math.round(r.right) });
  }
  return { left: Math.round(left), right: Math.round(right), offenders: offenders.slice(0, 6) };
}

function reportOverflow(label: string, o: Overflow): void {
  console.log(`${label.padEnd(18)}:`, o.bodyOverflows ? `YES  ${o.pageScrollW} > ${o.pageClientW}` : 'no');
  for (const x of o.offenders) console.log(`   unscrollable ${x.tag}.${x.cls} ${x.scrollW}>${x.clientW}`);
}

function reportGutter(label: string, g: Gutter): void {
  console.log(`${label.padEnd(18)}:`, g.offenders.length ? `BROKEN  content box ${g.left}-${g.right}` : 'ok');
  for (const o of g.offenders) console.log(`   ${o.tag}.${o.cls} [${o.left} -> ${o.right}]`);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
let failures = 0;

for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: 1100 }, deviceScaleFactor: 1 });
  // A previous visit three days ago, so the new-since-last-visit dots have something to mark.
  await ctx.addInitScript((at) => localStorage.setItem('nightrun.dashboard.lastVisit', at), new Date(Date.now() - 3 * 86_400_000).toISOString());
  // tsx compiles with esbuild's keepNames, which wraps the measuring functions' inner closures in __name(): give the page a no-op one.
  await ctx.addInitScript('window.__name = (f) => f');
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await stub(page, errors);

  await page.goto(`${BASE}/dashboard`, { waitUntil: 'load' });
  // The loading state, while the stubs still hold.
  await page.waitForTimeout(500);
  const skeletonOverflow = await page.evaluate(measureOverflow);
  const skeletonGutter = await page.evaluate(measureGutter);
  const skeletonShape = await page.evaluate(measureShape);
  await page.screenshot({ path: `${OUT}/dashboard-${width}-skeleton.png`, fullPage: true });

  await page.waitForSelector('.stat-tile:not(.is-loading)', { timeout: HOLD_MS * 4 });
  await page.waitForTimeout(900);
  const overflow = await page.evaluate(measureOverflow);
  const gutter = await page.evaluate(measureGutter);
  const shape = await page.evaluate(measureShape);
  await page.screenshot({ path: `${OUT}/dashboard-${width}.png`, fullPage: true });

  // Open the target row and screenshot its detail.
  const row = width < 721 ? page.locator('.visitor-card').first() : page.locator('.visitor-table__row').first();
  await row.click();
  await page.waitForSelector('.visitor-detail__pane', { timeout: HOLD_MS * 6 }).catch(async (e: Error) => {
    await page.screenshot({ path: `${OUT}/dashboard-${width}-detail-failed.png`, fullPage: false });
    throw e;
  });
  await page.waitForTimeout(500);
  const detailOverflow = await page.evaluate(measureOverflow);
  const detailGutter = await page.evaluate(measureGutter);
  await page.locator('.visitor-detail').first().screenshot({ path: `${OUT}/dashboard-${width}-detail.png` });
  await page.getByRole('tab', { name: /Races/ }).click();
  await page.waitForTimeout(200);
  await page.locator('.visitor-detail').first().screenshot({ path: `${OUT}/dashboard-${width}-races.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // Page to the last (part-filled) page: the Visitors heading must land back near the top of the viewport.
  const pages = Math.ceil(fx.visitors.length / 25);
  for (let p = 1; p < pages; p++) {
    await page.getByRole('button', { name: 'Next' }).click();
    await page.waitForTimeout(300);
  }
  // The smooth scroll back up a long phone page takes a while: wait until the heading stops moving.
  const top = () => page.evaluate(() => Math.round(document.getElementById('visitors-heading')?.getBoundingClientRect().top ?? -1));
  let headingTop = await top();
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(150);
    const next = await top();
    if (next === headingTop) break;
    headingTop = next;
  }

  console.log(`\n=== ${width}px ===`);
  console.log('page errors       :', errors.length ? errors : 'none');
  reportOverflow('skeleton overflow', skeletonOverflow);
  reportGutter('skeleton gutter', skeletonGutter);
  reportOverflow('loaded overflow', overflow);
  reportGutter('loaded gutter', gutter);
  reportOverflow('detail overflow', detailOverflow);
  reportGutter('detail gutter', detailGutter);
  // Informational: the jump each block makes when the data lands (the row count of a list is data, so not a failure).
  console.log('skeleton → loaded :', Object.keys(shape).map((k) => `${k} ${skeletonShape[k]}→${shape[k]} (${shape[k] - skeletonShape[k] >= 0 ? '+' : ''}${shape[k] - skeletonShape[k]})`).join(' · '));
  const pagerOk = headingTop >= 0 && headingTop < 120;
  console.log('pager scroll      :', pagerOk ? `ok (heading at ${headingTop}px)` : `OFF (heading at ${headingTop}px)`);
  const bad = errors.length > 0 || [skeletonOverflow, overflow, detailOverflow].some((o) => o.bodyOverflows || o.offenders.length > 0) || [skeletonGutter, gutter, detailGutter].some((g) => g.offenders.length > 0) || !pagerOk;
  if (bad) failures++;
  await ctx.close();
}

await browser.close();
console.log(`\n${failures === 0 ? 'PASS' : `ISSUES at ${failures} width(s)`}  (screenshots in ${OUT})`);
process.exitCode = failures === 0 ? 0 : 1;
