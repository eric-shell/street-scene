/**
 * Boot, game loop and top level state machine:
 *   menu -> race -> results -> (retry | replay | garage | menu)
 *   menu -> garage -> menu / test drive
 */
import './style.css';
import './ui/ui.css';
import * as THREE from 'three';
import { FixedStepLoop } from './loop';
import { createWorld, World } from './city/world';
import { seedFromString, Rng } from './sim/prng';
import { dailySeed, initialSeed } from './seed';
import { Settings, loadSettings, saveSettings, QUALITY } from './ui/settings';
import { GameRenderer, NightScene, createNightScene } from './render/scene';
import { FreeFlyCamera } from './render/freeFly';
import { CarAssetLibrary, MANIFEST, manifestCar } from './render/carAssets';
import { InputManager } from './input/inputManager';
import { RaceSession } from './game/session';
import { DroneMode } from './game/drone';
import { MusicPlayer } from './audio/musicPlayer';
import { MusicWidget } from './ui/musicWidget';
import { DevPanel } from './ui/devPanel';
import { creditsScreen, loadingScreen, mainMenu, pauseMenu, resultsScreen, settingsScreen } from './ui/screens';
import { toast } from './ui/dom';
import { Check, Info } from './ui/icons';
import { RaceConfig, RaceEntrant, RaceMode, standings, ticksToSeconds } from './sim/race';
import { CarBuild, PerformanceBuild, VisualBuild, defaultVisual, PAINT_FINISHES } from './sim/build';
import { PERFORMANCE_CATEGORIES, Tier } from './sim/tuning';
import { GarageState, decodeShareCode, loadGarage, saveGarage } from './garage/storage';
import { ReplayData, decodeLog, encodeLog, loadBest, loadGhost, loadLastReplay, saveGhost, saveLastReplay, submitBest } from './replay/replay';

type State = 'menu' | 'race' | 'garage' | 'freefly' | 'drone';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;
const settings: Settings = loadSettings();
const params = new URLSearchParams(location.search);
const qp = params.get('quality');
if (qp === 'low' || qp === 'medium' || qp === 'high') settings.quality = qp;
const gr = new GameRenderer(canvas, settings);
const assets = new CarAssetLibrary();
const input = new InputManager(uiRoot);
const dev = new DevPanel(uiRoot);
// One player for the whole app: music carries on across every screen.
const music = new MusicPlayer();
const musicWidget = new MusicWidget(document.body, music);
let garage: GarageState = loadGarage();
let seedStr = initialSeed();
let isDaily = !params.get('seed');

let state: State = 'menu';
let session: RaceSession | null = null;
let overlay: HTMLElement | null = null;
let lastConfig: RaceConfig | null = null;
let lastVisuals: VisualBuild[] = [];
let availability: Record<string, boolean> = {};
let garageScreen: { tick(): void; render(dt: number): void; dispose(): void } | null = null;

// ---------------------------------------------------------------------------
// Menu backdrop: the event city with a slow cinematic camera.
// ---------------------------------------------------------------------------
let backdrop: { night: NightScene; world: World; cam: THREE.PerspectiveCamera; t: number; seed: number } | null = null;
let fly: FreeFlyCamera | null = null;
let drone: DroneMode | null = null;

function startDrone(): void {
  ensureBackdrop();
  setOverlay(null);
  drone?.dispose();
  drone = new DroneMode(gr, backdrop!.night, backdrop!.world, uiRoot, () => {
    drone?.dispose();
    drone = null;
    showMenu();
  });
  state = 'drone';
  syncMusicMode();
}

function ensureBackdrop(): void {
  const seed = seedFromString(seedStr);
  if (backdrop && backdrop.seed === seed) return;
  backdrop?.night.dispose();
  const world = createWorld(seed, 'circuit');
  backdrop = { night: createNightScene(world, gr, settings), world, cam: new THREE.PerspectiveCamera(55, 1, 0.1, 2500), t: 0, seed };
  (window as unknown as Record<string, unknown>).__nr = { world, gr, backdrop };
}

function renderBackdrop(dt: number): void {
  if (!backdrop) return;
  backdrop.t += dt;
  const route = backdrop.world.route;
  const s = (backdrop.t * 9) % route.length;
  let i = route.cum.findIndex((c) => c > s);
  if (i < 1) i = 1;
  const a = route.points[i - 1];
  const b = route.points[i];
  const t = (s - route.cum[i - 1]) / Math.max(1, route.cum[i] - route.cum[i - 1]);
  const x = a.x + (b.x - a.x) * t;
  const z = a.z + (b.z - a.z) * t;
  backdrop.cam.position.set(x, 22 + Math.sin(backdrop.t * 0.2) * 6, z);
  backdrop.cam.lookAt(x + (b.x - a.x) * 0.5 + 30 * Math.sin(backdrop.t * 0.05), 4, z + (b.z - a.z) * 0.5 + 30 * Math.cos(backdrop.t * 0.05));
  backdrop.night.lighting.update(backdrop.cam.position);
  backdrop.night.update(backdrop.t);
  gr.post.setSpeedBlur(0);
  gr.render(backdrop.night.scene, backdrop.cam, dt);
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------
function syncMusicMode(): void {
  const racing = state === 'race' && session && !session.paused && session.race.phase !== 'finished';
  musicWidget.setMode(racing ? 'compact' : 'full');
  music.setDuck(state === 'race' && session?.paused ? 0.55 : 1);
}

function setOverlay(el: HTMLElement | null): void {
  overlay?.remove();
  overlay = el;
  if (el) uiRoot.append(el);
  queueMicrotask(syncMusicMode);
}

function currentBuild(): CarBuild {
  return garage.slots[garage.current];
}

function showMenu(): void {
  state = 'menu';
  session?.dispose();
  session = null;
  garageScreen?.dispose();
  garageScreen = null;
  dev.close();
  ensureBackdrop();
  const seed = seedFromString(seedStr);
  setOverlay(
    mainMenu({
      seed: seedStr,
      isDaily,
      bests: { circuit: loadBest(seed, 'circuit'), sprint: loadBest(seed, 'sprint'), drift: loadBest(seed, 'drift') },
      carName: `${currentBuild().name} · ${manifestCar(currentBuild().carId).displayName}`,
      hasReplay: !!loadLastReplay(),
      onRace: (m) => startRace(m),
      onGarage: () => void openGarage(),
      onReplay: () => {
        const r = loadLastReplay();
        if (r) startReplay(r);
      },
      onDrone: startDrone,
      onSettings: () => openSettings(showMenu),
      onCredits: () => setOverlay(creditsScreen(showMenu)),
      onSeed: (s) => {
        isDaily = s === null;
        seedStr = s ?? dailySeed();
        const u = new URL(location.href);
        if (isDaily) u.searchParams.delete('seed');
        else u.searchParams.set('seed', seedStr);
        history.replaceState(null, '', u);
        showMenu();
      },
    }),
  );
}

function openSettings(back: () => void): void {
  setOverlay(
    settingsScreen(
      { ...settings },
      (s) => {
        const qualityChanged = s.quality !== settings.quality;
        Object.assign(settings, s);
        saveSettings(settings);
        gr.applySettings(settings);
        if (qualityChanged) {
          backdrop?.night.lighting.setPoolSize(QUALITY[settings.quality].pointLights);
          session?.night.lighting.setPoolSize(QUALITY[settings.quality].pointLights);
        }
        fpsEl.style.display = settings.showFps ? '' : 'none';
      },
      back,
      music,
    ),
  );
}

async function openGarage(): Promise<void> {
  setOverlay(loadingScreen('GARAGE'));
  const { GarageScreen } = await import('./garage/garageUi');
  session?.dispose();
  session = null;
  dev.close();
  setOverlay(null);
  garageScreen?.dispose();
  garageScreen = new GarageScreen(gr, assets, uiRoot, garage, availability, {
    onChange: (g) => {
      garage = g;
      saveGarage(garage);
    },
    onExit: () => showMenu(),
    onTestDrive: () => startRace('circuit', true),
  });
  (window as unknown as Record<string, unknown>).__nr = { garageScreen, gr };
  state = 'garage';
  syncMusicMode();
}

// ---------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------
const AI_NAMES = ['Kenji', 'Vex', 'Rook', 'Mira', 'Dash', 'Nova', 'Juno', 'Sato', 'Riot', 'Lux'];

function opponentEntrants(seed: number, count: number, player: PerformanceBuild): { entrants: RaceEntrant[]; visuals: VisualBuild[] } {
  const rng = new Rng(seed ^ 0x51ce);
  const cars = MANIFEST.cars.map((c) => c.id).filter((id) => availability[id] || id === 'proto');
  const avgTier = PERFORMANCE_CATEGORIES.reduce((s, c) => s + player[c], 0) / PERFORMANCE_CATEGORIES.length;
  const names = rng.shuffle(AI_NAMES.slice());
  const entrants: RaceEntrant[] = [];
  const visuals: VisualBuild[] = [];
  for (let i = 0; i < count; i++) {
    const perf = {} as PerformanceBuild;
    for (const c of PERFORMANCE_CATEGORIES) perf[c] = Math.max(0, Math.min(3, Math.round(avgTier + rng.range(-0.6, 0.6)))) as Tier;
    const carId = cars[rng.int(0, cars.length - 1)];
    entrants.push({ name: names[i], carId, performance: perf });
    const v = defaultVisual();
    v.paint.color = '#' + new THREE.Color().setHSL(rng.next(), 0.8, 0.5).getHexString();
    v.paint.finish = rng.pick(PAINT_FINISHES);
    v.underglow = { enabled: rng.chance(0.5), color: '#' + new THREE.Color().setHSL(rng.next(), 1, 0.55).getHexString(), pattern: 'steady' };
    v.stance.rideHeight = -rng.range(0, 0.05);
    visuals.push(v);
  }
  return { entrants, visuals };
}

function startRace(mode: RaceMode, testDrive = false): void {
  garageScreen?.dispose();
  garageScreen = null;
  const seed = seedFromString(seedStr);
  const build = currentBuild();
  const count = mode === 'drift' || testDrive ? 0 : settings.opponents;
  const opp = opponentEntrants(seed, count, build.performance);
  const config: RaceConfig = {
    seed,
    mode,
    laps: mode === 'circuit' ? 3 : mode === 'drift' ? 2 : 1,
    player: { name: 'You', carId: build.carId, performance: build.performance },
    opponents: opp.entrants,
    difficulty: settings.difficulty,
    manualGearbox: settings.manualGearbox,
  };
  const ghostData = count === 0 && !testDrive ? loadGhost(seed, mode) : null;
  runSession(config, [build.visual, ...opp.visuals], null, ghostData, testDrive);
}

function startReplay(r: ReplayData): void {
  runSession(r.config, r.visuals, r, null, false);
}

function runSession(config: RaceConfig, visuals: VisualBuild[], replay: ReplayData | null, ghost: ReplayData | null, testDrive: boolean): void {
  session?.dispose();
  dev.close();
  setOverlay(null);
  lastConfig = config;
  lastVisuals = visuals;
  session = new RaceSession(gr, assets, input, settings, uiRoot, {
    config,
    visuals,
    replay: replay ? { ...replay, decoded: decodeLog(replay.log) } : undefined,
    ghost: ghost ? { config: ghost.config, log: decodeLog(ghost.log), visual: ghost.visuals[0] } : null,
  });
  state = 'race';
  syncMusicMode();
  loop.resetAccumulator();
  const s = session;
  (window as unknown as Record<string, unknown>).__nr = { session: s, gr };
  s.onFinish = ({ race, tuned }) => {
    if (s !== session) return;
    if (testDrive) return void openGarage();
    syncMusicMode();
    const st = standings(race);
    const me = st.find((x) => x.car.isPlayer)!;
    const data: ReplayData = {
      v: 1,
      config: race.config,
      log: encodeLog(race.inputLog),
      visuals,
      result: { time: me.time, position: me.position, score: race.drift.total },
      date: new Date().toISOString(),
    };
    let newBest = false;
    if (!replay) {
      saveLastReplay(data);
      if (!tuned) {
        newBest = submitBest(race.config.seed, race.config.mode, { time: me.time, score: race.drift.total, carId: race.config.player.carId, date: data.date });
        if (newBest && race.config.opponents.length === 0) saveGhost(race.config.seed, race.config.mode, data);
      }
    }
    setOverlay(
      resultsScreen({
        mode: race.config.mode,
        rows: st.map((x) => ({
          name: x.car.name,
          car: manifestCar(x.car.carId).displayName,
          time: x.time,
          estimated: x.estimated,
          me: x.car.isPlayer,
          bestLap: x.car.bestLap && race.config.mode === 'circuit' ? ticksToSeconds(x.car.bestLap) : null,
        })),
        position: me.position,
        driftScore: race.drift.total,
        newBest,
        tuned,
        onRetry: () => (replay ? startReplay(replay) : runSession(race.config, visuals, null, race.config.opponents.length ? null : loadGhost(race.config.seed, race.config.mode), false)),
        onReplay: () => startReplay(replay ?? data),
        onGarage: () => void openGarage(),
        onMenu: showMenu,
      }),
    );
  };
}

function togglePause(): void {
  if (state !== 'race' || !session) return;
  if (session.paused) {
    session.paused = false;
    setOverlay(null);
    syncMusicMode();
    return;
  }
  if (session.race.phase === 'finished') return;
  session.paused = true;
  input.releaseAll();
  const showPause = () =>
    setOverlay(
      pauseMenu({
        onResume: togglePause,
        onRestart: () => lastConfig && runSession(lastConfig, lastVisuals, null, lastConfig.opponents.length ? null : loadGhost(lastConfig.seed, lastConfig.mode), false),
        onSettings: () => openSettings(showPause),
        onQuit: showMenu,
      }),
    );
  showPause();
}

input.on('pause', togglePause);
input.on('dev', () => {
  if (state !== 'race' || !session || session.isReplay) return;
  const s = session;
  dev.toggle(s.race.cars[0].tuning, () => (s.tuned = true));
});
input.on('freecam', () => {
  if (state === 'freefly') {
    fly?.dispose();
    fly = null;
    showMenu();
  } else if (state === 'menu' && backdrop) {
    state = 'freefly';
    setOverlay(null);
    fly = new FreeFlyCamera(canvas);
    fly.set(backdrop.cam.position.clone(), 0, -0.3);
  }
});

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const fpsEl = document.createElement('div');
fpsEl.style.cssText = 'position:fixed;top:6px;right:8px;font:12px monospace;color:#8f8;z-index:100;pointer-events:none';
fpsEl.style.display = settings.showFps || params.has('fps') ? '' : 'none';
document.body.appendChild(fpsEl);
let frames = 0;
let fpsAcc = 0;

const loop = new FixedStepLoop({
  tick() {
    if (state === 'race') session?.tick();
    else if (state === 'garage') garageScreen?.tick();
  },
  render(alpha, dt) {
    if (state === 'race' && session) session.render(alpha, dt);
    else if (state === 'garage' && garageScreen) garageScreen.render(dt);
    else if (state === 'drone' && drone) drone.render(dt);
    else if (state === 'freefly' && fly && backdrop) {
      fly.update(dt);
      backdrop.night.lighting.update(fly.camera.position);
      backdrop.night.update((backdrop.t += dt));
      gr.render(backdrop.night.scene, fly.camera, dt);
    } else renderBackdrop(dt);
    frames++;
    fpsAcc += dt;
    if (fpsAcc > 0.5) {
      fpsEl.textContent = `${Math.round(frames / fpsAcc)} fps`;
      frames = 0;
      fpsAcc = 0;
    }
  },
});

async function boot(): Promise<void> {
  const loading = loadingScreen('NIGHT RUN');
  uiRoot.append(loading);
  availability = await assets.availability();
  const code = params.get('build');
  if (code) {
    const b = await decodeShareCode(code);
    if (b) {
      garage.slots.push(b);
      if (garage.slots.length > 6) garage.slots.shift();
      garage.current = garage.slots.length - 1;
      saveGarage(garage);
      toast(`Loaded shared build "${b.name}"`, Check);
    } else toast('That build code could not be read', Info);
    const u = new URL(location.href);
    u.searchParams.delete('build');
    history.replaceState(null, '', u);
  }
  loading.remove();
  const direct = params.get('race');
  if (direct === 'circuit' || direct === 'sprint' || direct === 'drift') startRace(direct);
  else if (params.has('garage')) void openGarage();
  else if (params.has('drone')) startDrone();
  else showMenu();
  loop.start();
}

void boot();
