/**
 * Renderer, post chain, quality scaling and the night race scene. Read only
 * with respect to the simulation.
 */
import * as THREE from 'three';
import { World } from '../city/world';
import { QUALITY, QualityProfile, Settings } from '../ui/settings';
import { buildCityMeshes, CityMeshes } from './cityMeshes';
import { buildLightFx, fadeSubPixel, LightFx } from './lightFx';
import { FOG_COLOR, FOG_DENSITY, NightLighting } from './lighting';
import { PostFx } from './post';
import { makeNightEnvironment, makeSkyTexture } from './textures';
import { buildRouteArrows, classifyBarriers, RouteArrows } from './routeArrows';
import { buildRoadblocks } from './roadblocks';
import { buildProps, PropRenderer } from './props';
import { buildDistrictMeshes } from './districts';
import { buildBackdrop } from './backdrop';
import { buildCrowds, Crowds } from './crowds';

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
  /** Animate time-based effects (barrier lamps, arrows). */
  update(time: number): void;
  dispose(): void;
}

export function createNightScene(world: World, gr: GameRenderer, settings: Settings): NightScene {
  const scene = new THREE.Scene();
  scene.background = gr.sky;
  scene.environment = gr.envMap;
  scene.environmentIntensity = 0.55;
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
  const barriers = classifyBarriers(world);
  // Every closure is drawn as a barrier: spectators stand right behind side closures too.
  const city = buildCityMeshes(world);
  scene.add(city.group);
  // District dressing (lots, plazas, parks, river, roundabouts, subway) and the distant mountains.
  const districts = buildDistrictMeshes(world);
  scene.add(districts.group);
  const backdrop = buildBackdrop(world.seed);
  scene.add(backdrop.group);
  const fx = buildLightFx(city.lampPositions, city.signLights, world.heightAt, FOG_DENSITY);
  fx.setStrength(0.32, 0.85);
  scene.add(fx.group);
  const lighting = new NightLighting();
  lighting.setLamps(city.lampPositions);
  lighting.setPoolSize(gr.profile.pointLights);
  scene.add(lighting.group);
  const roadblocks = buildRoadblocks(world, barriers, city.barrierLampMaterial, { rows: { low: 2, medium: 3, high: 4 }[settings.quality], railRows: settings.quality === 'high' ? 2 : 1, drawDistance: { low: 170, medium: 240, high: 300 }[settings.quality] });
  scene.add(roadblocks.group);
  const arrows = buildRouteArrows(world, barriers, roadblocks.groups);
  scene.add(arrows.group);
  // Parked cars cull per group against whatever camera renders the scene.
  scene.onBeforeRender = (_r, _s, camera) => {
    roadblocks.update(camera);
    backdrop.follow(camera);
  };
  // Broken streetlights go dark: ground pool, reflection streak and the real light pool.
  const lampOff = new Uint8Array(city.lampPositions.length);
  const props = buildProps(world, {
    onLamp(i, on) {
      if (i < 0 || i >= lampOff.length || lampOff[i] === (on ? 0 : 1)) return;
      lampOff[i] = on ? 0 : 1;
      fx.setLampOn(i, on);
      lighting.setLamps(city.lampPositions.filter((_, k) => !lampOff[k]));
    },
  });
  scene.add(props.group);
  // Spectators by the start / finish gantries and in sections behind every closure and corner rail
  // (none in an open world). Sections thin out and draw less far at lower quality.
  const crowdQ =
    {
      low: { density: 0.55, rows: 2, sectionDensity: 0.35, sectionRows: 1, drawDistance: 140 },
      medium: { density: 0.8, rows: 2, sectionDensity: 0.55, sectionRows: 2, drawDistance: 190 },
      high: { density: 1, rows: 3, sectionDensity: 0.8, sectionRows: 2, drawDistance: 260 },
    }[settings.quality] ?? { density: 0.8, rows: 2, sectionDensity: 0.55, sectionRows: 2, drawDistance: 190 };
  const crowds = buildCrowds(world, world.openWorld ? [] : city.finishLine.gates, crowdQ);
  scene.add(crowds.group);
  stabilizeSmallEmitters(city);
  return {
    scene,
    city,
    fx,
    lighting,
    arrows,
    props,
    crowds,
    update(time) {
      arrows.update(time);
      districts.update(time);
      backdrop.update(time);
      // Hazard blink with soft edges: a hard 3.2 / 0.6 square wave strobes the bloom.
      const blink = 0.6 + 2.6 * THREE.MathUtils.smoothstep(Math.sin(time * 5), -0.35, 0.35);
      city.barrierLampMaterial.color.setRGB(1 * blink, 0.63 * blink, 0.12 * blink);
    },
    dispose() {
      city.dispose();
      districts.dispose();
      backdrop.dispose();
      fx.dispose();
      arrows.dispose();
      roadblocks.dispose();
      props.dispose();
      crowds.dispose();
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
