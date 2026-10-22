#!/usr/bin/env node
/**
 * Look-preservation harness, capture side: drives a served Street Scene build
 * through a fixed list of UI states and dumps, per state and viewport, every
 * element under <body> (canvases excluded) with a structural path that ignores
 * classes and ids, its class and inline style (for reference), its own text,
 * its box, its attributes and its full computed style (plus ::before /
 * ::after / ::marker when generated). compare.mjs diffs two such dumps.
 *
 *   node capture.mjs <baseURL> <outDir> [renameMap.json] [options]
 *
 * Options:
 *   --only=<regex>        run flows / captures whose id matches (e.g. --only=garage|menu-settings)
 *   --viewports=a,b       desktop,phone (default); also laptop (1280x720) and landscape (844x390 touch)
 *   --concurrency=N       parallel flows (default 4; one browser, one context per flow)
 *   --settle=MS           wait before each capture (default 1500)
 *   --gl=metal|swiftshader  WebGL backend (default metal: real GPU, ~4x faster than software)
 *   --headed              show the browser
 *   --reduced-motion      emulate prefers-reduced-motion: reduce (dumps go to <viewport>-rm/)
 *
 * Determinism: every URL gets &seed=harness&quality=low; Math.random is a
 * seeded PRNG; media playback is faked (play() flips `paused` without playing,
 * duration reads 200 s) so the music widget is identical every run; races are
 * stepped by the harness (the session's own tick is disabled and the sim is run
 * to an exact tick) so the HUD shows the same race state each time; every
 * animation (CSS animations, transitions and WAAPI) is paused at currentTime 0
 * right before the dump. Google Fonts responses are cached on disk
 * (.fontcache beside this script, gitignored) so every context gets the same fonts.
 *
 * Selectors are written with the app's current class names and go through
 * sel(), which rewrites class tokens with renameMap.json's "classes" table
 * ({"current": "renamed"}; a mapped value with spaces becomes a compound
 * class selector): capture the build before a class rename without a map and
 * the build after it with one. Keyboard and role/text driving are used where
 * just as reliable. When the app's flows change (a new screen, a renamed
 * hook), update FLOWS below.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('playwright');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
if (pos.length < 2) {
  console.error('usage: node capture.mjs <baseURL> <outDir> [renameMap.json] [--only=re] [--viewports=desktop,phone] [--concurrency=4] [--settle=1500] [--gl=metal|swiftshader] [--headed]');
  process.exit(2);
}
const BASE = pos[0].endsWith('/') ? pos[0] : pos[0] + '/';
const OUT = path.resolve(pos[1]);
const RENAME = pos[2] ? JSON.parse(fs.readFileSync(pos[2], 'utf8')) : {};
const CLASS_MAP = RENAME.classes ?? {};
const ONLY = opt.only ? new RegExp(opt.only) : null;
const SETTLE = Number(opt.settle ?? 1500);
const CONCURRENCY = Number(opt.concurrency ?? 4);
const GL = opt.gl ?? 'metal';
const REDUCED = !!opt['reduced-motion'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_CACHE = path.join(HERE, '.fontcache');

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  laptop: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
  landscape: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const VPS = String(opt.viewports ?? 'desktop,phone').split(',').filter(Boolean);
for (const v of VPS) if (!VIEWPORTS[v]) throw new Error(`unknown viewport ${v}`);

// ---------------------------------------------------------------------------
// Selectors through the rename map
// ---------------------------------------------------------------------------
/** Rewrite the class tokens of a CSS / Playwright selector with the rename map (quoted strings and [attr] parts are left alone). */
export function sel(s) {
  if (!Object.keys(CLASS_MAP).length) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const j = s.indexOf(ch, i + 1);
      const end = j < 0 ? s.length : j + 1;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '[') {
      const j = s.indexOf(']', i);
      const end = j < 0 ? s.length : j + 1;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '.') {
      const m = /^-?[_a-zA-Z][\w-]*/.exec(s.slice(i + 1));
      if (m) {
        const to = CLASS_MAP[m[0]] ?? m[0];
        out += '.' + String(to).trim().split(/\s+/).join('.');
        i += 1 + m[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-page code
// ---------------------------------------------------------------------------
/** Runs before any page script: seeded Math.random, fake media playback, localStorage presets. */
function initScript({ preset, early, dumpSrc }) {
  let a = 0x2545f491;
  Math.random = function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const P = HTMLMediaElement.prototype;
  const state = new WeakMap();
  Object.defineProperty(P, 'paused', { configurable: true, get() { return state.get(this) ?? true; } });
  Object.defineProperty(P, 'duration', { configurable: true, get() { return 200; } });
  P.play = function play() {
    if (state.get(this) === false) return Promise.resolve();
    state.set(this, false);
    queueMicrotask(() => { this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')); });
    return Promise.resolve();
  };
  P.pause = function pause() {
    if (state.get(this) !== false) return;
    state.set(this, true);
    queueMicrotask(() => this.dispatchEvent(new Event('pause')));
  };
  // The freeze: every animation paused at currentTime 0, remembering where it was (see unfreezeInPage).
  const frozen = new Map();
  window.__harnessFreeze = (all = false) => {
    const list = [];
    for (const a of document.getAnimations()) {
      try {
        const eff = a.effect;
        const done = !all && a.playState === 'finished' && !frozen.has(a);
        list.push({ el: eff?.target ?? null, pe: eff?.pseudoElement ?? null, k: a.animationName !== undefined ? 'css' : a.transitionProperty !== undefined ? 'transition' : 'waapi', n: a.animationName ?? a.transitionProperty ?? a.id ?? '', f: done ? 1 : 0 });
        // A finished animation (filling forwards) already rests on its last frame, the same in every run: leave it there.
        if (done) continue;
        if (!frozen.has(a)) frozen.set(a, { t: a.currentTime, ps: a.playState });
        a.pause();
        a.currentTime = 0;
      } catch { /* ignore */ }
    }
    return list;
  };
  window.__harnessUnfreeze = () => {
    for (const [a, { t, ps }] of frozen) {
      try {
        if (ps === 'finished') a.finish();
        else {
          if (t !== null) a.currentTime = t;
          if (ps === 'running') a.play();
        }
      } catch { /* ignore */ }
    }
    frozen.clear();
  };
  // An early capture: dump the page in the very task where its condition first holds (every selector
  // matches), for states too short for a round trip from Node (the splash between hold and landing).
  if (early) {
    const dump = (0, eval)(`(${dumpSrc})`);
    const check = () => {
      if (window.__harnessEarly || !early.when.every((q) => document.querySelector(q))) return;
      window.__harnessEarly = dump({ all: true, volatile: early.volatile });
      window.__harnessUnfreeze();
      obs.disconnect();
    };
    const obs = new MutationObserver(check);
    obs.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  }
  if (preset) {
    try {
      if (!sessionStorage.getItem('__harnessPreset')) {
        for (const [k, v] of Object.entries(preset)) localStorage.setItem(k, v);
        sessionStorage.setItem('__harnessPreset', '1');
      }
    } catch { /* storage unavailable */ }
  }
}

/** Pause every animation (CSS animations, transitions, WAAPI) at currentTime 0 (window.__harnessFreeze, installed by initScript). */
function freezeInPage(all) {
  return window.__harnessFreeze(all).length;
}

/** Put every animation the freeze paused back where it was, running again if it was running, so the flow carries on as if nothing happened. */
function unfreezeInPage() {
  window.__harnessUnfreeze();
}

/** The dump: freeze, then every element's path, class, inline style, text, box, attributes, computed style and pseudo styles. */
function dumpInPage({ all, volatile }) {
  const anims = window.__harnessFreeze(all);
  // Text that changes on its own every frame (the fps meter) is recorded as volatile.
  const volatileEls = new Set(volatile.flatMap((s) => [...document.querySelectorAll(s)]));
  const cache = new Map();
  const pathOf = (el) => {
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    let p = cache.get(el);
    if (p) return p;
    let i = 1;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === el.localName) i++;
    p = `${el.parentElement ? pathOf(el.parentElement) : '?'}/${el.localName}[${i}]`;
    cache.set(el, p);
    return p;
  };
  const els = [document.documentElement, document.body, ...document.body.querySelectorAll('*')].filter((el) => el.localName !== 'canvas' && !el.closest('canvas'));
  const read = (cs) => {
    const o = {};
    for (let i = 0; i < cs.length; i++) {
      const p = cs.item(i);
      o[p] = cs.getPropertyValue(p);
    }
    return o;
  };
  const round = (n) => Math.round(n * 100) / 100;
  const rows = [];
  const styles = [];
  const pseudoStyles = [];
  for (const el of els) {
    const row = { p: pathOf(el) };
    const cls = el.getAttribute('class');
    if (cls) row.c = cls;
    const st = el.getAttribute('style');
    if (st) row.s = st;
    let text = '';
    for (const n of el.childNodes) if (n.nodeType === 3) text += n.nodeValue;
    text = text.replace(/\s+/g, ' ').trim();
    if (text) row.t = volatileEls.has(el) ? '(volatile)' : text.slice(0, 120);
    const attrs = [];
    for (const at of el.attributes) if (at.name !== 'class' && at.name !== 'style') attrs.push(`${at.name}=${at.value.length > 80 ? at.value.slice(0, 80) + '…' : at.value}`);
    if (attrs.length) row.a = attrs.join(' | ');
    const r = el.getBoundingClientRect();
    row.r = [round(r.x), round(r.y), round(r.width), round(r.height)];
    styles.push(read(getComputedStyle(el)));
    const pseudos = ['::before', '::after'];
    if (getComputedStyle(el).display === 'list-item') pseudos.push('::marker');
    for (const pe of pseudos) {
      const ps = getComputedStyle(el, pe);
      if (pe !== '::marker' && (ps.content === 'none' || ps.content === 'normal' || ps.content === '')) continue;
      row[pe] = pseudoStyles.length;
      pseudoStyles.push(read(ps));
    }
    rows.push(row);
  }
  // Compress: each property's most common value is the default; rows keep what differs (null = property absent).
  const modeOf = (list) => {
    const counts = new Map();
    for (const o of list) for (const k in o) {
      let m = counts.get(k);
      if (!m) counts.set(k, (m = new Map()));
      m.set(o[k], (m.get(o[k]) ?? 0) + 1);
    }
    const d = {};
    for (const [k, m] of counts) {
      let best = null;
      let bc = -1;
      for (const [v, c] of m) if (c > bc) { best = v; bc = c; }
      d[k] = best;
    }
    return d;
  };
  const sparse = (o, d) => {
    const s = {};
    for (const k in o) if (o[k] !== d[k]) s[k] = o[k];
    for (const k in d) if (!(k in o)) s[k] = null;
    return s;
  };
  const defaults = modeOf(styles);
  const pseudoDefaults = modeOf(pseudoStyles);
  rows.forEach((row, i) => {
    row.cs = sparse(styles[i], defaults);
    for (const pe of ['::before', '::after', '::marker']) if (pe in row) row[pe] = sparse(pseudoStyles[row[pe]], pseudoDefaults);
  });
  return {
    url: location.href,
    viewport: [innerWidth, innerHeight, devicePixelRatio],
    bodyClass: document.body.className,
    defaults,
    pseudoDefaults,
    anims: anims.map((a) => ({ t: a.el && a.el.isConnected ? pathOf(a.el) : null, pe: a.pe, k: a.k, n: a.n, f: a.f })),
    elements: rows,
  };
}

/** Elements whose text changes by itself every frame: dumped as '(volatile)'. */
const VOLATILE_TEXT = ['.fps-meter'];

// ---------------------------------------------------------------------------
// Flows: each one page load and the captures along it
// ---------------------------------------------------------------------------
const RACE_URL = (mode) => `?race=${mode}`;

/** Wait until the menu is up and the splash gone. */
async function menuReady(f) {
  await f.page.waitForSelector(sel('.title-lockup'), { state: 'visible', timeout: 60_000 });
  await f.page.waitForFunction((s) => !document.querySelector(s), sel('.splash'), { timeout: 60_000 });
  // The menu city's car on the street (the event map's live marker follows it).
  await f.page.waitForFunction(() => !!window.__nr?.stage?.car, null, { timeout: 30_000 }).catch(() => {});
  // Park it at a fixed place on its route with the stage clock stopped, so the live markers on the menu's
  // maps, the map's "You are in" and the places' distances are the same every run.
  await f.page.evaluate(() => {
    const st = window.__nr?.stage;
    if (!st || st.__harnessParked) return;
    st.__harnessParked = true;
    st.s = 150;
    st.time = 20;
    st.speed = 12;
    const step = st.step.bind(st);
    st.step = (dt, o) => step(0, o);
  });
}

/** Wait for a running race session. */
async function sessionReady(f) {
  await f.page.waitForFunction(() => !!window.__nr?.session, null, { timeout: 60_000 });
}

/**
 * Take the sim over: disable the session's own tick (the loop keeps rendering)
 * and step it to an exact tick, relative to the end of the countdown or to the
 * first tick. The intro shot is skipped.
 */
async function raceTo(f, rel, off) {
  return f.page.evaluate(([rel, off]) => {
    const s = window.__nr.session;
    if (!s.__harnessTick) {
      s.__harnessTick = s.tick.bind(s);
      s.tick = () => {};
    }
    try { s.skipCinematic(); } catch { /* not in the intro */ }
    const r = s.race;
    const base = rel === 'countdown' ? r.countdownTicks : r.config.start?.tick ?? 0;
    const target = base + off;
    let n = 0;
    while (r.tick < target && n++ < 20000) s.__harnessTick();
    return { tick: r.tick, target, phase: s.cine?.phase };
  }, [rel, off]);
}

async function waitStep(f, step) {
  await f.page.waitForSelector(`[data-step="${step}"]`, { timeout: 15_000 });
}

/** Open the full map from the HUD and capture it, hovered, then close it. */
async function hudMap(f, id) {
  // Through the session: on a phone the minimap sits under the touch controls' layer.
  await f.page.evaluate(() => window.__nr.session.toggleMap());
  await f.page.waitForSelector(sel('.full-map'), { state: 'visible' });
  await f.capture(`${id}-map`);
  await hoverCenter(f, '.full-map__canvas');
  await f.capture(`${id}-map-hover`, { hover: true });
  await f.page.keyboard.press('Escape');
  await f.page.waitForSelector(sel('.full-map'), { state: 'detached' });
}

/**
 * Open the screen's help with ?, capture it and close it with Escape; a screen
 * without a reachable help (the phone HUD) is skipped, not failed. Every screen
 * keeps its own (hidden) panel in the page, so "open" means a panel without
 * the hidden attribute.
 */
async function help(f, id, { close = true } = {}) {
  const open = sel('.help__panel') + ':not([hidden])';
  await f.soft(id, async () => {
    try {
      await f.page.keyboard.press('?');
      await f.page.waitForSelector(open, { state: 'visible', timeout: 3000 });
      await f.capture(id);
    } finally {
      // Escape closes an open panel before anything else sees it; without one it would back out of the screen.
      if (close && (await f.page.locator(open).count())) {
        await f.page.keyboard.press('Escape');
        await f.page.waitForSelector(open, { state: 'detached' });
      }
    }
  });
}

async function hoverCenter(f, s) {
  const box = await f.page.locator(sel(s)).first().boundingBox();
  if (!box) throw new Error(`no box for ${s}`);
  await f.page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2), { steps: 4 });
}

async function pauseScreens(f, id, { settings = false } = {}) {
  await f.page.keyboard.press('Escape');
  await f.page.waitForSelector(sel('.rail.pause-screen'), { state: 'visible' });
  await f.capture(`${id}-pause`);
  // The pause screen's own help (on touch screens the race's only one).
  if (settings) await help(f, `${id}-pause-help`);
  if (settings) {
    await f.click('.pause-screen__settings');
    await f.page.waitForSelector(sel('.rail.pause-screen .settings'), { state: 'visible' });
    await f.capture(`${id}-pause-settings`);
    await f.page.keyboard.press('Escape');
    await f.page.waitForSelector(sel('.rail.pause-screen .pause-screen__resume'), { state: 'visible' });
  }
  await f.page.keyboard.press('Escape');
  await f.page.waitForSelector(sel('.rail.pause-screen'), { state: 'detached' });
}

async function results(f, id) {
  await f.page.evaluate(() => {
    const s = window.__nr.session;
    s.onFinish({ race: s.race, tuned: false });
  });
  await f.page.waitForSelector(sel('.results-screen__actions'), { state: 'visible' });
  await f.capture(`${id}-results`);
}

const FLOWS = [
  {
    id: 'boot',
    url: '',
    early: ['.splash.is-playing', '.menu.is-pending'],
    async run(f) {
      // Taken in the page (flow.early) the moment the title is flashing in (.is-playing) over the menu built and held
      // invisible underneath (.menu.is-pending): the same phase every run, whichever came first.
      await f.captureEarly('splash');
      await menuReady(f);
      await f.capture('menu-home');
      await help(f, 'menu-home-help');
      await f.page.keyboard.press('h');
      await f.page.waitForFunction((c) => document.body.classList.contains(c), sel('.is-cinematic').slice(1));
      await f.capture('menu-cinematic');
      await f.page.keyboard.press('Shift');
      await f.page.waitForFunction((c) => !document.body.classList.contains(c), sel('.is-cinematic').slice(1));
      await f.click('[aria-label="Type a seed"]');
      await f.page.waitForSelector('input[aria-label="Seed"]');
      await f.capture('menu-seed-edit');
      await f.page.keyboard.press('Escape');
      await f.page.waitForSelector('input[aria-label="Seed"]', { state: 'detached' });
    },
  },
  {
    id: 'music',
    url: '',
    async run(f) {
      await menuReady(f);
      const pill = f.page.locator('[aria-label="Show music player"]');
      if (await pill.isVisible()) {
        // Phones start with the player minimized to its pill.
        await f.capture('music-pill');
        await pill.click();
        await f.capture('music-card');
      } else {
        await f.capture('music-card');
        await f.click('[aria-label="Minimize player"]');
        await f.capture('music-pill');
        await pill.click();
      }
      await f.click('[aria-label="Music library"]');
      await f.page.waitForSelector('[role="dialog"][aria-label="Music library"]', { state: 'visible' });
      await f.capture('music-library');
      await f.click('[role="dialog"][aria-label="Music library"] [aria-label="Close"]');
      await f.page.waitForSelector('[role="dialog"][aria-label="Music library"]', { state: 'detached' });
      // ] skips to the next track (the shuffle order is seeded): the "Now playing" banner shows for 5 s.
      await f.soft('music-banner', async () => {
        await f.page.keyboard.press(']');
        await f.page.waitForSelector(sel('.music-player__banner.is-visible'), { state: 'visible', timeout: 3000 });
        await f.capture('music-banner', { settle: 1200 });
      });
    },
  },
  {
    id: 'menu-map',
    url: '',
    async run(f) {
      await menuReady(f);
      await f.click('.event-map');
      await f.page.waitForSelector(sel('.full-map'), { state: 'visible' });
      await f.capture('menu-map');
      await hoverCenter(f, '.full-map__canvas');
      await f.capture('menu-map-hover', { hover: true });
      await f.page.getByRole('tab', { name: 'Places' }).click();
      await f.capture('menu-map-places');
      await f.page.locator(sel('.map-places__button')).first().hover();
      await f.capture('menu-map-places-hover', { hover: true });
    },
  },
  {
    id: 'menu-race',
    url: '',
    async run(f) {
      await menuReady(f);
      await f.click('.event-card__go');
      await waitStep(f, 'race');
      await f.capture('menu-race');
      // 1-6 pick the types in grid order: circuit, sprint, waypoint, drift, drag, roam.
      const order = ['circuit', 'sprint', 'waypoint', 'drift', 'drag', 'roam'];
      for (const [i, t] of order.entries()) {
        if (i === 0) continue;
        await f.page.keyboard.press(String(i + 1));
        await f.page.waitForSelector(`[data-mode="${t}"]`);
        await f.capture(`menu-race-${t}`);
      }
      await help(f, 'menu-race-help');
      await f.page.keyboard.press('1');
      await f.page.waitForSelector('[data-mode="circuit"]');
      await f.click('.course-map');
      await f.page.waitForSelector(sel('.full-map'), { state: 'visible' });
      await f.capture('menu-map-course');
    },
  },
  {
    id: 'menu-setup',
    url: '',
    async run(f) {
      await menuReady(f);
      await f.click('.event-card__go');
      await waitStep(f, 'race');
      const order = ['circuit', 'sprint', 'waypoint', 'drift', 'drag', 'roam'];
      for (const [i, t] of order.entries()) {
        await f.page.keyboard.press(String(i + 1));
        await f.page.waitForSelector(`[data-mode="${t}"]`);
        await f.click('.step-foot__next');
        await waitStep(f, 'setup');
        await f.capture(`menu-setup-${t}`);
        await f.page.keyboard.press('Escape');
        await waitStep(f, 'race');
      }
    },
  },
  {
    id: 'menu-settings',
    url: '',
    async run(f) {
      await menuReady(f);
      await f.click('.menu__settings');
      await waitStep(f, 'settings');
      await f.capture('menu-settings-display');
      for (const tab of ['Sound', 'Controls', 'Developer', 'Credits']) {
        await f.page.getByRole('tab', { name: tab }).click();
        await f.capture(`menu-settings-${tab.toLowerCase()}`);
        if (tab === 'Controls') {
          for (const dev of ['Gamepad', 'Touch']) {
            await f.page.getByRole('radio', { name: dev }).click();
            await f.capture(`menu-settings-controls-${dev.toLowerCase()}`);
          }
        }
      }
      await help(f, 'menu-settings-help', { close: false });
    },
  },
  {
    id: 'door',
    url: '',
    async run(f) {
      await menuReady(f);
      await f.click('.menu__garage');
      await f.page.waitForSelector(sel('.door.is-shut'), { timeout: 15_000 });
      await f.capture('door', { settle: 200, freezeAll: true });
    },
  },
  {
    id: 'wipe',
    url: '',
    async run(f) {
      await menuReady(f);
      await f.click('.event-card__go');
      await waitStep(f, 'race');
      await f.page.keyboard.press('2');
      await f.page.waitForSelector('[data-mode="sprint"]');
      await f.click('.step-foot__next');
      await waitStep(f, 'setup');
      // The race step slides out: start once it is gone, so the menu under the wipe is the same every run.
      await f.page.waitForFunction((s) => document.querySelectorAll(s).length === 1, sel('.rail__step'));
      await f.page.waitForTimeout(400);
      await f.click('.step-foot__start');
      await f.page.waitForSelector(sel('.wipe__card.is-entering'), { timeout: 15_000 });
      await f.capture('wipe', { settle: 200, freezeAll: true });
    },
  },
  {
    id: 'garage',
    url: '?garage',
    holdTraffic: true,
    async run(f) {
      await f.page.waitForSelector(sel('.loading'), { state: 'visible', timeout: 30_000 });
      await f.capture('loading', { settle: 300 });
      f.releaseTraffic();
      await f.page.waitForFunction(() => !!window.__nr?.garageScreen, null, { timeout: 60_000 });
      // The garage opens on its Builds step; the tabs are on Customize.
      await f.capture('garage-builds');
      await f.page.locator('.car-card__go').click();
      const tabs = f.page.locator('[role="tablist"][aria-label="Categories"] [role="tab"]');
      const n = await tabs.count();
      for (let i = 0; i < n; i++) {
        const name = (await tabs.nth(i).getAttribute('title')).toLowerCase();
        await tabs.nth(i).click();
        await f.capture(`garage-tab-${name}`);
      }
    },
  },
  {
    id: 'garage-extra',
    url: '?garage',
    async run(f) {
      await f.page.waitForFunction(() => !!window.__nr?.garageScreen, null, { timeout: 60_000 });
      await help(f, 'garage-help');
      await f.page.getByRole('radio', { name: 'Street' }).click();
      await f.page.waitForSelector(sel('.door'), { timeout: 15_000 });
      await f.page.waitForSelector(sel('.door'), { state: 'detached', timeout: 30_000 });
      await f.capture('garage-street');
      await f.page.keyboard.press('Control+Shift+KeyD');
      await f.page.waitForSelector(sel('.toast'), { state: 'visible' });
      await f.capture('garage-dev', { settle: 500 });
      await f.page.evaluate(async () => {
        const buf = await (await fetch(new URL('parts/proto_frontBumper_street.glb', location.href))).arrayBuffer();
        const dt = new DataTransfer();
        dt.items.add(new File([buf], 'proto_frontBumper_street.glb'));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true, bubbles: true }));
      });
      await f.page.getByRole('heading', { name: 'Preview part' }).waitFor({ timeout: 15_000 });
      await f.page.waitForSelector(sel('.toast'), { state: 'detached', timeout: 15_000 });
      await f.capture('garage-dev-drop');
    },
  },
  {
    id: 'race-circuit',
    url: RACE_URL('circuit'),
    async run(f) {
      await sessionReady(f);
      await raceTo(f, 'countdown', -70);
      await f.capture('race-circuit-countdown');
      await raceTo(f, 'countdown', 240);
      await f.capture('race-circuit');
      await help(f, 'race-circuit-help');
      await hudMap(f, 'race-circuit');
      await pauseScreens(f, 'race-circuit', { settings: true });
      await f.page.evaluate(() => window.__nr.session.toggleDrone());
      await f.capture('race-circuit-photo-drone');
      await f.page.evaluate(() => window.__nr.session.toggleDrone());
      await results(f, 'race-circuit');
    },
  },
  ...['sprint', 'drag', 'waypoint', 'drift'].map((mode) => ({
    id: `race-${mode}`,
    url: RACE_URL(mode),
    async run(f) {
      await sessionReady(f);
      await raceTo(f, 'countdown', 240);
      await f.capture(`race-${mode}`);
      if (mode === 'sprint') await hudMap(f, `race-${mode}`);
      if (mode === 'sprint' || mode === 'drift') await pauseScreens(f, `race-${mode}`);
      await results(f, `race-${mode}`);
    },
  })),
  {
    id: 'race-debug',
    url: RACE_URL('circuit'),
    preset: { 'nightrun.settings.v1': JSON.stringify({ debugMode: true }) },
    async run(f) {
      await sessionReady(f);
      await raceTo(f, 'countdown', 120);
      await f.page.waitForSelector(sel('.tuning-panel'), { state: 'visible' });
      await f.capture('race-debug-panels');
    },
  },
  {
    id: 'roam',
    url: '?freeroam',
    async run(f) {
      await sessionReady(f);
      await raceTo(f, 'start', 120);
      await f.capture('roam');
      await f.page.evaluate(() => window.__nr.session.toggleMap());
      await f.page.waitForSelector(sel('.full-map'), { state: 'visible' });
      await f.capture('roam-map');
      await hoverCenter(f, '.full-map__canvas');
      await f.capture('roam-map-hover', { hover: true });
      await f.page.mouse.down();
      await f.page.mouse.up();
      await f.capture('roam-map-waypoint', { hover: true });
      await f.page.keyboard.press('Escape');
      await f.page.waitForSelector(sel('.full-map'), { state: 'detached' });
      await f.capture('roam-waypoint');
      await pauseScreens(f, 'roam');
    },
  },
  {
    id: 'roam-debug',
    url: '?freeroam',
    preset: { 'nightrun.settings.v1': JSON.stringify({ debugMode: true }) },
    async run(f) {
      await sessionReady(f);
      await raceTo(f, 'start', 60);
      await f.page.waitForSelector(sel('.tuning-panel'), { state: 'visible' });
      await f.capture('roam-debug-panels');
    },
  },
  {
    id: 'drone',
    url: '?drone',
    async run(f) {
      await f.page.waitForSelector(sel('.drone-hud'), { state: 'visible', timeout: 60_000 });
      await f.capture('drone');
      await help(f, 'drone-help', { close: false });
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(FONT_CACHE, { recursive: true });

/** Serve Google Fonts from a disk cache (filled on first use) so every context and run gets identical fonts. */
async function fontRoute(route) {
  const url = route.request().url();
  const key = crypto.createHash('sha1').update(url).digest('hex');
  const file = path.join(FONT_CACHE, key);
  if (fs.existsSync(file + '.json')) {
    const meta = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
    return route.fulfill({ status: meta.status, headers: meta.headers, body: fs.readFileSync(file) });
  }
  try {
    const res = await route.fetch();
    const body = await res.body();
    const headers = res.headers();
    fs.writeFileSync(file, body);
    fs.writeFileSync(file + '.json', JSON.stringify({ url, status: res.status(), headers }));
    return route.fulfill({ status: res.status(), headers, body });
  } catch (e) {
    return route.abort();
  }
}

const summary = { baseURL: BASE, started: new Date().toISOString(), settle: SETTLE, gl: GL, viewports: VPS, renameMap: pos[2] ?? null, flows: [], captures: {} };

async function runFlow(browser, vpName, flow) {
  const t0 = Date.now();
  const vp = VIEWPORTS[vpName];
  const ctx = await browser.newContext({ ...vp, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: REDUCED ? 'reduce' : 'no-preference' });
  await ctx.addInitScript(initScript, {
    preset: flow.preset ?? null,
    early: flow.early ? { when: flow.early.map(sel), volatile: VOLATILE_TEXT.map(sel) } : null,
    dumpSrc: dumpInPage.toString(),
  });
  await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, fontRoute);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)));
  let release = () => {};
  if (flow.holdTraffic) {
    const held = new Promise((r) => (release = r));
    await page.route(/\/traffic\/traffic\.glb/, async (route) => {
      await held;
      await route.continue();
    });
  }
  const dir = path.join(OUT, REDUCED ? `${vpName}-rm` : vpName);
  fs.mkdirSync(dir, { recursive: true });
  const rec = { flow: flow.id, viewport: vpName, ok: true, error: null, captures: [], skipped: [], ms: 0, pageErrors: errors };
  const f = {
    page,
    vp: vpName,
    releaseTraffic: () => release(),
    click: (s) => page.locator(sel(s)).first().click(),
    /** Run an optional step: a failure is logged and recorded as skipped, and the flow goes on. */
    async soft(label, fn) {
      try {
        await fn();
      } catch (e) {
        const msg = String(e.message ?? e).split('\n')[0];
        rec.skipped.push(`${label}: ${msg}`);
        console.log(`  [${vpName}] ${label}: skipped (${msg})`);
      }
    },
    /**
     * Settle, freeze, dump, screenshot, unfreeze. freezeAll also rewinds finished animations to 0, for
     * screens caught mid transition (splash, wipe, door) where which ones have finished depends on timing.
     */
    async capture(id, { settle = SETTLE, hover = false, freezeAll = false } = {}) {
      if (ONLY && !ONLY.test(id) && !ONLY.test(flow.id)) return;
      const c0 = Date.now();
      if (!hover) await page.mouse.move(vp.viewport.width - 1, Math.round(vp.viewport.height * 0.45));
      await page.waitForTimeout(settle);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const data = await page.evaluate(dumpInPage, { all: freezeAll, volatile: VOLATILE_TEXT.map(sel) });
      data.scenario = id;
      data.viewportName = vpName;
      data.flow = flow.id;
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(data));
      await page.evaluate(freezeInPage, freezeAll);
      await page.screenshot({ path: path.join(dir, `${id}.jpg`), type: 'jpeg', quality: 80, caret: 'hide' }).catch((e) => console.log(`  [${vpName}] ${id}: screenshot failed: ${e.message}`));
      await page.evaluate(unfreezeInPage);
      const ms = Date.now() - c0;
      rec.captures.push(id);
      summary.captures[`${path.basename(dir)}/${id}`] = { flow: flow.id, elements: data.elements.length, ms };
      console.log(`  [${vpName}] ${id}: ${data.elements.length} elements, ${ms} ms`);
    },
    /** Save the flow's early capture (flow.early) once the page has taken it; the screenshot is from a moment later. */
    async captureEarly(id) {
      if (ONLY && !ONLY.test(id) && !ONLY.test(flow.id)) return;
      const c0 = Date.now();
      await page.waitForFunction(() => !!window.__harnessEarly, null, { timeout: 60_000 });
      const data = await page.evaluate(() => window.__harnessEarly);
      Object.assign(data, { scenario: id, viewportName: vpName, flow: flow.id, early: true });
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(data));
      await page.screenshot({ path: path.join(dir, `${id}.jpg`), type: 'jpeg', quality: 80, caret: 'hide' }).catch(() => {});
      rec.captures.push(id);
      summary.captures[`${path.basename(dir)}/${id}`] = { flow: flow.id, elements: data.elements.length, ms: Date.now() - c0 };
      console.log(`  [${vpName}] ${id}: ${data.elements.length} elements (early capture)`);
    },
  };
  try {
    await page.goto(BASE + (flow.url ? flow.url + '&' : '?') + 'seed=harness&quality=low', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await flow.run(f);
  } catch (e) {
    rec.ok = false;
    rec.error = String(e.message ?? e).split('\n').slice(0, 3).join(' / ');
    console.log(`  [${vpName}] flow ${flow.id} FAILED after [${rec.captures.join(', ')}]: ${rec.error}`);
    await page.screenshot({ path: path.join(dir, `_failed-${flow.id}.jpg`), type: 'jpeg', quality: 70 }).catch(() => {});
  } finally {
    release();
    rec.ms = Date.now() - t0;
    await ctx.close().catch(() => {});
  }
  return rec;
}

const T0 = Date.now();
const gpuArgs = GL === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ headless: !opt.headed, args: ['--mute-audio', ...gpuArgs] });
const tasks = [];
for (const flow of FLOWS) {
  if (ONLY && !ONLY.test(flow.id) && !flowMayCapture(flow)) continue;
  for (const v of VPS) tasks.push([v, flow]);
}
/** With --only matching capture ids rather than flow ids, run every flow (captures filter themselves). */
function flowMayCapture() {
  return !FLOWS.some((fl) => ONLY.test(fl.id));
}
// Longest flows first, so the pool does not end on a long straggler.
const weight = (fl) => (fl.id.startsWith('race-circuit') ? 4 : fl.id.startsWith('garage') || fl.id.startsWith('menu-race') || fl.id.startsWith('menu-setup') || fl.id === 'menu-settings' ? 3 : fl.id.startsWith('roam') && fl.id !== 'roam-debug' ? 2 : 1);
tasks.sort((a, b) => weight(b[1]) - weight(a[1]));
console.log(`capture ${BASE} -> ${OUT}: ${tasks.length} flow runs, concurrency ${CONCURRENCY}, settle ${SETTLE} ms, gl ${GL}`);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
    while (next < tasks.length) {
      const [v, flow] = tasks[next++];
      const rec = await runFlow(browser, v, flow);
      summary.flows.push(rec);
      console.log(`[${v}] flow ${flow.id}: ${rec.ok ? 'ok' : 'FAILED'} (${rec.captures.length} captures, ${(rec.ms / 1000).toFixed(1)} s)${rec.pageErrors.length ? `, ${rec.pageErrors.length} page errors` : ''}`);
    }
  }),
);
await browser.close();
summary.ms = Date.now() - T0;
summary.failed = summary.flows.filter((r) => !r.ok).map((r) => `${r.viewport}/${r.flow}: ${r.error}`);
summary.skipped = summary.flows.flatMap((r) => r.skipped.map((x) => `${r.viewport}/${x}`));
fs.writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(summary, null, 2));
console.log(`done in ${(summary.ms / 1000).toFixed(1)} s: ${Object.keys(summary.captures).length} captures, ${summary.failed.length} failed flows`);
for (const f of summary.failed) console.log(`  FAILED ${f}`);
for (const f of summary.skipped) console.log(`  skipped ${f}`);
