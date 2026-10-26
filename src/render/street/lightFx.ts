/**
 * Cheap fake lighting for the wet street look: additive light pools on the
 * ground under every streetlight, and camera facing reflection streaks that
 * stretch from each light toward the viewer like on wet asphalt.
 */
import * as THREE from 'three';
import { makeRadialGlow } from '../textures/textures';

/** Width of the light pool under a streetlight (m). */
const POOL_SIZE = 19;

export interface LightFx {
  group: THREE.Group;
  setStrength(pool: number, streak: number): void;
  /** Switch one streetlight's ground pool and reflection streak (broken lamps go dark). */
  setLampOn(index: number, on: boolean): void;
  dispose(): void;
}

/** The reflection streak's shaders (instanced: iPos at the reflecting surface, iColor, iSize = width and the light's height over it), shared with the harbor's water (render/districts/waterfront.ts). */
export const streakVert = /* glsl */ `
  attribute vec3 iPos;
  attribute vec3 iColor;
  attribute vec2 iSize;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vFog;
  uniform float fogDensity;
  void main() {
    vec2 toCam = cameraPosition.xz - iPos.xz;
    float dist = max(length(toCam), 0.001);
    vec2 d = toCam / dist;
    vec2 p = vec2(-d.y, d.x);
    float len = min(iSize.y * 2.4, dist * 0.75);
    vec2 xz = iPos.xz + p * position.x * iSize.x + d * position.y * len;
    vec3 wp = vec3(xz.x, iPos.y, xz.y);
    vUv = position.xy;
    vColor = iColor;
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    float fd = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * fd * fd);
    // fade streaks seen from above: reflections need a grazing angle
    float graze = clamp(1.0 - (cameraPosition.y - iPos.y) / max(dist, 1.0) * 0.6, 0.0, 1.0);
    vColor *= graze;
    gl_Position = projectionMatrix * mv;
  }
`;

export const streakFrag = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vFog;
  uniform float strength;
  void main() {
    // x * x, not pow(x, 2.0): pow of a negative base is undefined in GLSL and
    // returns NaN on some GPUs, which the bloom then smears into flicker.
    float ax = vUv.x * 3.2;
    float across = exp(-ax * ax);
    float along = (1.0 - smoothstep(0.0, 1.0, vUv.y)) * smoothstep(-0.2, 0.05, vUv.y);
    float a = across * along * strength * vFog;
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`;

export function buildLightFx(
  lamps: THREE.Vector3[],
  signs: { pos: THREE.Vector3; color: THREE.Color }[],
  heightAt: (x: number, z: number) => number,
  fogDensity: number,
): LightFx {
  const group = new THREE.Group();
  group.name = 'lightFx';
  const glow = makeRadialGlow();

  // Ground pools
  const poolGeo = new THREE.PlaneGeometry(1, 1);
  poolGeo.rotateX(-Math.PI / 2);
  const poolMat = new THREE.MeshBasicMaterial({
    map: glow,
    color: new THREE.Color(0xffb46a),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const pools = new THREE.InstancedMesh(poolGeo, poolMat, lamps.length);
  const m = new THREE.Matrix4();
  lamps.forEach((p, i) => {
    const y = heightAt(p.x, p.z) + 0.2;
    m.makeScale(POOL_SIZE, 1, POOL_SIZE).setPosition(p.x, y, p.z);
    pools.setMatrixAt(i, m);
  });
  pools.name = 'streetPools';
  pools.frustumCulled = false;
  pools.renderOrder = 1;
  group.add(pools);

  // Reflection streaks
  const all = [
    ...lamps.map((p) => ({ pos: p, color: new THREE.Color(0xffb060).multiplyScalar(0.9), w: 1.6 })),
    ...signs.map((s) => ({ pos: s.pos, color: s.color.clone().multiplyScalar(1.3), w: 2.6 })),
  ];
  const base = new THREE.PlaneGeometry(1, 1.2);
  base.translate(0, 0.4, 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.attributes.position);
  const iPos = new Float32Array(all.length * 3);
  const iColor = new Float32Array(all.length * 3);
  const iSize = new Float32Array(all.length * 2);
  all.forEach((l, i) => {
    const gy = heightAt(l.pos.x, l.pos.z);
    iPos.set([l.pos.x, gy + 0.09, l.pos.z], i * 3);
    iColor.set([l.color.r, l.color.g, l.color.b], i * 3);
    iSize.set([l.w, Math.max(2, l.pos.y - gy)], i * 2);
  });
  geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
  geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(iColor, 3));
  geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(iSize, 2));
  geo.instanceCount = all.length;
  const streakMat = new THREE.ShaderMaterial({
    vertexShader: streakVert,
    fragmentShader: streakFrag,
    uniforms: { strength: { value: 0.9 }, fogDensity: { value: fogDensity } },
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
    // Only 7 cm above the asphalt: without an offset distant streaks z-fight with it.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const streaks = new THREE.Mesh(geo, streakMat);
  streaks.name = 'streetStreaks';
  streaks.frustumCulled = false;
  streaks.renderOrder = 2;
  group.add(streaks);

  return {
    group,
    setStrength(pool, streak) {
      poolMat.opacity = pool;
      streakMat.uniforms.strength.value = streak;
    },
    setLampOn(i, on) {
      if (i < 0 || i >= lamps.length) return;
      const p = lamps[i];
      if (on) m.makeScale(POOL_SIZE, 1, POOL_SIZE).setPosition(p.x, heightAt(p.x, p.z) + 0.2, p.z);
      else m.makeScale(0, 0, 0);
      pools.setMatrixAt(i, m);
      pools.instanceMatrix.needsUpdate = true;
      const c = all[i].color;
      const k = on ? 1 : 0;
      iColor.set([c.r * k, c.g * k, c.b * k], i * 3);
      (geo.getAttribute('iColor') as THREE.InstancedBufferAttribute).needsUpdate = true;
    },
    dispose() {
      glow.dispose();
      poolGeo.dispose();
      poolMat.dispose();
      base.dispose();
      geo.dispose();
      streakMat.dispose();
    },
  };
}
