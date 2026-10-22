/**
 * Shader tweaks that builders across the render folders share: emitters that fade instead of popping as
 * they shrink below a pixel (fadeSubPixel), and additive light washed on the road that fades to nothing in
 * fog rather than toward the fog color (washMaterial).
 */
import * as THREE from 'three';

/**
 * Small, very bright emitters (lamp lenses, roof neon, barrier lamps) shrink
 * below a pixel in the distance. Without AA they are drawn on one frame and
 * missed the next, and at 3-4x HDR each pop is a bright speck the bloom
 * picks up. Scale their brightness by how many pixels they cover,
 * estimated from the screen space derivatives of the view position, so they
 * fade smoothly instead. `size` is the emitter's smallest dimension in meters;
 * brightness never drops below `floor`. Works for Basic materials, instanced
 * or not, and adapts to the render resolution by itself.
 */
export function fadeSubPixel(material: THREE.Material, size: number, floor = 0.2): void {
  const s = size.toFixed(3);
  const f = floor.toFixed(3);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSubPixelPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvSubPixelPos = mvPosition.xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSubPixelPos;')
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        {
          // world size of one pixel here; full brightness from about 2 px up
          float pxWorld = max(length(fwidth(vSubPixelPos)), 1e-5);
          gl_FragColor.rgb *= clamp(${s} / (2.0 * pxWorld), ${f}, 1.0);
        }`,
      );
  };
  // The injected constants differ per call, so they must be part of the program key.
  material.customProgramCacheKey = () => `subpx:${s}:${f}`;
  material.needsUpdate = true;
}

/** Additive light on the road (vertex colors), fading to nothing in fog rather than toward the fog color. */
export function washMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
        #ifdef FOG_EXP2
          float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
        #else
          float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
        #endif
        gl_FragColor.rgb *= 1.0 - fogFactor;
      #endif`,
    );
  };
  m.customProgramCacheKey = () => 'structureWash';
  return m;
}
