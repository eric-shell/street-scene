/**
 * The mix as the player hears it: every kind of sound on its own, right at
 * the listener, with every level at its default, measured in dBFS at the
 * output and held against TARGETS (docs/audioMix.md explains the balance).
 * Nothing here needs the game's screens: a synthetic page imports the audio
 * modules straight from Vite, so a broken menu cannot hide a broken mix, and
 * each tap sits on the node a source really feeds (a dynamic import can get
 * its own module instance and hub, so taps on an imported hub would be silent).
 */
import { expect, test } from '@playwright/test';

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>audio mix</title></head><body><button id="go">go</button></body></html>';

/** Target RMS (dBFS at the output) with a tolerance (dB), each source alone and close; peaks are reported, not bounded. */
const TARGETS: Record<string, [rms: number, tolerance: number]> = {
  engineMid: [-19, 3],
  engineIdle: [-25, 4],
  garageIdle: [-36, 3],
  garageRev: [-16, 3],
  streetCruise: [-30, 3],
  streetRev: [-17, 3],
  crash20: [-13, 3],
  crash8: [-18, 4],
  wall15: [-11, 3],
  rail10: [-17, 4],
  dumpster15: [-16, 4],
  garbageCan12: [-20, 4],
  bush12: [-25, 5],
  beep: [-15, 3],
  go: [-15, 3],
  firework: [-14, 3],
  horn: [-18, 3],
  carAlarm: [-26, 3],
  trafficHorn: [-26, 3],
  nitro: [-21, 3],
  crowdLoop: [-21, 3],
  crowdCheer: [-18, 3],
  train: [-24, 3],
  heli: [-28, 4],
  thunderNear: [-18, 3],
  thunderFar: [-25, 4],
  bell: [-24, 3],
  cityBed: [-34, 3],
  garageBed: [-34, 3],
  garageFan: [-37.5, 3],
  garageCompressor: [-32.5, 3],
  garagePull: [-32.5, 3],
  garageWeld: [-45, 4],
  uiPress: [-32, 3],
  uiTick: [-48, 5],
  uiWhoosh: [-32, 3],
  uiDoorUp: [-32, 3],
};

/** One-shots of the workshop, measured at the room's centre: their peak (dBFS) stays under the ceiling, a few dB over the bed's -34. */
const PEAK_CEILING: Record<string, number> = { garageGun: -29, garageRatchet: -29, garageStrike: -28 };

interface Level {
  rms: number;
  peak: number;
}

const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-6));

test('every sound sits where the mix puts it', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.route('**/__audio-mix.html', (route) => route.fulfill({ body: PAGE, contentType: 'text/html' }));
  await page.goto('/__audio-mix.html');
  await page.click('#go');
  // Plain JS as a string: a test transform must not inject helpers into the page.
  const levels = (await page.evaluate(`(async () => {
    const audio = await import('/src/audio/engineAudio.ts');
    const sfxMod = await import('/src/audio/sfx.ts');
    const sceneMod = await import('/src/audio/sceneVoices.ts');
    const bellMod = await import('/src/audio/warningBell.ts');
    const uiMod = await import('/src/audio/uiSound.ts');
    const manifest = (await import('/src/assets/carManifest.json')).default;
    const hub = audio.audioHub();
    await hub.ctx.resume();
    await hub.worklet;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const buf = new Float32Array(4096);
    const analysers = new Map();
    const tapOf = (node) => { let an = analysers.get(node); if (!an) { an = node.context.createAnalyser(); an.fftSize = 4096; node.connect(an); analysers.set(node, an); } return an; };
    // The hub's defaults: master 0.7 squared, buses times 0.9. A bus tap still needs the master; a voice's own out needs both.
    const MASTER = 0.49, BUS = 0.9;
    let tap = null, scale = MASTER;
    const measure = async (ms) => {
      let rms = 0, peak = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        const an = tapOf(tap);
        an.getFloatTimeDomainData(buf);
        let sq = 0, pk = 0;
        for (const v of buf) { sq += v * v; pk = Math.max(pk, Math.abs(v)); }
        rms = Math.max(rms, Math.sqrt(sq / buf.length));
        peak = Math.max(peak, pk);
        await sleep(40);
      }
      return { rms: rms * scale, peak: peak * scale };
    };
    const results = {};
    const pos = { proximity: 1, pan: 0 };
    const sfx = new sfxMod.Sfx();
    sfx.setListener(0, 0, 1, 0);
    tap = sfx.bus;
    await sleep(1500);
    const shots = {
      crash20: () => sfx.crash(20, pos), crash8: () => sfx.crash(8, pos), wall15: () => sfx.wall(15, 'wall', pos), rail10: () => sfx.wall(10, 'rail', pos),
      dumpster15: () => sfx.prop('dumpster', 15, pos), garbageCan12: () => sfx.prop('garbageCan', 12, pos), bush12: () => sfx.prop('bush', 12, pos),
      beep: () => sfx.beep(false), go: () => sfx.beep(true), firework: () => sfx.firework(0, 20, 0, 1),
    };
    for (const [name, fire] of Object.entries(shots)) { fire(); results[name] = await measure(900); await sleep(600); }
    sfx.horn(true); results.horn = await measure(800); sfx.horn(false); await sleep(500);
    const alarmMod = await import('/src/audio/carAlarm.ts');
    const hornMod = await import('/src/audio/carHorn.ts');
    const alarm = new alarmMod.AlarmVoice(hub.ctx, hub.effectsBus, { pattern: 'wail', len: 5, base: 1100, stretch: 1 }, 0, 4, alarmMod.alarmPlace(0, 0, { x: 0, z: 0, rx: 1, rz: 0 }));
    await sleep(300); results.carAlarm = await measure(900); alarm.stop(false); await sleep(800);
    const hornOut = hub.ctx.createGain(); hornOut.gain.value = hornMod.HORN.level; hornOut.connect(hub.effectsBus);
    hornMod.playHorn(hub.ctx, hornOut, { at: hub.ctx.currentTime + 0.05, hz: 425, beeps: 1, len: 0.9, gap: 0.14, start: (src, at, end) => { src.start(at); src.stop(end); } });
    results.trafficHorn = await measure(800); await sleep(500);
    const car = { x: 0, z: 0, yaw: 0, vx: 0, vz: 30, nitro: true, halfLength: 2, halfWidth: 0.9 };
    let t = performance.now();
    const nitroRun = (async () => { const end = performance.now() + 2000; while (performance.now() < end) { const now = performance.now(); sfx.updateCars([car], null, (now - t) / 1000, false); t = now; await sleep(16); } car.nitro = false; sfx.updateCars([car], null, 0.016, false); })();
    await sleep(1200); results.nitro = await measure(700); await nitroRun; await sleep(500);
    tap = sfx.ambience;
    // The crowd recordings load lazily: on a cold cache the fetch and decode outlast the loop's warm up, so wait for them.
    sfx.loadCrowd();
    for (const t0 = performance.now(); !(sfx.cheerBuf && sfx.applauseBuf) && performance.now() - t0 < 20000; ) await sleep(100);
    const spot = { ax: -3, az: 2, bx: 3, bz: 2, level: 1.2, kind: 'section' };
    const crowdRun = (async () => { const end = performance.now() + 3500; while (performance.now() < end) { sfx.updateCrowds([spot], false); await sleep(50); } sfx.updateCrowds([], false); })();
    await sleep(2500); results.crowdLoop = await measure(900); await crowdRun; await sleep(800);
    sfx.crowdCheer(0, 2, 1.6, true); await sleep(400); results.crowdCheer = await measure(1200); await sleep(2500);
    const train = sceneMod.TrainRumble.create(); tap = train.out; scale = MASTER * BUS;
    const trainRun = (async () => { const end = performance.now() + 1800; while (performance.now() < end) { train.update(1, 17, 0); await sleep(30); } })();
    await sleep(600); results.train = await measure(900); await trainRun; await sleep(900);
    const heli = sceneMod.HeliRotor.create(); tap = heli.out;
    const heliRun = (async () => { const end = performance.now() + 1800; while (performance.now() < end) { heli.update(1, 0); await sleep(30); } })();
    await sleep(600); results.heli = await measure(900); await heliRun; await sleep(900);
    const thunder = sceneMod.Thunder.create(); tap = thunder.bus; scale = MASTER;
    thunder.strike(200, 1, 0); results.thunderNear = await measure(1500); await sleep(2500);
    thunder.strike(1800, 1, 0); results.thunderFar = await measure(1500); await sleep(2500);
    const bell = bellMod.WarningBell.create(); tap = bell.out; scale = MASTER * BUS;
    const bellRun = (async () => { const end = performance.now() + 1800; while (performance.now() < end) { bell.update(1, 0); await sleep(30); } })();
    await sleep(600); results.bell = await measure(900); await bellRun; await sleep(900);
    const bed = (await import('/src/audio/cityAmbience.ts')).CityAmbience.create({ seed: 20261019, mood: 'clear', el: false, water: false }); tap = bed.out; scale = MASTER * BUS;
    const bedRun = (async () => { const end = performance.now() + 2400; let t = 0; while (performance.now() < end) { t += 0.03; bed.update(t, 0.03, 0, 0); await sleep(30); } })();
    await sleep(900); results.cityBed = await measure(900); await bedRun; bed.dispose(); await sleep(500);
    const gar = await import('/src/audio/garageAmbience.ts');
    const shop = await import('/src/garage/shopSchedule.ts');
    // The workshop's bed. Each source is heard alone (the others' layers disconnected from a fresh instance) at a frozen
    // showroom clock chosen where the schedule is doing just that, so the number is the source and not the room.
    const sched = shop.createShopState();
    const find = (pred) => { for (let t = 5; t < 4000; t += 0.05) { shop.shopSchedule(t, sched); if (pred(sched)) return t; } throw new Error('the schedule never does that'); };
    const clock = {
      quiet: find((s) => s.compressor === 0 && s.release === 0 && s.gun < 0 && s.ratchet < 0 && s.weld === 0),
      comp: find((s) => s.compressor === 1 && s.release === 0 && s.gun < 0 && s.ratchet < 0 && s.weld === 0),
      gun: find((s) => s.gun >= 0 && s.gunAge > 0.1 && s.compressor === 0 && s.release === 0 && s.weld === 0),
      weld: find((s) => s.weld === 1 && s.compressor === 0 && s.release === 0 && s.gun < 0 && s.ratchet < 0),
      ratchet: find((s) => s.ratchet >= 0 && s.ratchetClick === 0 && s.ratchetPhase < 0.05 && s.compressor === 0 && s.release === 0 && s.weld === 0) - 0.5,
    };
    const spots = gar.SOUND_SPOTS;
    const centre = { x: 0, z: 0, yaw: 0 };
    const threeFrom = (p) => ({ x: p.x - 3, z: p.z, yaw: Math.PI / 2 });
    const garage = async (only, at, listener, pull, ms, frozen) => {
      const g = gar.GarageAmbience.create();
      await g.out.context.resume();
      tap = g.out; scale = MASTER * BUS;
      if (only) {
        for (const [k, l] of Object.entries(g.layers)) if (!only.includes(k)) l.node.disconnect();
        for (const [k, n] of Object.entries(g.gates)) if (!only.includes(k)) n.disconnect();
      }
      let stop = false; const start = performance.now();
      const loop = (async () => { let last = performance.now(); while (!stop) { const now = performance.now(); g.update((now - last) / 1000, { time: frozen ? at : at + (now - start) / 1000, listener, flicker: 1, dynoRpm: pull, active: true }); last = now; await sleep(16); } })();
      await sleep(900);
      const r = await measure(ms); stop = true; await loop; g.dispose(); await sleep(100);
      return r;
    };
    results.garageBed = await garage(null, clock.comp, centre, 0.7, 900, true);
    results.garageFan = await garage(['fan'], clock.quiet, centre, -1, 700, true);
    results.garageCompressor = await garage(['motor', 'rattle'], clock.comp, threeFrom(spots.compressor), -1, 700, true);
    results.garagePull = await garage(['dyno'], clock.quiet, threeFrom(spots.dyno), 0.8, 700, true);
    results.garageWeld = await garage(['arc', 'crackle'], clock.weld, threeFrom(spots.welder), -1, 700, true);
    results.garageGun = await garage(['gun', 'gunHiss'], clock.gun, centre, -1, 700, true);
    results.garageRatchet = await garage(['click'], clock.ratchet, centre, -1, 2500, false);
    results.garageStrike = await garage(['arc', 'crackle', 'strike'], clock.weld - 1.4, centre, -1, 2500, false);
    const voice = new audio.EngineVoice(manifest.cars.find((c) => c.id === 'wendtStrom').engine, 0.26);
    tap = voice.pan; scale = MASTER * BUS;
    const drive = async (rpm, load, ms) => { const end = performance.now() + ms; let last = performance.now(); while (performance.now() < end) { const now = performance.now(); voice.update({ rpm, redline: 7200, throttle: load, nitro: false, proximity: 1, pan: 0, dt: (now - last) / 1000 }); last = now; await sleep(16); } };
    await drive(3500, 1, 1200); const engRun = drive(3500, 1, 1000); results.engineMid = await measure(900); await engRun;
    const idleRun = drive(850, 0, 1800); await sleep(800); results.engineIdle = await measure(900); await idleRun;
    voice.dispose();
    // The garage's engine, through the same level curve the garage scene uses (src/garage/revModel.ts).
    const revMod = await import('/src/garage/revModel.ts');
    const gv = new audio.EngineVoice(manifest.cars.find((c) => c.id === 'wendtStrom').engine, revMod.REV_LEVEL.base);
    tap = gv.pan;
    const rev = async (mode, rpm, rest, pedal, ms) => { const end = performance.now() + ms; let last = performance.now(); while (performance.now() < end) { const now = performance.now(); const l = revMod.revVoice(mode, rpm, rest, 7200, pedal); gv.update({ rpm, redline: 7200, throttle: l.throttle, nitro: false, proximity: l.proximity, pan: 0, dt: (now - last) / 1000 }); last = now; await sleep(16); } };
    const cruise = 900 + 0.28 * (7200 - 900);
    const shots2 = [['garageIdle', 'garage', 900, 900, 0], ['garageRev', 'garage', 6800, 900, 1], ['streetCruise', 'street', cruise, cruise, 0], ['streetRev', 'street', 6800, cruise, 1]];
    for (const [name, mode, rpm, rest, pedal] of shots2) { await rev(mode, rpm, rest, pedal, 1000); const run = rev(mode, rpm, rest, pedal, 1000); results[name] = await measure(900); await run; }
    gv.dispose();
    // Menu sounds: the press first, since the hover and slide sounds wait for one (uiSound.ts live).
    tap = hub.uiBus; scale = MASTER; tapOf(tap); await sleep(200);
    const ui = { uiPress: () => uiMod.uiPress(), uiTick: () => uiMod.uiTick(), uiWhoosh: () => uiMod.uiWhoosh(), uiDoorUp: () => uiMod.uiDoorUp(0.9) };
    for (const [name, fire] of Object.entries(ui)) { fire(); results[name] = await measure(1000); await sleep(400); }
    return results;
  })()`)) as Record<string, Level>;

  const rows = Object.entries(TARGETS).map(([name, [target, tol]]) => {
    const l = levels[name];
    return { name, rms: +db(l.rms).toFixed(1), peak: +db(l.peak).toFixed(1), target, tol };
  });
  console.log(rows.map((r) => `${r.name.padEnd(12)} rms ${String(r.rms).padStart(6)}  peak ${String(r.peak).padStart(6)}  target ${r.target} ±${r.tol}`).join('\n'));
  const peaks = Object.entries(PEAK_CEILING).map(([name, ceiling]) => ({ name, peak: +db(levels[name].peak).toFixed(1), ceiling }));
  console.log(peaks.map((p) => `${p.name.padEnd(16)} peak ${String(p.peak).padStart(6)}  ceiling ${p.ceiling}`).join('\n'));
  for (const p of peaks) expect(p.peak, `${p.name} peak ${p.peak} dBFS, ceiling ${p.ceiling}`).toBeLessThanOrEqual(p.ceiling);
  for (const r of rows) expect(Math.abs(r.rms - r.target), `${r.name} rms ${r.rms} dBFS, target ${r.target} ±${r.tol}`).toBeLessThanOrEqual(r.tol);
  // The relations that matter more than any one number.
  const rms = (n: string) => db(levels[n].rms);
  expect(rms('crowdLoop'), 'a crowd bed stays under the engine').toBeLessThan(rms('engineMid') - 3);
  expect(rms('train'), 'a train bed stays under the engine').toBeLessThan(rms('engineMid') - 3);
  expect(rms('cityBed'), 'the city bed sits well under the engine and the crowd').toBeLessThan(rms('crowdLoop') - 6);
  expect(db(levels.crash20.peak), 'a hard crash tops the engine').toBeGreaterThan(db(levels.engineMid.peak));
  expect(rms('thunderFar'), 'far thunder is far').toBeLessThan(rms('thunderNear') - 5);
  expect(db(levels.uiPress.peak), 'a menu press peaks over the menu music').toBeGreaterThan(-26);
  expect(rms('beep'), 'the countdown is heard over an idling engine').toBeGreaterThan(rms('engineIdle') + 6);
  expect(rms('garageIdle'), 'the garage idles under the music').toBeLessThan(-26 - 8);
  expect(rms('streetCruise'), 'the Street view cruises under the music').toBeLessThan(-26 - 3);
  expect(rms('garageBed'), 'the shop bed sits under the music').toBeLessThan(-26 - 6);
  expect(rms('garageFan'), 'the fan is the loudest steady source of the room').toBeGreaterThan(rms('garageBed') - 6);
  expect(rms('streetRev') - rms('streetCruise'), 'a rev swells over the cruise').toBeGreaterThan(9);
  expect(errors).toEqual([]);
});
