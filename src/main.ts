import './style.css';
import * as THREE from 'three';
import { FixedStepLoop } from './loop';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060f);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
camera.position.set(3, 2, 5);
camera.lookAt(0, 0, 0);
const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshNormalMaterial());
scene.add(cube);

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

let angle = 0;
let prevAngle = 0;
const loop = new FixedStepLoop({
  tick() {
    prevAngle = angle;
    angle += 0.02;
  },
  render(alpha) {
    cube.rotation.y = prevAngle + (angle - prevAngle) * alpha;
    renderer.render(scene, camera);
  },
});
loop.start();
