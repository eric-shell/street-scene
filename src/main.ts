import './style.css';
import * as THREE from 'three';
import { FixedStepLoop } from './loop';
import { createWorld } from './city/world';
import { seedFromString } from './sim/prng';
import { initialSeed } from './seed';
import { loadSettings } from './ui/settings';
import { GameRenderer, createNightScene } from './render/scene';
import { FreeFlyCamera } from './render/freeFly';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const settings = loadSettings();
const q = new URLSearchParams(location.search).get('quality');
if (q === 'low' || q === 'medium' || q === 'high') settings.quality = q;
const gr = new GameRenderer(canvas, settings);

const seedStr = initialSeed();
const world = createWorld(seedFromString(seedStr), 'circuit');
const night = createNightScene(world, gr, settings);
const fly = new FreeFlyCamera(canvas);
const g0 = world.route.grid[0];
fly.set(new THREE.Vector3(g0.x, world.heightAt(g0.x, g0.z) + 3, g0.z), g0.yaw + Math.PI, -0.08);
const camParam = new URLSearchParams(location.search).get('cam');
if (camParam === 'aerial') {
  fly.set(new THREE.Vector3(g0.x - Math.sin(g0.yaw) * 160, 90, g0.z - Math.cos(g0.yaw) * 160), g0.yaw, -0.42);
} else if (camParam) {
  const [x, y, z, yaw, pitch] = camParam.split(',').map(Number);
  fly.set(new THREE.Vector3(x, y, z), yaw, pitch);
}

const fpsEl = document.createElement('div');
fpsEl.style.cssText = 'position:fixed;top:6px;left:8px;font:12px monospace;color:#8f8;z-index:10';
document.body.appendChild(fpsEl);
let frames = 0;
let acc = 0;

const loop = new FixedStepLoop({
  tick() {},
  render(_alpha, dt) {
    fly.update(dt);
    night.lighting.update(fly.camera.position);
    gr.render(night.scene, fly.camera, dt);
    frames++;
    acc += dt;
    if (acc > 0.5) {
      fpsEl.textContent = `${Math.round(frames / acc)} fps  seed ${seedStr}`;
      frames = 0;
      acc = 0;
    }
  },
});
loop.start();
(window as unknown as Record<string, unknown>).__nr = { world, gr, night, fly };
