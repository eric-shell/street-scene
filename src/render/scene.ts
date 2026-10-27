/**
 * Renderer, post chain, quality scaling and the night race scene. Read only
 * with respect to the simulation.
 */
import * as THREE from 'three';
import { World } from '../city/world';
import { QUALITY, QualityProfile, Settings } from '../ui/settings';
import { buildCityMeshes, CityMeshes } from './street/cityMeshes';
import { buildLightFx, LightFx } from './street/lightFx';
import { fitLampPositions, LAMP_TONES, planLamps, toneColor } from './street/lampStyle';
import { fadeSubPixel } from './materialFx';
import { NightLighting } from './lighting';
import { NEUTRAL_GRADE, POST_GRAIN, POST_TAPS, PostFx, type GradeParams } from './post';
import { cityIdentity } from './cityIdentity';
import { makeNightEnvironment } from './textures/textures';
import { buildRouteArrows, classifyBarriers, RouteArrows } from './race/routeArrows';
import { MEET_VARIANTS, buildRoadblocks, parkedCars, type Roadblocks } from './race/roadblocks';
import { MEET_QUALITY, planMeets } from './race/meetPlan';
import { buildProps, PropRenderer } from './street/props';
import { buildDistrictMeshes } from './districts';
import { Backdrop, buildBackdrop } from './sky/backdrop';
import { CROWD_QUALITY, buildCrowds, Crowds } from './race/crowds';
import { IDLE_QUALITY, buildIdlers, Idlers } from './people/idlers';
import { planIdlers } from './people/idleSpots';
import { buildStreetPolish } from './street/streetPolish';
import { createWeather, Weather } from './sky/weather';
import { AirTraffic, buildAirTraffic } from './traffic/airTraffic';
import { buildAreaLights } from './street/areaLights';
import { marketLightPoints, planMarketCrowd } from './districts/marketPlan';
import { highwayLamps } from './districts/highway';
import { harborSea } from './districts/waterfront';
import { GROUND_PAINT_ORDER, underVehicles } from './vehicleMask';
import { damp } from '../shared/anim';
import { buildWallOverlay } from './wallOverlay';
import { CityChunks, chunkGrid, fogCutoff, type ChunkClass } from './cityChunks';

/** Retro mode's render height (px): the view is drawn this many pixels tall and scaled up. */
const RETRO_HEIGHT = 240;

/**
 * Each night scene's colour grade (its seed's city identity). The grade lives with the scene, not on the post
 * chain, because one GameRenderer shows several scenes in turn: the menu city, a race of another seed built
 * while the menu still shows, the garage's workshop (no grade). GameRenderer.render applies it whenever the
 * rendered scene changes, so whichever scene is on screen wears its own.
 */
const sceneGrades = new WeakMap<THREE.Scene, GradeParams>();

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly post: PostFx;
  readonly envMap: THREE.Texture;
  private settings: Settings;
  private width = 1;
  private height = 1;
  private placeholderScene = new THREE.Scene();
  private placeholderCam = new THREE.PerspectiveCamera();
  private autoProfile: QualityProfile | null = null;
  /** Screen a menu rail covers (CSS px from the left and the bottom), eased toward frameTarget. */
  private frame = { left: 0, bottom: 0 };
  private frameTarget = { left: 0, bottom: 0 };
  /** The scene whose grade the post chain holds. */
  private gradedScene: THREE.Scene | null = null;

  constructor(readonly canvas: HTMLCanvasElement, settings: Settings) {
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envTex = new THREE.CanvasTexture(makeNightEnvironment(7));
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    envTex.colorSpace = THREE.SRGBColorSpace;
    this.envMap = pmrem.fromEquirectangular(envTex).texture;
    envTex.dispose();
    pmrem.dispose();
    this.post = new PostFx(this.renderer, this.placeholderScene, this.placeholderCam);
    window.addEventListener('resize', () => this.resize());
    this.applySettings(settings);
  }

  applySettings(s: Settings): void {
    this.settings = s;
    const q = this.profile;
    this.post.configure({ bloom: q.bloom, bloomScale: q.bloomScale, bloomStrength: q.bloomStrength, retro: s.retro, msaa: q.antialias ? 4 : 0, taps: POST_TAPS[s.quality], grain: POST_GRAIN[s.quality] });
    this.canvas.style.imageRendering = s.retro ? 'pixelated' : 'auto';
    this.resize();
  }

  /** Fine grained level picked by auto quality (used while settings.autoQuality is on). */
  setAutoProfile(p: QualityProfile): void {
    this.autoProfile = p;
    this.applySettings(this.settings);
  }

  /** What is being rendered with: the auto level, or the chosen preset. */
  get profile(): QualityProfile {
    return this.settings.autoQuality && this.autoProfile ? this.autoProfile : QUALITY[this.settings.quality];
  }

  get pixelRatio(): number {
    if (this.settings.retro) return RETRO_HEIGHT / Math.max(1, this.height);
    const q = this.profile;
    return Math.min(window.devicePixelRatio || 1, q.pixelRatioCap) * q.renderScale;
  }

  resize(): void {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    const pr = this.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.width, this.height, false);
    this.post.setSize(this.width, this.height, pr);
  }

  get aspect(): number {
    return this.width / Math.max(1, this.height);
  }

  /**
   * Center the view on the part of the screen a menu leaves free: `left` and
   * `bottom` are the CSS px its rail covers (ui/rail/rail.ts railInset). The view
   * eases there over a few tenths of a second unless `snap`; zeros give the
   * camera the whole screen again. Races snap to zero: their view never shifts.
   */
  setFraming(left: number, bottom: number, snap = false): void {
    this.frameTarget.left = left;
    this.frameTarget.bottom = bottom;
    if (snap) {
      this.frame.left = left;
      this.frame.bottom = bottom;
    }
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, dt: number): void {
    if (Math.abs(camera.aspect - this.aspect) > 1e-4) {
      camera.aspect = this.aspect;
      camera.updateProjectionMatrix();
    }
    // The subject stays centered in the free area: shift the projection by half of what the rail covers.
    const f = this.frame;
    const k = damp(7, dt);
    f.left += (this.frameTarget.left - f.left) * k;
    f.bottom += (this.frameTarget.bottom - f.bottom) * k;
    if (Math.abs(f.left) > 0.5 || Math.abs(f.bottom) > 0.5) camera.setViewOffset(this.width, this.height, -f.left / 2, f.bottom / 2, this.width, this.height);
    else if (camera.view?.enabled) camera.clearViewOffset();
    if (scene !== this.gradedScene) {
      this.gradedScene = scene;
      this.post.setGrade(sceneGrades.get(scene) ?? NEUTRAL_GRADE);
    }
    this.post.setScene(scene, camera);
    this.post.render(dt);
  }
}

export interface NightScene {
  scene: THREE.Scene;
  city: CityMeshes;
  fx: LightFx;
  lighting: NightLighting;
  arrows: RouteArrows;
  /** The route's barriers and the street meets behind them (none in an open world). */
  roadblocks: Roadblocks;
  /** Street furniture; feed it RaceState.brokenProps every frame (props.update). */
  props: PropRenderer;
  /** Spectators at the start / finish (empty in open world); feed it car poses every frame (crowds.update). */
  crowds: Crowds;
  /** Idle people around the city; feed it car poses every frame (idlers.update). */
  idlers: Idlers;
  /** The seed's weather mood: fog, sky, rain or mist (weather.ts). */
  weather: Weather;
  /** The news helicopter, its searchlight and the blimp (airTraffic.ts). */
  air: AirTraffic;
  /** Mountains, masts and the sky sprites (backdrop.ts). */
  backdrop: Backdrop;
  /** Per-cell culling inside the big merged city layers (cityChunks.ts). */
  chunks: CityChunks;
  /** Animate time-based effects (barrier lamps, arrows). */
  update(time: number): void;
  /** Pose the sim-timed district parts (the El's trains, level crossing gates, RaceState.brokenArms) at a fractional sim tick; call before update. */
  syncDistricts(tick: number, audible: boolean, brokenArms?: Uint8Array): void;
  dispose(): void;
}

export function createNightScene(world: World, gr: GameRenderer, settings: Settings): NightScene {
  const scene = new THREE.Scene();
  scene.environment = gr.envMap;
  // The seed's colour grade, worn whenever this scene is the one rendered (the menu stage and a race alike).
  sceneGrades.set(scene, cityIdentity(world.seed).grade);
  // The seed's mood first: it sets the fog every other build fogs itself with, the sky and the haze.
  // Flash effects (lightning, the police light bar) follow the live setting; off softens them.
  const flashes = () => settings.flashEffects !== false;
  const weather = createWeather(world, { quality: settings.quality, flashes });
  const fogDensity = weather.def.fogDensity;
  const barriers = classifyBarriers(world);
  const city = buildCityMeshes(world, { detail: settings.quality });
  scene.add(city.group);
  // District dressing (lots, plazas, parks, river, roundabouts, subway) and the distant mountains.
  const districts = buildDistrictMeshes(world, { quality: settings.quality, hazardLamp: city.barrierLampMaterial });
  scene.add(districts.group);
  const bounds = world.graph.bounds;
  const backdrop = buildBackdrop(world.seed, {
    fogColor: weather.def.fogColor,
    stars: weather.def.stars,
    moon: weather.def.moon,
    halo: weather.def.halo,
    moonPhase: weather.moonPhase,
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerZ: (bounds.minZ + bounds.maxZ) / 2,
    // A harbor's open water runs out to a low far shore (districts/waterfront.ts).
    sea: harborSea(world) ?? undefined,
  });
  scene.add(backdrop.group);
  // Street level polish: road decals, puddles, posters, blade signs, banners, steam (pasted onto the drawn podiums).
  const polish = buildStreetPolish(world, { quality: settings.quality, facades: (city.group.getObjectByName('podiums') as THREE.Mesh | undefined)?.geometry });
  scene.add(polish.group);
  // Each neighbourhood's post design and lamp colour: the lamp heads move to their design's reach and height, and the
  // pool, streak, point light and the props' lens tint all read the same plan.
  const lampPlan = planLamps(world);
  fitLampPositions(world, city.lampPositions, lampPlan);
  const lampTone = lampPlan.tone.map((t) => LAMP_TONES[t]);
  const fx = buildLightFx(city.lampPositions, city.signLights, world.heightAt, fogDensity, lampTone.map((t) => ({ pool: toneColor(t.pool), streak: toneColor(t.streak) })));
  fx.setStrength(0.42, 0.85);
  scene.add(fx.group);
  // Parks and plazas: a wash over the whole area and a pool under every lantern post.
  const areaLights = buildAreaLights(world);
  scene.add(areaLights.group);
  // Every lamp the real light pool may pick: streetlights, then the park lamps (the props' light order),
  // then the night market's lantern strings and the expressway's lamps (never switched off, so they come last).
  const lamps = [...city.lampPositions, ...areaLights.lamps, ...marketLightPoints(world).map((p) => new THREE.Vector3(p.x, p.y, p.z)), ...highwayLamps(world)];
  const lighting = new NightLighting();
  // Streetlights burn their neighbourhood's colour; every other lamp keeps the warm default.
  const lampColors = lampTone.map((t) => toneColor(t.light));
  lighting.setLamps(lamps, lampColors);
  lighting.setPoolSize(gr.profile.pointLights);
  scene.add(lighting.group);
  weather.apply(scene, lighting);
  scene.add(weather.group);
  const air = buildAirTraffic(world, { quality: settings.quality, fogDensity, flashes });
  scene.add(air.group);
  // Street meets behind every cyan barrier: a crowd against the barrier, thinning back among parked cars.
  const meetQ = MEET_QUALITY[settings.quality];
  const meet = planMeets(world, {
    cars: parkedCars().map((c) => ({ length: c.dimensions.length, width: c.dimensions.width, variants: MEET_VARIANTS })),
    peopleDensity: meetQ.peopleDensity,
    peopleDepth: meetQ.peopleDepth,
    carRows: meetQ.carRows,
  });
  const roadblocks = buildRoadblocks(world, meet, city.barrierLampMaterial, { drawDistance: meetQ.drawDistance });
  scene.add(roadblocks.group);
  const arrows = buildRouteArrows(world, barriers, { beacon: city.barrierLampMaterial });
  scene.add(arrows.group);
  // The big merged layers cull per 200 m cell (registered last, below).
  const chunks = new CityChunks(chunkGrid(world.graph.bounds));
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('cull') === 'off') chunks.enabled = false;
  // Parked cars cull per group against whatever camera renders the scene.
  scene.onBeforeRender = (r, _s, camera) => {
    const viewportHeight = r.domElement.clientHeight || window.innerHeight;
    roadblocks.update(camera);
    backdrop.follow(camera, viewportHeight);
    weather.view(camera, viewportHeight);
    air.view(camera);
    districts.view(camera);
    const density = (scene.fog as THREE.FogExp2 | null)?.density ?? fogDensity;
    chunks.view(camera, density, gr.profile.detailDistance);
    // Props cull by the same grid: detail kinds at detailDistance, the tall ones where the fog closes.
    if (chunks.enabled) props.view(camera, gr.profile.detailDistance, fogCutoff(density));
    else props.view(camera, Infinity, Infinity);
  };
  // Broken lamps go dark: ground pool, reflection streak (streetlights) and the real light pool.
  const lampOff = new Uint8Array(lamps.length);
  const streetLamps = city.lampPositions.length;
  const props = buildProps(world, {
    quality: settings.quality,
    grid: chunks.grid,
    onLamp(i, on) {
      if (i < 0 || i >= lampOff.length || lampOff[i] === (on ? 0 : 1)) return;
      lampOff[i] = on ? 0 : 1;
      if (i < streetLamps) fx.setLampOn(i, on);
      else areaLights.setLampOn(i - streetLamps, on);
      lighting.setLamps(lamps.filter((_, k) => !lampOff[k]), lampColors.filter((_, k) => !lampOff[k]));
    },
  });
  scene.add(props.group);
  // Spectators on the sidewalks by the start / finish gantries, and every meet's crowd (none in an open world).
  const crowdQ = CROWD_QUALITY[settings.quality];
  const gates = world.openWorld ? [] : city.finishLine.gates;
  const markets = planMarketCrowd(world, crowdQ.density);
  const crowds = buildCrowds(world, gates, { ...crowdQ, drawDistance: meetQ.crowdDraw, meet, sections: markets });
  scene.add(crowds.group);
  // Idle people: waiting, sitting and chatting around the city, off the route and away from the stands (people/idleSpots.ts).
  const idleQ = IDLE_QUALITY[settings.quality];
  const idlePlan = planIdlers(world, { density: idleQ.density, cap: idleQ.cap, shopFronts: city.shopFronts, avoid: { gates, meets: meet, markets } });
  const idlers = buildIdlers(world, idlePlan.people, { quality: settings.quality, warmth: idlePlan.warmth });
  scene.add(idlers.group);
  // Dev builds: `?walls` draws the sim's collision over the scene (wallOverlay.ts).
  const walls = import.meta.env.DEV && new URLSearchParams(location.search).has('walls') ? buildWallOverlay(world) : null;
  if (walls) scene.add(walls.group);
  stabilizeSmallEmitters(city);
  keepGroundLayersUnderVehicles(scene);
  // Every material that fogs itself in a shader now gets the mood's fog.
  weather.retuneFog(scene);
  // Last: stabilizeSmallEmitters reads each layer's material as a single one, and chunking wraps it in an array.
  chunks.addByName(scene, CHUNK_LAYERS);
  return {
    scene,
    chunks,
    city,
    fx,
    lighting,
    arrows,
    roadblocks,
    props,
    crowds,
    idlers,
    weather,
    air,
    backdrop,
    syncDistricts(tick, audible, brokenArms) {
      districts.sync(tick, audible, brokenArms);
    },
    update(time) {
      city.update(time);
      arrows.update(time);
      districts.update(time);
      backdrop.update(time);
      polish.update(time);
      weather.update(time);
      air.update(time);
      // Hazard blink with soft edges: a hard 3.2 / 0.6 square wave strobes the bloom.
      const blink = 0.6 + 2.6 * THREE.MathUtils.smoothstep(Math.sin(time * 5), -0.35, 0.35);
      city.barrierLampMaterial.color.setRGB(1 * blink, 0.63 * blink, 0.12 * blink);
    },
    dispose() {
      city.dispose();
      districts.dispose();
      backdrop.dispose();
      polish.dispose();
      fx.dispose();
      areaLights.dispose();
      arrows.dispose();
      roadblocks.dispose();
      props.dispose();
      crowds.dispose();
      idlers.dispose();
      weather.dispose();
      air.dispose();
      walls?.dispose();
    },
  };
}

/**
 * The merged city layers worth culling per cell (cityChunks.ts), by name. Fog
 * layers stop where the fog closes, detail layers (paint, small dressing) at the
 * quality's detailDistance; sky layers (building shells and roofs) only leave
 * with the frustum, since their fogged silhouettes still draw the skyline.
 * Alpha-blended decals (roadDecals, puddles, wallPaint) stay whole: their
 * triangle order is their draw order. Layers under CHUNKS.minTris are skipped.
 */
const CHUNK_LAYERS: Record<string, ChunkClass> = {
  podiumTrim: 'detail',
  districtSolid: 'fog',
  districtGround: 'fog',
  podiums: 'fog',
  roofs: 'sky',
  buildings: 'sky',
  roads: 'fog',
  sidewalks: 'fog',
  districtGlow: 'fog',
  districtFoliage: 'fog',
  districtTrees: 'fog',
  elevatedSteel: 'fog',
  riverConcrete: 'fog',
  signs: 'fog',
  roofNeon: 'fog',
  billboards: 'fog',
  markings: 'detail',
  cobbles: 'detail',
  fireEscapes: 'detail',
  awnings: 'detail',
  districtPaint: 'detail',
  elevatedTies: 'detail',
  wallBoxes: 'detail',
  // Additive light: order independent, so splitting it into runs changes nothing on screen.
  lightSpill: 'fog',
  areaLights: 'fog',
  elevatedPools: 'fog',
};

/** Ground light that cars drive through: additive pools and washes, and decals on the road (vehicleMask.ts). */
const GROUND_LIGHT_LAYERS = new Set([
  'streetPools',
  'streetStreaks',
  'lightSpill',
  'areaLights',
  'riverLightPools',
  'riverDecals',
  'shortcutLightPools',
  'marketLight',
  'roadworksLightPools',
  'driftZoneWash',
  'tunnelWash',
  'overpassWash',
  'roadDecals',
  'puddles',
]);
/** Opaque paint on the road: drawn after the cars so it can skip them too. */
const GROUND_PAINT_LAYERS = new Set(['markings', 'districtPaint']);

/**
 * Lay every ground layer under the cars: each sits a few cm over the road and
 * would otherwise draw over the bottom of every tire in it (vehicleMask.ts).
 * A new pool, wash or road decal joins the lists above.
 */
function keepGroundLayersUnderVehicles(scene: THREE.Scene): void {
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const paint = GROUND_PAINT_LAYERS.has(o.name);
    if (!mesh.isMesh || !(paint || GROUND_LIGHT_LAYERS.has(o.name))) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) underVehicles(m);
    if (paint) mesh.renderOrder = GROUND_PAINT_ORDER;
  });
}

/**
 * Flicker fixes for city meshes that are built elsewhere: fade the tiny HDR
 * emitters by pixel coverage (see fadeSubPixel), and push the road markings
 * towards the camera so they stop z-fighting the asphalt 2.5 cm below them in
 * the distance, where depth precision runs out.
 */
function stabilizeSmallEmitters(city: CityMeshes): void {
  const mat = (name: string) => (city.group.getObjectByName(name) as THREE.Mesh | undefined)?.material as THREE.Material | undefined;
  const lens = mat('streetlightLenses');
  if (lens) fadeSubPixel(lens, 0.36, 0.25);
  const neon = mat('roofNeon');
  if (neon) fadeSubPixel(neon, 0.5, 0.3);
  fadeSubPixel(city.barrierLampMaterial, 0.2, 0.3);
  // The start line sits 5 mm above the markings, so it gets the larger offset.
  for (const [name, offset] of [
    ['markings', 1],
    ['startLine', 2],
  ] as const) {
    const m = mat(name);
    if (m && !m.polygonOffset) {
      m.polygonOffset = true;
      m.polygonOffsetFactor = -offset;
      m.polygonOffsetUnits = -2 * offset;
    }
  }
}
