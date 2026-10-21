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
import { createWorld } from './city/world';
import { seedFromString, Rng } from './sim/prng';
import { dailySeed, initialSeed } from './seed';
import { Settings, loadSettings, saveSettings } from './ui/settings';
import { AutoQualityController, MAX_LEVEL, QUALITY_LEVELS, autoLabel, deviceKey, guessLevel, loadRememberedLevel, readDeviceInfo, saveRememberedLevel } from './render/autoQuality';
import { GameRenderer } from './render/scene';
import { FreeFlyCamera } from './render/freeFly';
import { CarAssetLibrary, manifestCar } from './render/carAssets';
import { InputManager } from './input/inputManager';
import { RaceSession } from './game/session';
import { DroneMode } from './game/drone';
import { StreetStage } from './game/streetStage';
import { ShowreelCamera } from './game/streetCameras';
import { MusicPlayer } from './audio/musicPlayer';
import { audioHub } from './audio/engineAudio';
import { MusicWidget } from './ui/musicWidget';
import { TuningPanel, applySavedTuning, loadSavedTuning } from './ui/tuningPanel';
import { CameraPanel, applySavedCameraParams } from './ui/cameraPanel';
import { loadingScreen, pauseMenu, resultsScreen, type PauseScreen } from './ui/screens';
import { railInset } from './ui/rail';
import { mainMenu } from './ui/menu';
import { showSplash } from './ui/splash';
import { toast } from './ui/dom';
import { Check, Info, Shuffle } from './ui/icons';
import { RaceConfig, RaceEntrant, RaceMode, positionOf, standings, ticksToSeconds } from './sim/race';
import { routeSample } from './city/route';
import { loadTrafficAssets } from './render/traffic';
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
  for (const n of [stage?.night, session?.night]) if (n && n.lighting.poolSize > lv.pointLights) n.lighting.setPoolSize(lv.pointLights);
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
// The menu city: the event city with the player's car cruising its route
// (game/streetStage.ts). The showreel shoots it behind the menu, the drone and
// the free camera fly over it, and the garage's Street view drives it.
// ---------------------------------------------------------------------------
let stage: StreetStage | null = null;
const showreel = new ShowreelCamera();
let fly: FreeFlyCamera | null = null;
let drone: DroneMode | null = null;

function startDrone(): void {
  const st = ensureStage();
  setOverlay(null);
  drone?.dispose();
  drone = new DroneMode(gr, st.night, st.world, uiRoot, exitDrone, { drive: (dt, focus) => st.step(dt, { focus }) });
  state = 'drone';
  syncMusicMode();
}

function exitDrone(): void {
  drone?.dispose();
  drone = null;
  showMenu();
}

/** The street stage for the current seed, built (with the current build on it) when the seed changes. */
function ensureStage(): StreetStage {
  const seed = seedFromString(seedStr);
  if (stage && stage.world.seed === seed) return stage;
  stage?.dispose();
  stage = new StreetStage(gr, assets, createWorld(seed, 'circuit'), settings);
  void stage.setBuild(currentBuild());
  showreel.cut();
  (window as unknown as Record<string, unknown>).__nr = { world: stage.world, gr, stage, showreel, autoQ };
  return stage;
}

/** The menu: the car cruises on and the showreel films it. */
function renderStage(dt: number): void {
  if (!stage) return;
  stage.step(dt);
  showreel.update(stage, dt);
  stage.render(gr, showreel.camera, dt);
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
  queueMicrotask(updateFraming);
}

/**
 * Frame the menu city in the space beside the menu's rail (GameRenderer.setFraming);
 * everything else gets the whole screen, races at once. The garage frames its own view.
 */
function updateFraming(): void {
  if (state === 'garage') return;
  if (state === 'menu' && overlay === menuEl) {
    const inset = railInset(overlay);
    gr.setFraming(inset.left, inset.bottom);
  } else gr.setFraming(0, 0, state === 'race');
}
window.addEventListener('resize', () => queueMicrotask(updateFraming));

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
  updateFraming();
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
  const st = ensureStage();
  // The car on the street shows the build as the garage left it (paint and parts in place, a new car swapped in).
  void st.setBuild(currentBuild());
  // Catch the menu city up with any point light increase auto quality deferred.
  if (st.night.lighting.poolSize !== gr.profile.pointLights) st.night.lighting.setPoolSize(gr.profile.pointLights);
  const seed = seedFromString(seedStr);
  const route = st.world.route;
  setOverlay(
    mainMenu({
      seed: seedStr,
      isDaily,
      event: st.world.event,
      route: { points: route.points, start: routeSample(route, route.startS) },
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
    stage?.night.lighting.setPoolSize(gr.profile.pointLights);
    session?.night.lighting.setPoolSize(gr.profile.pointLights);
  }
  fpsEl.style.display = settings.showFps ? '' : 'none';
  audioHub()?.setVolume(settings.engineVolume);
  if (state === 'race') toggleTuningPanel(settings.debugTuningPanel);
  if (state === 'race') toggleCameraPanel(settings.debugCameraPanel);
}

async function openGarage(): Promise<void> {
  setOverlay(loadingScreen('garage'));
  const { GarageScreen } = await import('./garage/garageUi');
  session?.dispose();
  session = null;
  dev.close();
  camPanel.close();
  // The Street view drives the menu's city: build it first when the garage is the first screen.
  const street = ensureStage();
  setOverlay(null);
  garageScreen?.dispose();
  state = 'garage';
  garageScreen = new GarageScreen(
    gr,
    assets,
    uiRoot,
    garage,
    availability,
    {
      onChange: (g) => {
        garage = g;
        saveGarage(garage);
      },
      onExit: () => showMenu(),
      onTestDrive: () => startRace('circuit', true),
      engineVolume: () => settings.engineVolume,
    },
    { street, quality: settings.quality },
  );
  (window as unknown as Record<string, unknown>).__nr = { garageScreen, gr, stage, autoQ };
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
    // Ambient traffic on the side streets (every street in a test drive). Replays carry the flag.
    traffic: true,
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
    traffic: true,
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

/** The pause screen while a race is paused (it has a settings step Escape comes back from). */
let pauseScreen: PauseScreen | null = null;

const MODE_NAME: Record<RaceMode, string> = { circuit: 'Circuit', sprint: 'Sprint', drift: 'Drift' };

/** What the pause screen says is paused: the event, mode, lap and place (or just the kind of session). */
function pauseStatus(s: RaceSession): string[] {
  if (sessionKind === 'roam') return ['Free roam'];
  if (sessionKind === 'testDrive') return ['Test drive'];
  const r = s.race;
  const out = [r.world.event?.name ?? 'Street race', MODE_NAME[r.config.mode]];
  if (r.config.mode === 'circuit') out.push(`Lap ${Math.min(r.config.laps, Math.max(1, r.cars[0].lap))}/${r.config.laps}`);
  if (r.cars.length > 1) out.push(`P${positionOf(r, 0)} of ${r.cars.length}`);
  if (s.isReplay) out.push('Replay');
  return out;
}

function togglePause(): void {
  if (state !== 'race' || !session) return;
  // Escape in the photo mode drone flies back to the car instead of pausing.
  if (session.droneActive) return session.toggleDrone();
  // Escape on the free roam city map closes the map instead of pausing.
  if (session.mapOpen) return session.closeMap();
  if (session.paused) {
    // Escape in the pause screen's settings comes back to the pause list.
    if (pauseScreen?.el.isConnected && pauseScreen.back()) return;
    session.paused = false;
    pauseScreen = null;
    setOverlay(null);
    syncMusicMode();
    return;
  }
  if (session.race.phase === 'finished') return;
  session.paused = true;
  input.releaseAll();
  pauseScreen = pauseMenu({
    status: pauseStatus(session),
    onResume: togglePause,
    onRestart: () => lastConfig && runSession(lastConfig, lastVisuals, null, lastConfig.opponents.length || lastConfig.openWorld ? null : loadGhost(lastConfig.seed, lastConfig.mode), sessionKind),
    restartLabel: sessionKind === 'race' ? undefined : 'Back to the start',
    extra: sessionKind === 'roam' ? [{ icon: Shuffle, label: 'New city', onClick: () => startFreeRoam(String(Math.floor(Math.random() * 1e8))) }] : undefined,
    settings: { ...settings },
    onSettings: applySettings,
    music,
    onQuit: () => (sessionKind === 'testDrive' ? void openGarage() : showMenu()),
  });
  setOverlay(pauseScreen.el);
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
  } else if (state === 'menu' && stage) {
    state = 'freefly';
    setOverlay(null);
    fly = new FreeFlyCamera(canvas);
    fly.set(showreel.camera.position.clone(), 0, -0.3);
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
/**
 * While the boot splash covers the screen: how many more frames to draw the
 * menu city for (to compile its shaders unseen), or null once the title starts
 * to land. The rest of the time behind the splash only the stage's clock and
 * car move, so the splash's animation and the opening track get the main
 * thread (on slow GPUs a street level frame of the city takes long).
 */
let splashWarmup: number | null = null;

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
    else if (state === 'freefly' && fly && stage) {
      fly.update(dt);
      stage.step(dt, { focus: fly.camera.position });
      stage.render(gr, fly.camera, dt);
    } else if (splashWarmup === null || splashWarmup-- > 0) renderStage(dt);
    else stage?.step(dt);
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
  const loading = splash ? null : loadingScreen();
  if (loading) uiRoot.append(loading);
  // Traffic models load beside the cars so no session draws its traffic late.
  [availability] = await Promise.all([assets.availability(), loadTrafficAssets()]);
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
  if (splash) {
    splashWarmup = 2;
    // The car arrives a moment later: one more frame for its materials.
    void stage?.ready.then(() => splashWarmup !== null && (splashWarmup = Math.max(splashWarmup, 1)));
  }
  loop.start();
  if (splash) {
    // The city's first (slow) frames compile its shaders unseen under the black (splashWarmup).
    splash.hold(overlay);
    await splash.intro;
    splashWarmup = null;
    await splash.land(overlay);
  }
  notice?.();
}

void boot();
