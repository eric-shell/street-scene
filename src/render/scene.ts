/**
 * Renderer, post chain, quality scaling and the night race scene. Read only
 * with respect to the simulation.
 */
import * as THREE from 'three';
import { World } from '../city/world';
import { QUALITY, QualityProfile, Settings } from '../ui/settings';
import { buildCityMeshes, CityMeshes } from './cityMeshes';
import { buildLightFx, fadeSubPixel, LightFx } from './lightFx';
import { NightLighting } from './lighting';
import { PostFx } from './post';
import { makeNightEnvironment, makeSkyTexture } from './textures';
import { buildRouteArrows, classifyBarriers, RouteArrows } from './routeArrows';
import { MEET_VARIANTS, buildRoadblocks, parkedCars } from './roadblocks';
import { planMeets } from './meetPlan';
import { buildProps, PropRenderer } from './props';
import { buildDistrictMeshes } from './districts';
import { Backdrop, buildBackdrop } from './backdrop';
import { buildCrowds, Crowds } from './crowds';
import { buildStreetPolish } from './streetPolish';
import { createWeather, Weather } from './weather';
import { AirTraffic, buildAirTraffic } from './airTraffic';
import { buildAreaLights } from './areaLights';
import { marketLightPoints, planMarketCrowd } from './marketPlan';
import { buildDrawbridge, DrawbridgeView } from './drawbridge';

export const RETRO_HEIGHT = 240;

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly post: PostFx;
  readonly envMap: THREE.Texture;
  readonly sky: THREE.Texture;
  private settings: Settings;
  private width = 1;
  private height = 1;
  private placeholderScene = new THREE.Scene();
  private placeholderCam = new THREE.PerspectiveCamera();
  private autoProfile: QualityProfile | null = null;

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
    this.sky = makeSkyTexture();
    this.post = new PostFx(this.renderer, this.placeholderScene, this.placeholderCam);
    window.addEventListener('resize', () => this.resize());
    this.applySettings(settings);
  }

  applySettings(s: Settings): void {
    this.settings = s;
    const q = this.profile;
    this.post.configure({ bloom: q.bloom, bloomScale: q.bloomScale, bloomStrength: q.bloomStrength, retro: s.retro, msaa: q.antialias ? 4 : 0 });
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

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, dt: number): void {
    if (Math.abs(camera.aspect - this.aspect) > 1e-4) {
      camera.aspect = this.aspect;
      camera.updateProjectionMatrix();
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
  /** Street furniture; feed it RaceState.brokenProps every frame (props.update). */
  props: PropRenderer;
  /** Spectators at the start / finish (empty in open world); feed it car poses every frame (crowds.update). */
  crowds: Crowds;
  /** The seed's weather mood: fog, sky, rain or mist (weather.ts). */
  weather: Weather;
  /** The news helicopter, its searchlight and the blimp (airTraffic.ts). */
  air: AirTraffic;
  /** Mountains, masts and the sky sprites (backdrop.ts). */
  backdrop: Backdrop;
  /** The drawbridge (drawbridge.ts): a session poses it at sim time with sync(); otherwise it runs on the scene clock. */
  drawbridge: DrawbridgeView;
  /** Animate time-based effects (barrier lamps, arrows). */
  update(time: number): void;
  /** Pose the sim-timed district parts (the El's trains, level crossing gates) at a fractional sim tick; call before update. */
  syncDistricts(tick: number, audible: boolean): void;
  dispose(): void;
}

export function createNightScene(world: World, gr: GameRenderer, settings: Settings): NightScene {
  const scene = new THREE.Scene();
  scene.environment = gr.envMap;
  // The seed's mood first: it sets the fog every other build fogs itself with, the sky and the haze.
  // Flash effects (lightning, the police light bar) follow the live setting; off softens them.
  const flashes = () => settings.flashEffects !== false;
  const weather = createWeather(world, { quality: settings.quality, flashes });
  const fogDensity = weather.def.fogDensity;
  const barriers = classifyBarriers(world);
  const city = buildCityMeshes(world, { detail: settings.quality });
  scene.add(city.group);
  // District dressing (lots, plazas, parks, river, roundabouts, subway) and the distant mountains.
  const districts = buildDistrictMeshes(world, { quality: settings.quality });
  scene.add(districts.group);
  // The drawbridge's leaves and gates, its leaves dressed in the street's own materials.
  const cityMat = (name: string) => (city.group.getObjectByName(name) as THREE.Mesh | undefined)?.material as THREE.Material | undefined;
  const drawbridge = buildDrawbridge(world, { quality: settings.quality, road: cityMat('roads'), walk: cityMat('sidewalks'), marks: cityMat('markings') });
  scene.add(drawbridge.group);
  const bounds = world.graph.bounds;
  const backdrop = buildBackdrop(world.seed, {
    fogColor: weather.def.fogColor,
    stars: weather.def.stars,
    moon: weather.def.moon,
    halo: weather.def.halo,
    moonPhase: weather.moonPhase,
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerZ: (bounds.minZ + bounds.maxZ) / 2,
  });
  scene.add(backdrop.group);
  // Street level polish: road decals, puddles, graffiti, blade signs, banners, steam (pasted onto the drawn podiums).
  const polish = buildStreetPolish(world, { quality: settings.quality, facades: (city.group.getObjectByName('podiums') as THREE.Mesh | undefined)?.geometry });
  scene.add(polish.group);
  const fx = buildLightFx(city.lampPositions, city.signLights, world.heightAt, fogDensity);
  fx.setStrength(0.42, 0.85);
  scene.add(fx.group);
  // Parks and plazas: a wash over the whole area and a pool under every lantern post.
  const areaLights = buildAreaLights(world);
  scene.add(areaLights.group);
  // Every lamp the real light pool may pick: streetlights, then the park lamps (the props' light order),
  // then the night market's lantern strings (never switched off, so they come last).
  const lamps = [...city.lampPositions, ...areaLights.lamps, ...marketLightPoints(world).map((p) => new THREE.Vector3(p.x, p.y, p.z))];
  const lighting = new NightLighting();
  lighting.setLamps(lamps);
  lighting.setPoolSize(gr.profile.pointLights);
  scene.add(lighting.group);
  weather.apply(scene, lighting);
  scene.add(weather.group);
  const air = buildAirTraffic(world, { quality: settings.quality, fogDensity, flashes });
  scene.add(air.group);
  // Street meets behind every cyan barrier: a crowd against the barrier, thinning back among parked
  // cars. Denser, deeper and drawn further at higher quality.
  const meetQ =
    {
      low: { peopleDensity: 0.45, peopleDepth: 5, carRows: 2, drawDistance: 170, crowdDraw: 140 },
      medium: { peopleDensity: 0.7, peopleDepth: 7, carRows: 3, drawDistance: 240, crowdDraw: 190 },
      high: { peopleDensity: 1, peopleDepth: 9, carRows: 5, drawDistance: 300, crowdDraw: 260 },
    }[settings.quality] ?? { peopleDensity: 0.7, peopleDepth: 7, carRows: 3, drawDistance: 240, crowdDraw: 190 };
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
  // Parked cars cull per group against whatever camera renders the scene.
  scene.onBeforeRender = (r, _s, camera) => {
    const viewportHeight = r.domElement.clientHeight || window.innerHeight;
    roadblocks.update(camera);
    backdrop.follow(camera, viewportHeight);
    weather.view(camera, viewportHeight);
    air.view(camera);
    districts.view(camera);
    drawbridge.view(camera);
  };
  // Broken lamps go dark: ground pool, reflection streak (streetlights) and the real light pool.
  const lampOff = new Uint8Array(lamps.length);
  const streetLamps = city.lampPositions.length;
  const props = buildProps(world, {
    onLamp(i, on) {
      if (i < 0 || i >= lampOff.length || lampOff[i] === (on ? 0 : 1)) return;
      lampOff[i] = on ? 0 : 1;
      if (i < streetLamps) fx.setLampOn(i, on);
      else areaLights.setLampOn(i - streetLamps, on);
      lighting.setLamps(lamps.filter((_, k) => !lampOff[k]));
    },
  });
  scene.add(props.group);
  // Spectators on the sidewalks by the start / finish gantries, and every meet's crowd (none in an open world).
  const crowdQ = { low: { density: 0.55, rows: 2 }, medium: { density: 0.8, rows: 2 }, high: { density: 1, rows: 3 } }[settings.quality] ?? { density: 0.8, rows: 2 };
  const crowds = buildCrowds(world, world.openWorld ? [] : city.finishLine.gates, { ...crowdQ, drawDistance: meetQ.crowdDraw, meet, sections: planMarketCrowd(world, crowdQ.density) });
  scene.add(crowds.group);
  stabilizeSmallEmitters(city);
  // Every material that fogs itself in a shader now gets the mood's fog.
  weather.retuneFog(scene);
  return {
    scene,
    city,
    fx,
    lighting,
    arrows,
    props,
    crowds,
    weather,
    air,
    backdrop,
    drawbridge,
    syncDistricts(tick, audible) {
      districts.sync(tick, audible);
    },
    update(time) {
      city.update(time);
      arrows.update(time);
      districts.update(time);
      backdrop.update(time);
      polish.update(time);
      weather.update(time);
      air.update(time);
      drawbridge.clock(time);
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
      weather.dispose();
      air.dispose();
      drawbridge.dispose();
    },
  };
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
