/**
 * Boot, game loop and top level state machine:
 *   menu -> race -> results -> (retry | replay | garage | menu)
 *   menu -> garage -> menu
 *   menu -> free roam (open world on the event seed, or a new city from the pause menu) -> menu
 * Free roam from the menu is a handoff, not a cut: the session takes over the
 * menu city and the car cruising it where it is, the camera swings from the
 * showreel's shot onto the chase camera while the menu slides away.
 */
import './ui/styles/main.scss';
import * as THREE from 'three';
import { FixedStepLoop } from './loop';
import { createCity, createRoute, createWorld, type World } from './city/world';
import { CITY } from './city/config';
import { trafficNet } from './sim/traffic';
import { seedFromString, Rng } from './sim/prng';
import { dailySeed, initialSeed } from './seed';
import { Settings, loadSettings, saveSettings } from './ui/settings';
import { AutoQualityController, MAX_LEVEL, QUALITY_LEVELS, autoLabel, deviceKey, guessLevel, loadRememberedLevel, readDeviceInfo, saveRememberedLevel } from './render/autoQuality';
import { GameRenderer } from './render/scene';
import { FreeFlyCamera } from './render/camera/freeFly';
import { CarAssetLibrary, manifestCar } from './render/car/carAssets';
import { InputManager } from './input/inputManager';
import { PadNav } from './input/padNav';
import { RaceSession, type SessionOptions } from './game/session';
import { DroneMode } from './game/drone';
import { TICK_HZ } from './sim/constants';
import { StreetStage } from './game/streetStage';
import { ShowreelCamera } from './game/streetCameras';
import { MusicPlayer } from './audio/musicPlayer';
import { audioHub } from './audio/engineAudio';
import { MusicWidget } from './ui/panels/musicWidget';
import { TuningPanel, applySavedTuning, loadSavedTuning } from './ui/panels/tuningPanel';
import { CameraPanel, applySavedCameraParams } from './ui/panels/cameraPanel';
import { loadingScreen } from './ui/screens/loading';
import { pauseMenu, type PauseScreen, type PauseTicket } from './ui/screens/pause';
import { resultsScreen } from './ui/screens/results';
import { placeName } from './ui/map/places';
import { railInset } from './ui/rail/rail';
import { mainMenu, type MainMenu, type MenuStep } from './ui/menu/menu';
import { showSplash } from './ui/splash/splash';
import { toast } from './ui/kit/dom';
import { Check, Info, Share2, Shuffle, Trophy } from './ui/kit/icons';
import { formatTime } from './ui/kit/format';
import { showFatal } from './ui/screens/fatal';
import { courseFor, openFullMap, type FullMap, type WaypointStore } from './ui/map/fullMap';
import type { Vec2 } from './sim/math';
import { door, shift, transitioning, wipe, type NitroSource, type WipeCard } from './ui/transitions/transitions';
import { courseArt, courseRoute, type CourseRoutes } from './ui/menu/menuMaps';
import type { RaceType } from './ui/settings';
import { installUiSounds } from './audio/uiSound';
import { DRAG_OPPONENTS, POINT_TO_POINT, RaceConfig, RaceEntrant, RaceMode, positionOf, standings, ticksToSeconds } from './sim/race';
import { loadTrafficAssets } from './render/traffic/traffic';
import { stockPerformance } from './sim/build';
import { CarBuild, VisualBuild, defaultVisual, PAINT_FINISHES } from './shared/carBuild';
import { DEFAULT_CAR_ID, SELECTABLE_CAR_IDS, getBaseTuning } from './sim/tuning';
import { specBadges } from './shared/carSpec';
import { damp } from './shared/anim';
import { GarageState, decodeShareCode, loadGarage, saveGarage } from './garage/storage';
import { ReplayData, decodeLog, encodeLog, loadBest, loadGhost, loadLastReplay, loadStyleBest, saveGhost, saveLastReplay, submitBest, submitStyleBest } from './replay/replay';
import { styleTotal } from './ui/hud/boostCallouts';
import { accountReady } from './account/account';
import { beginDrive, driveFrame, endDrive, setQualityReader } from './analytics/drive';
import { initAnalytics, track } from './analytics/telemetry';
import { installErrorReporting, reportError } from './analytics/errors';
import { loadText, saveText } from './shared/store';
import { FEATURES } from './shared/features';

type State = 'menu' | 'race' | 'garage' | 'freefly' | 'drone';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;
// From the first line, so a crash anywhere in boot is reported (once analytics is up) rather than a silent black page.
installErrorReporting(() => state);
// A signed-in player's newest save (from another device) lands in local storage before anything reads it.
await accountReady;
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
const gr = await startRenderer();
// The GPU can take the context back (low memory, a phone's long background stint). three.js would carry on drawing
// nothing over lost textures and targets, so say so and offer the reload instead of a frozen frame.
canvas.addEventListener('webglcontextlost', () => {
  reportError('context_lost', 'WebGL context lost');
  showFatal('context');
  loop.stop();
});

/**
 * The renderer, or the can't-draw card when this browser has no WebGL (three.js throws creating the context). The
 * boot stops there for good: the returned promise never settles, so nothing after it runs without a renderer.
 */
async function startRenderer(): Promise<GameRenderer> {
  try {
    return new GameRenderer(canvas, settings);
  } catch (err) {
    initAnalytics(null);
    reportError('webgl', err);
    showFatal('webgl');
    return new Promise(() => {});
  }
}

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
setQualityReader(() => ({ level: autoQ.level, auto: settings.autoQuality, aim: autoQ.aim }));
function applyAutoQuality(): void {
  if (!settings.autoQuality) return;
  const lv = QUALITY_LEVELS[autoQ.level];
  settings.quality = lv.tier;
  gr.setAutoProfile(lv);
  // Fewer point lights right away (frames are slow); more wait for the next scene
  // because a light count change recompiles every lit shader mid race.
  for (const n of [stage?.night, session?.night]) if (n && n.lighting.poolSize > lv.pointLights) n.lighting.setPoolSize(lv.pointLights);
}
/** Debug mode (the tuning panels): a saved setting, honoured only where the dev tools exist (npm run dev). */
function debugOn(): boolean {
  return FEATURES.devTools && settings.debugMode;
}
function persistSettings(): void {
  saveSettings(urlQualityOverride ? { ...settings, ...storedQuality } : settings);
}
const assets = new CarAssetLibrary();
const input = new InputManager(uiRoot);
// The gamepad on every screen that is not driving: menus, pause, results, garage.
const padNav = new PadNav();
const dev = new TuningPanel(uiRoot);
// Camera tuning (F3): saved tweaks apply to every race camera from boot.
const camPanel = new CameraPanel(uiRoot);
applySavedCameraParams();
/** What the running session is: a race (or replay) or free roam. */
type SessionKind = 'race' | 'roam';
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
let garageScreen: { render(dt: number): void; dispose(): void } | null = null;

// ---------------------------------------------------------------------------
// The menu city: the event city with the player's car cruising its route
// (game/streetStage.ts). The showreel shoots it behind the menu, the drone and
// the free camera fly over it, and the garage's Street view drives it.
// ---------------------------------------------------------------------------
let stage: StreetStage | null = null;
/** The nitrous warping the menu city as it arrives (renderStage): the boot splash's landing or the shift to a new city, null once burned out. */
let arrival: NitroSource | null = null;
/** The event's courses, built from the stage's city (the stage drives the circuit); the menu's race step draws them all. */
let stageCourses: CourseRoutes | null = null;
/** The open world over the stage's city, with its traffic net built: what free roam taken over from the menu drives in, ready before it is asked for. */
let stageOpen: World | null = null;
const showreel = new ShowreelCamera();
let fly: FreeFlyCamera | null = null;
let drone: DroneMode | null = null;

/** The drone flyover, from `start` (the menu's camera, so it lifts off from the shot) or behind the grid. */
function startDrone(start?: { x: number; y: number; z: number; yaw: number; pitch: number }): void {
  const st = ensureStage();
  closeMenuMap();
  setOverlay(null);
  drone?.dispose();
  drone = new DroneMode(gr, st.night, st.world, uiRoot, exitDrone, { drive: (dt, focus) => st.step(dt, { focus }), start });
  state = 'drone';
  syncMusicMode();
}

/** How long the menu's camera cranes up before the drone takes over (s). */
const LIFTOFF = 0.95;
let liftoff = 0;

/** Explore from the menu: the menu slides away as the camera cranes up off the street, then the drone flies on from there. */
function exploreFromMenu(): void {
  if (state !== 'menu' || liftoff || transitioning()) return;
  closeMenuMap();
  showreel.setMode('lift');
  menuEl?.classList.add('is-exiting');
  // Nothing on the sliding menu takes a key press on the way out.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  liftoff = window.setTimeout(() => {
    liftoff = 0;
    if (state === 'menu') startDrone(showreel.pose());
  }, LIFTOFF * 1000);
}

function exitDrone(): void {
  drone?.dispose();
  drone = null;
  showMenu();
}

/** The street stage for the current seed, built (with the current build on it) when the seed changes. */
function ensureStage(): StreetStage {
  const seed = seedFromString(seedStr);
  if (stage && stage.world.seed === seed) {
    // Back from a race: the console handle points at the menu city again.
    (window as unknown as Record<string, unknown>).__nr = { world: stage.world, gr, stage, showreel, autoQ };
    return stage;
  }
  stage?.dispose();
  // The same world createWorld builds on its own, with the city kept for the other courses' routes.
  const city = createCity(seed);
  stage = new StreetStage(gr, assets, createWorld(seed, 'circuit', city), settings);
  stageCourses = { circuit: stage.world.route, sprint: createRoute(city, 'sprint'), drag: createRoute(city, 'drag'), waypoint: createRoute(city, 'waypoint') };
  // A few ms over the city that is already built, and its traffic net now (cached per world) rather than at the handoff.
  stageOpen = createWorld(seed, 'circuit', city, { openWorld: true });
  trafficNet(stageOpen);
  void stage.setBuild(currentBuild(), { key: garage.current });
  showreel.open();
  (window as unknown as Record<string, unknown>).__nr = { world: stage.world, gr, stage, showreel, autoQ };
  return stage;
}

/** The landing's nitrous has burned out (or the menu was left before it did): clear the warp. */
function endArrival(): void {
  arrival = null;
  gr.post.setNitroFx(0, 0);
}

/** The menu: the car cruises on, the showreel films it and the menu's maps follow it. */
function renderStage(dt: number): void {
  if (!stage) return;
  stage.step(dt);
  showreel.update(stage, dt);
  // Landing from the splash, the city starts in the nitrous warp (with its speed blur, as in a race) and eases out of it.
  const nitro = arrival?.nitro(performance.now()) ?? null;
  if (arrival && !nitro) endArrival();
  if (nitro && settings.radialBlur) gr.post.setNitroFx(nitro.warp, performance.now() / 1000, nitro.stage);
  stage.render(gr, showreel.camera, dt, Math.max(showreel.blur, nitro?.blur ?? 0));
  if (menu && overlay === menuEl && !cinematic) menu.frame(stage.pose);
}

/**
 * The free roam waypoint for one city: set on the map from the menu or in
 * free roam, kept until it is reached, cleared or the city changes, so a pin
 * dropped on the menu is waiting when free roam starts. Render only.
 */
const waypoint: { seed: number; pos: Vec2 | null } = { seed: -1, pos: null };
function waypointFor(seed: number): WaypointStore {
  if (waypoint.seed !== seed) {
    waypoint.seed = seed;
    waypoint.pos = null;
  }
  return {
    get: () => (waypoint.seed === seed ? waypoint.pos : null),
    set: (p) => {
      waypoint.seed = seed;
      waypoint.pos = p ? { x: p.x, z: p.z } : null;
    },
  };
}

/**
 * The full city map over the menu (the same map free roam opens, through
 * openFullMap), following the cruising car, on a race type's course when the
 * race step opened it. It closes itself on Escape, Tab or its backdrop.
 */
let menuMap: FullMap | null = null;

function openMenuMap(type?: RaceType): void {
  const st = stage;
  if (!st || menuMap || state !== 'menu' || transitioning()) return;
  const car = () => ({ x: st.pose.x, z: st.pose.z, yaw: st.pose.yaw, isPlayer: true });
  menuMap = openFullMap(uiRoot, st.world, car(), {
    onClose: closeMenuMap,
    livePlayer: car,
    event: st.world.event?.name,
    seed: seedStr,
    waypoint: waypointFor(st.world.seed),
    // The menu city's own route is the circuit; the other courses are planned on it for the race step.
    course: type ? courseFor(type, stageCourses ? courseRoute(stageCourses, type) : st.world.route) : undefined,
  });
}

function closeMenuMap(): void {
  menuMap?.dispose();
  menuMap = null;
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

/** The main menu, and its own overlay (settings, credits and dialogs replace it). */
let menu: MainMenu | null = null;
let menuEl: HTMLElement | null = null;
/** Something other than the main menu is open on top of the menu city. */
const overlayBusy = () => overlay !== menuEl;

function setOverlay(el: HTMLElement | null): void {
  // Leaving the menu: its maps stop watching their boxes and its keys stop listening (showMenu builds a new one).
  if (menu && overlay === menuEl && el !== menuEl) {
    menu.dispose();
    menu = null;
    menuEl = null;
  }
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
cineHint.className = 'cinematic-hint';
cineHint.textContent = 'Press any key or click to show the menu';

function setCinematic(on: boolean): void {
  if (cinematic === on) return;
  cinematic = on;
  document.body.classList.toggle('is-cinematic', on);
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
  if (e.code === 'KeyH' && !e.repeat && !typing && state === 'menu' && !overlayBusy() && !menuMap && !liftoff && !e.ctrlKey && !e.metaKey && !e.altKey) setCinematic(true);
});

/** The camera behind each menu step: the shot loop behind home, the hero shot for the race, lining up for the setup, a calm orbit for settings. */
const STEP_CAMERA = { home: 'reel', race: 'hero', setup: 'grid', settings: 'calm' } as const;

/** Open the menu (on `step`), from wherever the game was: the camera cuts straight to that step's shot. */
function showMenu(step: MenuStep = 'home'): void {
  setCinematic(false);
  state = 'menu';
  clearTimeout(liftoff);
  liftoff = 0;
  endDrive('quit');
  session?.dispose();
  session = null;
  garageScreen?.dispose();
  garageScreen = null;
  dev.close();
  camPanel.close();
  closeMenuMap();
  const st = ensureStage();
  // The car on the street shows the build as the garage left it (paint and parts in place, a new car swapped in).
  void st.setBuild(currentBuild(), { key: garage.current });
  // Catch the menu city up with any point light increase auto quality deferred.
  if (st.night.lighting.poolSize !== gr.profile.pointLights) st.night.lighting.setPoolSize(gr.profile.pointLights);
  showreel.setMode(STEP_CAMERA[step], false);
  const seed = seedFromString(seedStr);
  // The old menu goes first, so setOverlay below sees nothing of the menu left to dispose.
  menu?.dispose();
  menu = null;
  menuEl = null;
  const next = mainMenu({
    seed: seedStr,
    isDaily,
    event: st.world.event,
    world: st.world,
    routes: stageCourses ?? { circuit: st.world.route, sprint: st.world.route, drag: st.world.route, waypoint: st.world.route },
    bests: { circuit: loadBest(seed, 'circuit'), sprint: loadBest(seed, 'sprint'), drag: loadBest(seed, 'drag'), waypoint: loadBest(seed, 'waypoint'), drift: loadBest(seed, 'drift') },
    builds: garage.slots.map((b) => {
      const car = manifestCar(b.carId);
      return { name: b.name, car: car.displayName, tags: specBadges(car.engine, getBaseTuning(b.carId).drivetrain.layout) };
    }),
    build: garage.current,
    onBuild: (i) => {
      garage.current = i;
      saveGarage(garage);
      // The slot's car joins the convoy behind the line, or the camera glides to it if it is already there (StreetStage.setBuild's hop).
      void st.setBuild(currentBuild(), { key: i, hop: true });
    },
    hasReplay: FEATURES.replays && !!loadLastReplay(),
    settings: { ...settings },
    music,
    step,
    onSettings: applySettings,
    onRace: launch,
    onGarage: () => void openGarage(),
    onReplay: FEATURES.replays
      ? () => {
          const r = loadLastReplay();
          if (r) void wipe({ kicker: MODE_NAME[r.config.mode], title: 'Replay', sub: 'Your last race' }, () => startReplay(r));
        }
      : undefined,
    onDrone: exploreFromMenu,
    onMap: openMenuMap,
    waypoint: () => waypointFor(st.world.seed).get(),
    onSeed: (s) => {
      const next = s ?? dailySeed();
      const use = () => {
        isDaily = s === null;
        seedStr = next;
        const u = new URL(location.href);
        if (isDaily) u.searchParams.delete('seed');
        else u.searchParams.set('seed', seedStr);
        history.replaceState(null, '', u);
        showMenu();
      };
      // The same city again needs no build, so no shift: the menu just shows the seed as typed.
      if (seedFromString(next) === st.world.seed) return use();
      // The city floors it into the dark, the new one builds behind the seed's card and arrives in the warp, its menu rising in.
      const card = { kicker: s === null ? "Today's event" : 'New city', title: `#${next}`, sub: 'Building the streets' };
      musicDip.on = true;
      void shift(card, use, (src) => (arrival = src), () => {
        // The music comes back up with the new city.
        musicDip.on = false;
        const el = menuEl?.querySelector('.menu');
        el?.classList.add('is-reseeded');
        setTimeout(() => el?.classList.remove('is-reseeded'), 1200);
      }).finally(() => (musicDip.on = false));
    },
    onHideUi: () => setCinematic(true),
    onStep: (s) => showreel.setMode(STEP_CAMERA[s]),
  });
  setOverlay(next.root);
  menu = next;
  menuEl = overlay;
}

/** What the wipe into a race says: the event over the type, and its laps and field. */
function raceCard(t: RaceType): WipeCard {
  const event = stage?.world.event?.name;
  const field = settings.opponents ? `${settings.opponents} rival${settings.opponents > 1 ? 's' : ''}` : 'Your ghost';
  // The course draws itself on the card while the race builds behind it (free roam has the whole city instead).
  const art = stageCourses && t !== 'roam' ? courseArt(courseRoute(stageCourses, t), t) : undefined;
  const hold = art ? 700 : 0;
  const card: Record<RaceType, WipeCard> = {
    circuit: { kicker: event, title: 'Circuit', art, hold, sub: `3 laps · ${field}` },
    sprint: { kicker: event, title: 'Sprint', art, hold, sub: `A to B · ${field}` },
    drag: { kicker: event, title: 'Drag', art, hold, sub: `${Math.round(((stageCourses?.drag.finishS ?? 0) - (stageCourses?.drag.startS ?? 0)) / CITY.spacing)} blocks straight · head to head` },
    waypoint: { kicker: event, title: 'Waypoint', art, hold, sub: `${(stageCourses?.waypoint.waypoints?.length ?? 1) - 1} waypoints · any streets · ${field}` },
    drift: { kicker: event, title: 'Drift', art, hold, sub: '2 laps · score attack' },
    roam: { kicker: event, title: 'Free roam', sub: 'The whole city · no rules' },
  };
  return card[t];
}

/** Start the race type picked on the menu: the camera drops in behind the car as the wipe covers the screen. */
function launch(t: RaceType): void {
  if (state !== 'menu' || transitioning()) return;
  // Free roam carries on from the car on screen; before its model has loaded there is nothing to carry on from.
  if (t === 'roam' && stage?.car) return handoffToFreeRoam();
  showreel.setMode('launch');
  void wipe(raceCard(t), () => (t === 'roam' ? startFreeRoam(seedStr) : startRace(t)));
}

/** The handoff into free roam: how long the camera swings onto the chase view and the menu takes to leave (s; `.rail.is-exiting` in ui/menu/_menu.scss). */
const HANDOFF = { pan: 2, menuOut: 0.5 } as const;

/**
 * Free roam from the menu, with no wipe: the session takes over the menu
 * city's scene and its car where it is and at the speed it is going (the sim
 * starts on the stage's tick, so the gates and the El stay where they were),
 * the camera swings from the showreel's shot round onto the chase camera, and
 * the menu slides away meanwhile; the HUD fades in once the swing settles.
 */
function handoffToFreeRoam(): void {
  const st = stage!;
  closeMenuMap();
  const build = currentBuild();
  const p = st.pose;
  const config: RaceConfig = {
    seed: seedFromString(seedStr),
    mode: 'circuit',
    laps: 1,
    player: { name: 'You', carId: build.carId, performance: build.performance },
    opponents: [],
    difficulty: settings.difficulty,
    manualGearbox: settings.manualGearbox,
    tractionControl: settings.tractionControl,
    openWorld: true,
    traffic: true,
    start: { x: p.x, z: p.z, y: p.y, yaw: p.yaw, speed: st.speed, tick: Math.round(st.time * TICK_HZ) },
  };
  const shot = { position: showreel.camera.position.clone(), look: showreel.lookTarget.clone(), fov: showreel.camera.fov };
  const el = menuEl;
  el?.classList.add('is-exiting');
  // Nothing on the sliding menu takes a key press on the way out.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  // The open world built with the stage (from scratch, the city alone would be hundreds of ms here).
  const world = stageOpen?.seed === config.seed ? stageOpen : createWorld(config.seed, 'circuit', st.world, { openWorld: true });
  runSession(config, [build.visual], null, null, 'roam', { handoff: { stage: st, shot, pan: HANDOFF.pan }, world });
  // The view recenters on the whole screen as the rail slides away (a race start would snap it).
  gr.setFraming(0, 0);
  window.setTimeout(() => {
    if (overlay === el) setOverlay(null);
  }, HANDOFF.menuOut * 1000);
}

/** Back to the menu from a race or the pause screen, behind the wipe. */
function wipeToMenu(): void {
  void wipe({ title: 'Street Scene', sub: 'midnight street racing club' }, () => showMenu());
}

/** Take a changed copy of the settings: save them and apply what changed to the renderer, audio and panels. */
function applySettings(s: Settings): void {
  const qualityChanged = s.quality !== settings.quality || s.autoQuality !== settings.autoQuality;
  const autoTurnedOn = s.autoQuality && !settings.autoQuality;
  const debugChanged = s.debugMode !== settings.debugMode;
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
  document.body.classList.toggle('is-fps', settings.showFps);
  audioHub()?.applyLevels(settings);
  // Debug mode shows both tuning panels in the running session, or takes them away.
  if (debugChanged) {
    toggleTuningPanel(debugOn());
    toggleCameraPanel(debugOn());
  }
}

/**
 * The garage, behind its roller door: from the menu the camera pushes in on the car as the door comes
 * down, and it rolls up on the workshop. A deep link opens it behind the loading card instead.
 */
function openGarage(viaDoor = true): Promise<void> {
  if (!viaDoor) return enterGarage(false);
  if (state === 'menu') {
    closeMenuMap();
    showreel.setMode('push');
  }
  return door('Garage', enterGarage);
}

async function enterGarage(viaDoor = true): Promise<void> {
  const { GarageScreen } = await import('./garage/garageUi');
  endDrive('quit');
  session?.dispose();
  session = null;
  dev.close();
  camPanel.close();
  // The Street view drives the menu's city: build it first when the garage is the first screen.
  const street = ensureStage();
  setOverlay(null);
  garageScreen?.dispose();
  state = 'garage';
  track('garage_open', { viaDoor });
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
      onExit: () => void door('Race', () => showMenu()),
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

/** A fresh seed for the rivals' personalities (RaceConfig.aiSeed): every race start, retry and restart drives differently. */
const rivalSeed = (): number => Math.floor(Math.random() * 0x7fffffff);

/** The rivals: their names, cars and looks rolled from the seed. They drive stock setups, the tuning the AI is balanced on. */
function opponentEntrants(seed: number, count: number): { entrants: RaceEntrant[]; visuals: VisualBuild[] } {
  const rng = new Rng(seed ^ 0x51ce);
  const cars = SELECTABLE_CAR_IDS.filter((id) => availability[id]);
  if (!cars.length) cars.push(DEFAULT_CAR_ID);
  const names = rng.shuffle(AI_NAMES.slice());
  const entrants: RaceEntrant[] = [];
  const visuals: VisualBuild[] = [];
  for (let i = 0; i < count; i++) {
    const carId = cars[rng.int(0, cars.length - 1)];
    entrants.push({ name: names[i], carId, performance: stockPerformance() });
    const v = defaultVisual();
    v.paint.color = '#' + new THREE.Color().setHSL(rng.next(), 0.8, 0.5).getHexString();
    v.paint.finish = rng.pick(PAINT_FINISHES);
    v.underglow = { ...v.underglow, enabled: rng.chance(0.6), color: '#' + new THREE.Color().setHSL(rng.next(), 1, 0.55).getHexString(), pattern: rng.pick(['steady', 'pulse', 'breathe'] as const) };
    v.stance.front.rideHeight = v.stance.rear.rideHeight = -rng.range(0, 0.05);
    visuals.push(v);
  }
  return { entrants, visuals };
}

function startRace(mode: RaceMode): void {
  garageScreen?.dispose();
  garageScreen = null;
  const seed = seedFromString(seedStr);
  const build = currentBuild();
  // A drag is always head to head.
  const count = mode === 'drift' ? 0 : mode === 'drag' ? DRAG_OPPONENTS : settings.opponents;
  const opp = opponentEntrants(seed, count);
  const config: RaceConfig = {
    seed,
    mode,
    laps: mode === 'circuit' ? 3 : mode === 'drift' ? 2 : 1,
    player: { name: 'You', carId: build.carId, performance: build.performance },
    opponents: opp.entrants,
    difficulty: settings.difficulty,
    manualGearbox: settings.manualGearbox,
    tractionControl: settings.tractionControl,
    // Ambient traffic on the side streets. Replays carry the flag.
    traffic: true,
    aiSeed: rivalSeed(),
  };
  const ghostData = count === 0 ? loadGhost(seed, mode) : null;
  runSession(config, [build.visual, ...opp.visuals], null, ghostData, 'race');
}

/**
 * Free roam: the whole city of a seed as an open world (no route, barriers,
 * rails, parked cars, crowds or rivals), with the player's build and, in debug
 * mode, the car's saved physics tuning from the tuning panel. It never
 * finishes; the pause menu goes back to the start, to a new random city, or to
 * the menu.
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

function runSession(config: RaceConfig, visuals: VisualBuild[], replay: ReplayData | null, ghost: ReplayData | null, kind: SessionKind, extra: Pick<SessionOptions, 'handoff' | 'world'> = {}): void {
  session?.dispose();
  dev.close();
  // A handoff keeps the menu on screen while it slides away (handoffToFreeRoam takes it down).
  if (!extra.handoff) setOverlay(null);
  lastConfig = config;
  lastVisuals = visuals;
  session = new RaceSession(gr, assets, input, settings, uiRoot, {
    config,
    visuals,
    replay: replay ? { ...replay, decoded: decodeLog(replay.log) } : undefined,
    ghost: ghost ? { config: ghost.config, log: decodeLog(ghost.log), visual: ghost.visuals[0] } : null,
    // Start / finish camera shots; free roam goes straight to driving.
    cinematics: kind === 'race',
    // Free roam steers to the city's waypoint, which the menu's map may already have set.
    waypoint: kind === 'roam' ? waypointFor(config.seed) : undefined,
    seedText: config.seed === seedFromString(seedStr) ? seedStr : undefined,
    firstRunHelp: kind === 'race' && !replay && firstRace(),
    ...extra,
    onQuit: wipeToMenu,
    onPause: togglePause,
  });
  state = 'race';
  sessionKind = kind;
  syncMusicMode();
  loop.resetAccumulator();
  if (kind === 'roam' && debugOn()) {
    // Free roam in debug mode is the tuning ground: apply this car's saved physics tuning.
    const player = session.race.cars[0];
    if (applySavedTuning(player.tuning, loadSavedTuning(player.carId)) > 0) session.tuned = true;
  }
  // Debug mode opens both tuning panels (` / F2 and F3 hide and show them).
  if (debugOn()) {
    toggleTuningPanel(true);
    toggleCameraPanel(true);
  }
  const s = session;
  (window as unknown as Record<string, unknown>).__nr = { session: s, gr, autoQ };
  beginDrive(
    {
      mode: kind === 'roam' ? 'roam' : config.mode,
      seed: config.seed,
      ...(config.seed === seedFromString(seedStr) ? { seedText: seedStr.slice(0, 40) } : {}),
      carId: config.player.carId,
      opponents: config.opponents.length,
      difficulty: config.difficulty,
      replay: !!replay,
      ghost: !!ghost,
    },
    () => (kind === 'roam' ? undefined : Math.max(0, Math.min(1, s.race.cars[0].dist / s.race.distance))),
  );
  s.onFinish = ({ race, tuned, style }) => {
    if (s !== session) return;
    if (kind === 'roam') return wipeToMenu();
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
    const styleBest = loadStyleBest(race.config.seed, race.config.mode);
    let newStyleBest = false;
    if (!replay) {
      if (FEATURES.replays) saveLastReplay(data);
      if (!tuned) {
        newStyleBest = submitStyleBest(race.config.seed, race.config.mode, styleTotal(style));
        newBest = submitBest(race.config.seed, race.config.mode, { time: me.time, score: race.drift.total, carId: race.config.player.carId, date: data.date });
        if (newBest && race.config.opponents.length === 0) saveGhost(race.config.seed, race.config.mode, data);
      }
    }
    if (!replay) {
      track('race_finish', {
        mode: race.config.mode,
        seed: race.config.seed,
        carId: race.config.player.carId,
        timeMs: Math.round(me.time * 1000),
        place: me.position,
        entrants: race.cars.length,
        personalBest: newBest,
        ...(race.config.mode === 'drift' ? { score: Math.round(race.drift.total) } : {}),
      });
    }
    endDrive('finished');
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
        style,
        styleBest,
        newStyleBest,
        tuned,
        challenge: replay ? null : challengeResult(race.config.seed, race.config.mode, me.time, race.drift.total),
        // A live, untuned run on the event's city can be sent on: the link opens the same race on the same streets.
        onChallenge: FEATURES.challenges && !replay && !tuned && race.config.seed === seedFromString(seedStr) ? () => void challenge(race.config.mode, me.time, race.drift.total) : undefined,
        onRetry: () =>
          void wipe({ kicker: race.world.event?.name, title: 'Retry', sub: MODE_NAME[race.config.mode] }, () =>
            replay ? startReplay(replay) : runSession({ ...race.config, aiSeed: rivalSeed() }, visuals, null, race.config.opponents.length ? null : loadGhost(race.config.seed, race.config.mode), 'race'),
          ),
        onReplay: FEATURES.replays ? () => void wipe({ kicker: race.world.event?.name, title: 'Replay', sub: MODE_NAME[race.config.mode] }, () => startReplay(replay ?? data)) : undefined,
        onGarage: () => void openGarage(),
        onMenu: wipeToMenu,
      }),
    );
  };
}

/** The pause screen while a race is paused (it has a settings step Escape comes back from). */
let pauseScreen: PauseScreen | null = null;

const MODE_NAME: Record<RaceMode, string> = { circuit: 'Circuit', sprint: 'Sprint', drag: 'Drag', waypoint: 'Waypoint', drift: 'Drift' };
/** Every race mode, for ?race=<mode> deep links. */
const RACE_MODES = Object.keys(MODE_NAME) as RaceMode[];

/** A race result as a challenge to beat: a time, or a drift's points. */
function resultText(mode: RaceMode, beat: number): string {
  return mode === 'drift' ? `${Math.round(beat).toLocaleString()} pts` : formatTime(beat);
}

/**
 * Send this result as a link that drops a friend into the same race on the same city (`?seed=&race=`), with the
 * mark to beat (`beat`, s or drift points) and `utm_source=challenge` so the arrivals show on the dashboard. The
 * share sheet on touch screens, the clipboard elsewhere.
 */
async function challenge(mode: RaceMode, time: number, score: number): Promise<void> {
  const beat = mode === 'drift' ? Math.round(score) : Math.round(time * 1000) / 1000;
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('seed', seedStr);
  u.searchParams.set('race', mode);
  u.searchParams.set('beat', String(beat));
  u.searchParams.set('utm_source', 'challenge');
  const text = `Beat my ${resultText(mode, beat)} ${MODE_NAME[mode].toLowerCase()} in Street Scene`;
  const seed = seedFromString(seedStr);
  if (typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: 'Street Scene', text, url: u.toString() });
      track('race_share', { mode, seed, via: 'share' });
    } catch {
      /* the sheet was dismissed */
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(`${text}: ${u}`);
    track('race_share', { mode, seed, via: 'copy' });
    toast('Challenge link copied', Share2);
  } catch {
    toast('The clipboard is blocked here', Info);
  }
}

/** The mark a challenge link set (s, or drift points) on its race: every finish of that race is held against it this visit. */
let challengeMark: { seed: number; mode: RaceMode; mark: number } | null = null;

/** How a finish stands against the challenge's mark, for the results card; null off the challenged race. */
function challengeResult(seed: number, mode: RaceMode, time: number, score: number): { beaten: boolean; text: string } | null {
  if (!challengeMark || challengeMark.seed !== seed || challengeMark.mode !== mode) return null;
  const { mark } = challengeMark;
  if (mode === 'drift') {
    const gap = Math.round(Math.abs(score - mark)).toLocaleString();
    return score > mark ? { beaten: true, text: `Challenge beaten by ${gap} pts` } : { beaten: false, text: `${gap} pts short of the challenge’s ${resultText(mode, mark)}` };
  }
  const gap = `${Math.abs(time - mark).toFixed(2)} s`;
  return time < mark ? { beaten: true, text: `Challenge beaten by ${gap}` } : { beaten: false, text: `${gap} short of the challenge’s ${resultText(mode, mark)}` };
}

/** True until the first race on this device: that one opens the keys panel as the countdown starts. */
function firstRace(): boolean {
  // Touch screens skip it (their controls are on screen), and so do the e2e runs, whose every profile is new.
  if (loadText('seenControls') || matchMedia('(hover: none)').matches || navigator.webdriver) return false;
  saveText('seenControls', '1');
  return true;
}

/**
 * What the pause screen's ticket says is paused: the event, the type in its
 * color, lap, place or score, and the course with every car where it stands
 * (free roam: where in the city you are).
 */
function pauseTicket(s: RaceSession): PauseTicket {
  const r = s.race;
  const event = r.world.event?.name;
  const me = r.cars[0].state;
  if (sessionKind === 'roam') return { event, title: 'Free roam', mode: 'roam', facts: ['The whole city', `In ${placeName(r.world.areaAt(me.x, me.z))}`] };
  const mode = r.config.mode;
  const facts: string[] = [];
  if (!POINT_TO_POINT.has(mode)) facts.push(`Lap ${Math.min(r.config.laps, Math.max(1, r.cars[0].lap))}/${r.config.laps}`);
  const targets = r.world.route.waypoints;
  if (mode === 'waypoint' && targets) facts.push(`Waypoint ${Math.min(targets.length - 1, r.cars[0].nextCheckpoint + 1)}/${targets.length - 1}`);
  if (r.cars.length > 1) facts.push(`P${positionOf(r, 0)} of ${r.cars.length}`);
  if (mode === 'drift') facts.push(`${Math.round(r.drift.total).toLocaleString()} pts`);
  if (s.isReplay) facts.push('Replay');
  return { event, title: MODE_NAME[mode], mode, facts, route: r.world.route, cars: r.cars.map((c) => ({ x: c.state.x, z: c.state.z, me: c.isPlayer })) };
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
    ticket: pauseTicket(session),
    onResume: togglePause,
    onRestart: () => {
      const cfg = lastConfig;
      if (!cfg) return;
      const title = sessionKind === 'race' ? 'Restart' : 'Free roam';
      void wipe({ kicker: session?.race.world.event?.name, title, sub: sessionKind === 'race' ? MODE_NAME[cfg.mode] : 'Back to the start' }, () =>
        runSession(cfg.opponents.length ? { ...cfg, aiSeed: rivalSeed() } : cfg, lastVisuals, null, cfg.opponents.length || cfg.openWorld ? null : loadGhost(cfg.seed, cfg.mode), sessionKind),
      );
    },
    restartLabel: sessionKind === 'race' ? undefined : 'Back to the start',
    restartSub: sessionKind === 'race' ? undefined : 'Where free roam began',
    quitSub: sessionKind === 'roam' ? 'Leave free roam' : undefined,
    extra:
      sessionKind === 'roam'
        ? [{ icon: Shuffle, label: 'New city', sub: 'Free roam in a city never seen', hue: 'green', onClick: () => void wipe({ title: 'New city', sub: 'Free roam · a city never seen' }, () => startFreeRoam(String(Math.floor(Math.random() * 1e8)))) }]
        : undefined,
    settings: { ...settings },
    onSettings: applySettings,
    music,
    onQuit: wipeToMenu,
  });
  setOverlay(pauseScreen.el);
}

input.on('pause', togglePause);
/**
 * Leaving the window or losing the pad mid race pauses it: the input manager
 * releases every key on blur, so the car would coast while the rivals drive
 * on. Replays, photo mode and the open map are left as they are.
 */
function autoPause(): void {
  if (state !== 'race' || !session || session.paused || session.isReplay || session.droneActive || session.mapOpen) return;
  if (session.race.phase === 'finished') return;
  togglePause();
}
window.addEventListener('blur', autoPause);
document.addEventListener('visibilitychange', () => document.hidden && autoPause());
window.addEventListener('gamepaddisconnected', autoPause);
// 0: the drone flyover from the menu (and back); in a race the session flies its own photo mode drone.
input.onView((n) => {
  if (n !== 0) return;
  if (state === 'menu' && !overlayBusy() && !menuMap) exploreFromMenu();
  else if (state === 'drone') exitDrone();
});
/** Show or hide the physics tuning panel for the current race or free roam (no argument = toggle). */
function toggleTuningPanel(show = !dev.open): void {
  if (state !== 'race' || !session || session.isReplay) return;
  if (!show) return dev.close();
  if (dev.open) return;
  const s = session;
  dev.show(s.race.cars[0].tuning, s.race.config.player.performance, () => (s.tuned = true));
}
// The panel keys only work in debug mode.
input.on('dev', () => debugOn() && toggleTuningPanel());
/** Show or hide the camera tuning panel during a race, replays included (no argument = toggle). */
function toggleCameraPanel(show = !camPanel.open): void {
  if (state !== 'race' || !session) return;
  if (!show) return camPanel.close();
  if (!camPanel.open) camPanel.show();
}
input.on('cameraPanel', () => debugOn() && toggleCameraPanel());
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
document.body.classList.toggle('is-fps', settings.showFps || params.has('fps'));
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

/** The music dips a little while the menu shifts to a new city (MusicPlayer.setDip): the gain, how fast it eases (1/s), and where it is now. */
const MUSIC_DIP = { gain: 0.6, rate: 5 } as const;
const musicDip = { on: false, gain: 1 };

const loop = new FixedStepLoop({
  tick() {
    if (state === 'race') session?.tick();
  },
  render(alpha, dt) {
    musicDip.gain += ((musicDip.on ? MUSIC_DIP.gain : 1) - musicDip.gain) * damp(MUSIC_DIP.rate, dt);
    if (!musicDip.on && musicDip.gain > 0.999) musicDip.gain = 1;
    music.setDip(musicDip.gain);
    // The pad works the screens whenever no car (or drone) is reading it.
    const padUi = state === 'menu' || state === 'garage' || (state === 'race' && !!session && (session.paused || session.race.phase === 'finished') && !session.droneActive);
    padNav.poll(dt, padUi);
    if (padUi) input.swallowPad();
    if (arrival && state !== 'menu') endArrival();
    if (state === 'race' && session) {
      session.render(alpha, dt);
      driveFrame(dt, !session.paused && session.race.phase !== 'finished' && !session.droneActive);
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
    // The race's nitrous swells the music (eased by the session); everywhere else it sits at its slider.
    music.setLift(state === 'race' && session ? session.musicLift : 1);
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
  initAnalytics({ gpu: device.gpu, dpr: device.dpr, cores: device.cores, memoryGb: device.memoryGb, touch: device.touch });
  applyAutoQuality();
  // Every control ticks under the pointer and clicks when pressed, on every screen.
  installUiSounds();
  const direct = params.get('race');
  const directMode = RACE_MODES.find((m) => m === direct);
  const deepLink = !!directMode || params.has('garage') || params.has('drone') || params.has('freeroam');
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
      track('build_import', { carId: b.carId });
      notice = () => toast(`Loaded shared build "${b.name}"`, Check);
    } else notice = () => toast('That build code could not be read', Info);
    const u = new URL(location.href);
    u.searchParams.delete('build');
    history.replaceState(null, '', u);
  }
  loading?.remove();
  // A challenge link (results' Challenge a friend): the mark to beat, once.
  const beat = Number(params.get('beat'));
  if (directMode && beat > 0) {
    challengeMark = { seed: seedFromString(seedStr), mode: directMode, mark: beat };
    notice = () => toast(`Challenge: beat ${resultText(directMode, beat)}`, Trophy);
    const u = new URL(location.href);
    u.searchParams.delete('beat');
    history.replaceState(null, '', u);
  }
  if (directMode) startRace(directMode);
  else if (params.has('garage')) void openGarage(false);
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
    arrival = splash;
    await splash.land(overlay);
  }
  notice?.();
}

void boot();
