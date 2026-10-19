/**
 * Renderer, post chain, quality scaling and the night race scene. Read only
 * with respect to the simulation.
 */
import * as THREE from 'three';
import { World } from '../city/world';
import { QUALITY, Settings } from '../ui/settings';
import { buildCityMeshes, CityMeshes } from './cityMeshes';
import { buildLightFx, LightFx } from './lightFx';
import { FOG_COLOR, FOG_DENSITY, NightLighting } from './lighting';
import { PostFx } from './post';
import { makeNightEnvironment, makeSkyTexture } from './textures';
import { buildRouteArrows, classifyBarriers, RouteArrows } from './routeArrows';
import { buildRoadblocks } from './roadblocks';

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
    const q = QUALITY[s.quality];
    this.post.configure({ bloom: q.bloom, bloomScale: q.bloomScale, bloomStrength: q.bloomStrength, retro: s.retro });
    this.canvas.style.imageRendering = s.retro ? 'pixelated' : 'auto';
    this.resize();
  }

  get pixelRatio(): number {
    if (this.settings.retro) return RETRO_HEIGHT / Math.max(1, this.height);
    const q = QUALITY[this.settings.quality];
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
  const city = buildCityMeshes(world, new Set(barriers.filter((b) => b.headOn).map((b) => b.wall)));
  scene.add(city.group);
  const fx = buildLightFx(city.lampPositions, city.signLights, world.heightAt, FOG_DENSITY);
  fx.setStrength(0.32, 0.85);
  scene.add(fx.group);
  const lighting = new NightLighting();
  lighting.setLamps(city.lampPositions);
  lighting.setPoolSize(QUALITY[settings.quality].pointLights);
  scene.add(lighting.group);
  const arrows = buildRouteArrows(world, barriers);
  scene.add(arrows.group);
  const roadblocks = buildRoadblocks(world, barriers, city.barrierLampMaterial);
  scene.add(roadblocks.group);
  return {
    scene,
    city,
    fx,
    lighting,
    arrows,
    update(time) {
      arrows.update(time);
      const blink = Math.sin(time * 5) > 0 ? 3.2 : 0.6;
      city.barrierLampMaterial.color.setRGB(1 * blink, 0.63 * blink, 0.12 * blink);
    },
    dispose() {
      city.dispose();
      fx.dispose();
      arrows.dispose();
      roadblocks.dispose();
    },
  };
}
