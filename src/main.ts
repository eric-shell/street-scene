/**
 * Boot, game loop and top level state machine:
 *   menu -> race -> results -> (retry | replay | garage | menu)
 *   menu -> garage -> menu / test drive
 *   menu -> free roam (open world on the event seed, or a new city from the pause menu) -> menu
 */
import './style.css';
import './ui/ui.css';
import * as THREE from 'three';
import { FixedStepLoop } from './loop';
import { createWorld, World } from './city/world';
import { seedFromString, Rng } from './sim/prng';
import { dailySeed, initialSeed } from './seed';
import { Settings, loadSettings, saveSettings } from './ui/settings';
import { AutoQualityController, MAX_LEVEL, QUALITY_LEVELS, autoLabel, deviceKey, guessLevel, loadRememberedLevel, readDeviceInfo, saveRememberedLevel } from './render/autoQuality';
import { GameRenderer, NightScene, createNightScene } from './render/scene';
import { FreeFlyCamera } from './render/freeFly';
import { CarAssetLibrary, manifestCar } from './render/carAssets';
import { InputManager } from './input/inputManager';
import { RaceSession } from './game/session';
import { DroneMode } from './game/drone';
import { MusicPlayer } from './audio/musicPlayer';
import { audioHub } from './audio/engineAudio';
import { MusicWidget } from './ui/musicWidget';
import { TuningPanel, applySavedTuning, loadSavedTuning } from './ui/tuningPanel';
import { CameraPanel, applySavedCameraParams } from './ui/cameraPanel';
import { loadingScreen, pauseMenu, resultsScreen, settingsScreen } from './ui/screens';
import { mainMenu } from './ui/menu';
import { showSplash } from './ui/splash';
import { toast } from './ui/dom';
import { Check, Info, Shuffle } from './ui/icons';
import { RaceConfig, RaceEntrant, RaceMode, standings, ticksToSeconds } from './sim/race';
import { CarBuild, PerformanceBuild, VisualBuild, defaultVisual, PAINT_FINISHES } from './sim/build';
import { DEFAULT_CAR_ID, PERFORMANCE_CATEGORIES, SELECTABLE_CAR_IDS, Tier } from './sim/tuning';
import { GarageState, decodeShareCode, loadGarage, saveGarage } from './garage/storage';
import { ReplayData, decodeLog, encodeLog, loadBest, loadGhost, loadLastReplay, saveGhost, saveLastReplay, submitBest } from './replay/replay';

type State = 'menu' | 'race' | 'garage' | 'freefly' | 'drone';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;
const settings: Settings = loadSettings();
const params = new URLSearchParams(location.search);
const qp = params.get('quality');
// ?quality= overrides for this session only; it is not saved unless the player picks graphics in settings.
const storedQuality = { quality: settings.quality, autoQuality: settings.autoQuality };
let urlQualityOverride = qp === 'auto' || qp === 'low' || qp === 'medium' || qp === 'high';
if (qp === 'low' || qp === 'medium' || qp === 'high') {
  settings.quality = qp;
  settings.autoQuality = false;
} else if (qp === 'auto') settings.autoQuality = true;
const gr = new GameRenderer(canvas, settings);

// Auto graphics: start from this device's last good level, else a heuristic guess.
const device = readDeviceInfo(gr.renderer.getContext());
const deviceId = deviceKey(device);
const guessedLevel = guessLevel(device);
const autoStart = () => loadRememberedLevel(deviceId) ?? guessedLevel;
const autoQ = new AutoQualityController(autoStart(), {
  ceiling: Math.max(autoStart(), Math.min(MAX_LEVEL, guessedLevel + 3)),
  onChange: () => applyAutoQuality(),
  onStable: (level) => saveRememberedLevel(deviceId, level),
});
function applyAutoQuality(): void {
  if (!settings.autoQuality) return;
  const lv = QUALITY_LEVELS[autoQ.level];
  settings.quality = lv.tier;
  gr.setAutoProfile(lv);
  // Fewer point lights right away (frames are slow); more wait for the next scene
  // because a light count change recompiles every lit shader mid race.
  for (const n of [backdrop?.night, session?.night]) if (n && n.lighting.poolSize > lv.pointLights) n.lighting.setPoolSize(lv.pointLights);
}
function persistSettings(): void {
  saveSettings(urlQualityOverride ? { ...settings, ...storedQuality } : settings);
}
const assets = new CarAssetLibrary();
const input = new InputManager(uiRoot);
const dev = new TuningPanel(uiRoot);
// Camera tuning (F3): saved tweaks apply to every race camera from boot.
const camPanel = new CameraPanel(uiRoot);
applySavedCameraParams();
/** What the running session is: a race (or replay), a garage test drive, or free roam. */
type SessionKind = 'race' | 'testDrive' | 'roam';
let sessionKind: SessionKind = 'race';
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
  drone = new DroneMode(gr, backdrop!.night, backdrop!.world, uiRoot, exitDrone);
  state = 'drone';
  syncMusicMode();
}

function exitDrone(): void {
  drone?.dispose();
  drone = null;
  showMenu();
}

function ensureBackdrop(): void {
  const seed = seedFromString(seedStr);
  if (backdrop && backdrop.seed === seed) return;
  backdrop?.night.dispose();
  const world = createWorld(seed, 'circuit');
  backdrop = { night: createNightScene(world, gr, settings), world, cam: new THREE.PerspectiveCamera(55, 1, 0.1, 2500), t: 0, seed };
  (window as unknown as Record<string, unknown>).__nr = { world, gr, backdrop, autoQ };
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
  // The photo mode drone lays the screen out like the drone flyover (its buttons sit where the race's compact player would).
  const photo = state === 'race' && !!session?.droneActive;
  const racing = state === 'race' && session && !session.paused && session.race.phase !== 'finished' && !photo;
  const context = photo ? 'drone' : state === 'race' ? 'race' : state === 'garage' ? 'garage' : state === 'drone' || state === 'freefly' ? 'drone' : 'menu';
  musicWidget.setMode(racing ? 'compact' : 'full', context);
  music.setDuck(state === 'race' && session?.paused ? 0.55 : 1);
}

/** The main menu's own overlay (settings, credits and dialogs replace it). */
let menuEl: HTMLElement | null = null;
/** Something other than the main menu is open on top of the menu city. */
const overlayBusy = () => overlay !== menuEl;

function setOverlay(el: HTMLElement | null): void {
  overlay?.remove();
  overlay = el;
  if (el) uiRoot.append(el);
  queueMicrotask(syncMusicMode);
}

function currentBuild(): CarBuild {
  return garage.slots[garage.current];
}

// Cinematic mode on the menu: every piece of UI fades out and the city flyover plays on its own.
// The first key, click or tap after that only brings the UI back (it never reaches a button).
let cinematic = false;
const cineHint = document.createElement('div');
cineHint.className = 'cine-hint';
cineHint.textContent = 'Press any key or click to show the menu';

function setCinematic(on: boolean): void {
  if (cinematic === on) return;
  cinematic = on;
  document.body.classList.toggle('cinematic', on);
  if (on) {
    document.body.append(cineHint);
    // Restart the hint's fade each time.
    cineHint.style.animation = 'none';
    void cineHint.offsetWidth;
    cineHint.style.animation = '';
  } else cineHint.remove();
}

function wakeFromCinematic(e: Event): void {
  if (!cinematic) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  setCinematic(false);
}
for (const type of ['keydown', 'pointerdown'] as const) window.addEventListener(type, wakeFromCinematic, { capture: true });
window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
  if (e.code === 'KeyH' && !e.repeat && !typing && state === 'menu' && !overlayBusy() && !e.ctrlKey && !e.metaKey && !e.altKey) setCinematic(true);
});

function showMenu(): void {
  setCinematic(false);
  state = 'menu';
  session?.dispose();
  session = null;
  garageScreen?.dispose();
  garageScreen = null;
  dev.close();
  camPanel.close();
  ensureBackdrop();
  // Catch the menu city up with any point light increase auto quality deferred.
  if (backdrop && backdrop.night.lighting.poolSize !== gr.profile.pointLights) backdrop.night.lighting.setPoolSize(gr.profile.pointLights);
  const seed = seedFromString(seedStr);
  setOverlay(
    mainMenu({
      seed: seedStr,
      isDaily,
      event: backdrop?.world.event,
      bests: { circuit: loadBest(seed, 'circuit'), sprint: loadBest(seed, 'sprint'), drift: loadBest(seed, 'drift') },
      carName: manifestCar(currentBuild().carId).displayName,
      hasReplay: !!loadLastReplay(),
      settings: { ...settings },
      music,
      onSettings: applySettings,
      onRace: (t) => (t === 'roam' ? startFreeRoam(seedStr) : startRace(t)),
      onGarage: () => void openGarage(),
      onReplay: () => {
        const r = loadLastReplay();
        if (r) startReplay(r);
      },
      onDrone: startDrone,
      onSeed: (s) => {
        isDaily = s === null;
        seedStr = s ?? dailySeed();
        const u = new URL(location.href);
        if (isDaily) u.searchParams.delete('seed');
        else u.searchParams.set('seed', seedStr);
        history.replaceState(null, '', u);
        showMenu();
      },
      onHideUi: () => setCinematic(true),
    }),
  );
  menuEl = overlay;
}

/** Take a changed copy of the settings: save them and apply what changed to the renderer, audio and panels. */
function applySettings(s: Settings): void {
  const qualityChanged = s.quality !== settings.quality || s.autoQuality !== settings.autoQuality;
  const autoTurnedOn = s.autoQuality && !settings.autoQuality;
  Object.assign(settings, s);
  if (qualityChanged) urlQualityOverride = false;
  if (autoTurnedOn) autoQ.reset(autoStart());
  if (settings.autoQuality) applyAutoQuality();
  persistSettings();
  gr.applySettings(settings);
  if (qualityChanged) {
    backdrop?.night.lighting.setPoolSize(gr.profile.pointLights);
    session?.night.lighting.setPoolSize(gr.profile.pointLights);
  }
  fpsEl.style.display = settings.showFps ? '' : 'none';
  audioHub()?.setVolume(settings.engineVolume);
  if (state === 'race') toggleTuningPanel(settings.debugTuningPanel);
  if (state === 'race') toggleCameraPanel(settings.debugCameraPanel);
}

/** Settings over the pause menu (the main menu has them as a step of its own). */
function openSettings(back: () => void): void {
  setOverlay(settingsScreen({ ...settings }, applySettings, back, music));
}

async function openGarage(): Promise<void> {
  setOverlay(loadingScreen('GARAGE'));
  const { GarageScreen } = await import('./garage/garageUi');
  session?.dispose();
  session = null;
  dev.close();
  camPanel.close();
  setOverlay(null);
  garageScreen?.dispose();
  garageScreen = new GarageScreen(gr, assets, uiRoot, garage, availability, {
    onChange: (g) => {
      garage = g;
      saveGarage(garage);
    },
    onExit: () => showMenu(),
    onTestDrive: () => startRace('circuit', true),
    engineVolume: () => settings.engineVolume,
  });
  (window as unknown as Record<string, unknown>).__nr = { garageScreen, gr, autoQ };
  state = 'garage';
  syncMusicMode();
}

// ---------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------
const AI_NAMES = ['Kenji', 'Vex', 'Rook', 'Mira', 'Dash', 'Nova', 'Juno', 'Sato', 'Riot', 'Lux'];

function opponentEntrants(seed: number, count: number, player: PerformanceBuild): { entrants: RaceEntrant[]; visuals: VisualBuild[] } {
  const rng = new Rng(seed ^ 0x51ce);
  const cars = SELECTABLE_CAR_IDS.filter((id) => availability[id]);
  if (!cars.length) cars.push(DEFAULT_CAR_ID);
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
    v.underglow = { ...v.underglow, enabled: rng.chance(0.6), color: '#' + new THREE.Color().setHSL(rng.next(), 1, 0.55).getHexString(), pattern: rng.pick(['steady', 'pulse', 'breathe'] as const) };
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
    laps: testDrive ? 10 : mode === 'circuit' ? 3 : mode === 'drift' ? 2 : 1,
    player: { name: 'You', carId: build.carId, performance: build.performance },
    opponents: opp.entrants,
    difficulty: settings.difficulty,
    manualGearbox: settings.manualGearbox,
    tractionControl: settings.tractionControl,
    // Test drive: free roam on the open seed map (no barriers, rails, parked cars, crowds or rivals).
    openWorld: testDrive || undefined,
  };
  const ghostData = count === 0 && !testDrive ? loadGhost(seed, mode) : null;
  runSession(config, [build.visual, ...opp.visuals], null, ghostData, testDrive ? 'testDrive' : 'race');
}

/**
 * Free roam: the whole city of a seed as an open world (no route, barriers,
 * rails, parked cars, crowds or rivals), with the player's build and none of
 * the test drive tuning. It never finishes; the pause menu goes back to the
 * start, to a new random city, or to the menu.
 */
function startFreeRoam(seedText: string): void {
  garageScreen?.dispose();
  garageScreen = null;
  const build = currentBuild();
  const config: RaceConfig = {
    seed: seedFromString(seedText),
    mode: 'circuit',
    laps: 1,
    player: { name: 'You', carId: build.carId, performance: build.performance },
    opponents: [],
    difficulty: settings.difficulty,
    manualGearbox: settings.manualGearbox,
    tractionControl: settings.tractionControl,
    openWorld: true,
  };
  runSession(config, [build.visual], null, null, 'roam');
}

function startReplay(r: ReplayData): void {
  runSession(r.config, r.visuals, r, null, 'race');
}

function runSession(config: RaceConfig, visuals: VisualBuild[], replay: ReplayData | null, ghost: ReplayData | null, kind: SessionKind): void {
  const testDrive = kind === 'testDrive';
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
    // Start / finish camera shots; test drives and free roam go straight to driving.
    cinematics: kind === 'race',
  });
  state = 'race';
  sessionKind = kind;
  syncMusicMode();
  loop.resetAccumulator();
  if (testDrive) {
    // Test drive: apply this car's saved physics tuning.
    const player = session.race.cars[0];
    if (applySavedTuning(player.tuning, loadSavedTuning(player.carId)) > 0) session.tuned = true;
  }
  // The tuning panel shows when its debug setting is on (` / F2 toggles it anyway).
  if (settings.debugTuningPanel && !replay) toggleTuningPanel(true);
  if (settings.debugCameraPanel) toggleCameraPanel(true);
  const s = session;
  (window as unknown as Record<string, unknown>).__nr = { session: s, gr, autoQ };
  s.onFinish = ({ race, tuned }) => {
    if (s !== session) return;
    if (testDrive) return void openGarage();
    if (kind === 'roam') return showMenu();
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
        event: race.world.event?.name,
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
        onRetry: () => (replay ? startReplay(replay) : runSession(race.config, visuals, null, race.config.opponents.length ? null : loadGhost(race.config.seed, race.config.mode), 'race')),
        onReplay: () => startReplay(replay ?? data),
        onGarage: () => void openGarage(),
        onMenu: showMenu,
      }),
    );
  };
}

function togglePause(): void {
  if (state !== 'race' || !session) return;
  // Escape in the photo mode drone flies back to the car instead of pausing.
  if (session.droneActive) return session.toggleDrone();
  // Escape on the free roam city map closes the map instead of pausing.
  if (session.mapOpen) return session.closeMap();
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
        onRestart: () => lastConfig && runSession(lastConfig, lastVisuals, null, lastConfig.opponents.length || lastConfig.openWorld ? null : loadGhost(lastConfig.seed, lastConfig.mode), sessionKind),
        restartLabel: sessionKind === 'race' ? undefined : 'Back to the start',
        extra: sessionKind === 'roam' ? [{ icon: Shuffle, label: 'New city', onClick: () => startFreeRoam(String(Math.floor(Math.random() * 1e8))) }] : undefined,
        onSettings: () => openSettings(showPause),
        onQuit: () => (sessionKind === 'testDrive' ? void openGarage() : showMenu()),
      }),
    );
  showPause();
}

input.on('pause', togglePause);
// 0: the drone flyover from the menu (and back); in a race the session flies its own photo mode drone.
input.onView((n) => {
  if (n !== 0) return;
  if (state === 'menu' && !overlayBusy()) startDrone();
  else if (state === 'drone') exitDrone();
});
/** Show or hide the physics tuning panel for the current race (no argument = toggle). */
function toggleTuningPanel(show = !dev.open): void {
  if (state !== 'race' || !session || session.isReplay) return;
  if (!show) return dev.close();
  if (dev.open) return;
  const s = session;
  dev.show(s.race.cars[0].tuning, s.race.config.player.performance, () => (s.tuned = true));
}
input.on('dev', () => toggleTuningPanel());
/** Show or hide the camera tuning panel during a race, replays included (no argument = toggle). */
function toggleCameraPanel(show = !camPanel.open): void {
  if (state !== 'race' || !session) return;
  if (!show) return camPanel.close();
  if (!camPanel.open) camPanel.show();
}
input.on('cameraPanel', () => toggleCameraPanel());
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
fpsEl.className = 'fps-meter';
fpsEl.style.display = settings.showFps || params.has('fps') ? '' : 'none';
document.body.appendChild(fpsEl);
let frames = 0;
let fpsAcc = 0;
/** Whether the session's photo mode drone was up last frame (it toggles inside the session, on its own keys). */
let photoDrone = false;

const loop = new FixedStepLoop({
  tick() {
    if (state === 'race') session?.tick();
    else if (state === 'garage') garageScreen?.tick();
  },
  render(alpha, dt) {
    if (state === 'race' && session) {
      session.render(alpha, dt);
      if (session.droneActive !== photoDrone) {
        photoDrone = session.droneActive;
        syncMusicMode();
      }
    } else if (state === 'garage' && garageScreen) garageScreen.render(dt);
    else if (state === 'drone' && drone) drone.render(dt);
    else if (state === 'freefly' && fly && backdrop) {
      fly.update(dt);
      backdrop.night.lighting.update(fly.camera.position);
      backdrop.night.update((backdrop.t += dt));
      gr.render(backdrop.night.scene, fly.camera, dt);
    } else renderBackdrop(dt);
    // Auto quality only measures real gameplay frames (not menus, pauses, results or loading).
    const playing = (state === 'race' && !!session && !session.paused && session.race.phase !== 'finished') || state === 'drone' || state === 'freefly';
    autoQ.frame(dt, settings.autoQuality && playing && !document.hidden);
    frames++;
    fpsAcc += dt;
    if (fpsAcc > 0.5) {
      // fps, frame time against the 8.3 / 16.7 / 33 ms budget lines, and what auto quality is doing.
      fpsEl.textContent =
        `${Math.round(frames / fpsAcc)} fps · ${((fpsAcc / frames) * 1000).toFixed(1)} ms` +
        (settings.autoQuality ? ` · ${autoLabel(autoQ.level)} ${autoQ.level + 1}/${QUALITY_LEVELS.length} aim ${Math.round(1 / autoQ.aim)}` : '');
      frames = 0;
      fpsAcc = 0;
    }
  },
});

async function boot(): Promise<void> {
  applyAutoQuality();
  const direct = params.get('race');
  const deepLink = direct === 'circuit' || direct === 'sprint' || direct === 'drift' || params.has('garage') || params.has('drone') || params.has('freeroam');
  // A normal start flashes the title in over the asset check and lands it on the
  // menu; deep links go straight to their screen behind a plain loading card.
  // On document.body, not #ui: it has to cover the music widget, which lives there too.
  const splash = deepLink ? null : showSplash(document.body);
  const loading = splash ? null : loadingScreen('STREET SCENE');
  if (loading) uiRoot.append(loading);
  availability = await assets.availability();
  const code = params.get('build');
  let notice: (() => void) | null = null;
  if (code) {
    const b = await decodeShareCode(code);
    if (b) {
      garage.slots.push(b);
      if (garage.slots.length > 6) garage.slots.shift();
      garage.current = garage.slots.length - 1;
      saveGarage(garage);
      notice = () => toast(`Loaded shared build "${b.name}"`, Check);
    } else notice = () => toast('That build code could not be read', Info);
    const u = new URL(location.href);
    u.searchParams.delete('build');
    history.replaceState(null, '', u);
  }
  loading?.remove();
  if (direct === 'circuit' || direct === 'sprint' || direct === 'drift') startRace(direct);
  else if (params.has('garage')) void openGarage();
  else if (params.has('drone')) startDrone();
  else if (params.has('freeroam')) startFreeRoam(seedStr);
  else showMenu();
  loop.start();
  if (splash) {
    // The city renders under the black meanwhile, so its first (slow) frames are spent unseen.
    splash.hold(overlay);
    await splash.intro;
    await splash.land(overlay);
  }
  notice?.();
}

void boot();
