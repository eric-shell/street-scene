/**
 * The material of the podium walls (facadeKit.ts atlas bays, cityMeshes 'podiums'), and on Medium and High the
 * interior mapping of the shop bays' glass: a room behind the window with no extra geometry.
 *
 * For a glass pixel of a bay with a room (the glass mask says where, the `aRoom` attribute which room), the
 * view ray is taken into the bay's own frame (along the facade, up, into the wall), intersected with the box
 * behind the window plane (ROOM in interiorAtlas.ts: the bay's width, floor to ceiling, 5 m deep), and the
 * face it leaves through is read from the interior atlas, so the shelves, counters and lights move with
 * parallax as the camera passes. The room replaces the flat lit-glass glow of the bay's emissive atlas; a Fresnel
 * term fades it out toward grazing angles, where the glass (a lower roughness on the mask) mirrors the street
 * instead. The bay's light roll closes some shops (dark, a few with a night light) and varies the rest.
 *
 * Cost: one vertex attribute (4 floats), two varyings, and on glass pixels inside the fade range (90-160 m) one
 * mask lookup, one array texture lookup and about 60 ALU ops (a ray-box slab test, a face pick, the light roll);
 * pixels of walls and of rooms out of range pay only the flat branch. Nothing per frame on the CPU: no uniform
 * changes after the build. Low builds the plain material, with no attribute and no code.
 *
 * Broken glass (street/glassBreak.ts): a second attribute `aBay` names the glass bay of a quad, and a one-texel-per-bay
 * state texture holds 0 for an intact bay or a seed once a car has hit it. A broken bay's glass pixels lose the
 * glass reflection (the wall's roughness), show a crack web from a small texture at a seeded spot, miss some panes
 * (a much darker room) and leave a jagged edge of hanging shards along the top. One extra texel fetch per glass
 * pixel; the crack lookup and the pane hash only run for broken bays.
 */
import * as THREE from 'three';
import { BAY_ATLAS } from './facadeKit';
import type { FacadeKitTextures } from './facadeKit';
import { ROOM, ROOM_FACES, ROOM_LIGHT } from './interiorAtlas';
import type { GlassBays } from '../street/glassBreak';

/** Distances (m) over which the rooms fade into the bay's flat glow: full inside the first, gone past the second. */
const ROOM_FADE = [90, 160] as const;
/** Radiance of a lit room against the flat glow it replaces. */
const ROOM_GAIN = 1.1;
/** Glass roughness where a room shows (the walls are 0.6): glossy enough to mirror the street at grazing angles, not a sharp mirror of the night's small lights. */
const GLASS_ROUGHNESS = 0.36;

/** The room textures of a tier: the interior atlas (interiorAtlas.ts) and its face size in pixels. */
export interface PodiumRooms {
  atlas: THREE.DataArrayTexture;
  /** Face size in pixels (picks the mip level of the lookup). */
  px: number;
}

const f = (v: number) => v.toFixed(4);

export function createPodiumMaterial(kit: FacadeKitTextures, rooms: PodiumRooms | null, glass: GlassBays | null = null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ map: kit.map, emissiveMap: kit.emissive, emissive: 0xffffff, emissiveIntensity: 1.05, vertexColors: true, roughness: 0.6, metalness: 0.05, envMapIntensity: 0.7 });
  if (!rooms || !kit.glass) return mat;
  const uniforms = { uRoom: { value: rooms.atlas }, uGlassMask: { value: kit.glass }, uRoomPx: { value: rooms.px }, uBroken: { value: glass?.stateTex ?? null }, uCrack: { value: glass?.crackTex ?? null }, uBrokenW: { value: glass ? glass.stateTex.image.width : 1 } };
  const L = ROOM_LIGHT;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aRoom;
        attribute float aBay;
        flat varying float vBay;
        flat varying vec4 vRoom;
        varying vec3 vRoomPos;
        flat varying vec3 vRoomN;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vRoom = aRoom;
        vBay = aBay;
        vRoomPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vRoomN = mat3(modelMatrix) * normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform highp sampler2DArray uRoom;
        uniform sampler2D uGlassMask;
        uniform float uRoomPx;
        uniform sampler2D uBroken;
        uniform sampler2D uCrack;
        uniform float uBrokenW;
        flat varying float vBay;
        // vRoom: bay variant (-1: no room), room + light roll, width (m, signed by the u axis' handedness), height (m).
        flat varying vec4 vRoom;
        varying vec3 vRoomPos;
        flat varying vec3 vRoomN;`,
      )
      // The glass mask: only pixels of a bay with a room, inside the fade range, look it up.
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float roomMask = 0.0;
        vec3 roomRay = vRoomPos - cameraPosition;
        float roomDist = length(roomRay);
        // Derivatives are taken before any branch so the lookups below stay defined at the edge of a quad.
        vec2 roomDx = dFdx(vMapUv);
        vec2 roomDy = dFdy(vMapUv);
        float roomMpp = max(length(dFdx(vRoomPos)), length(dFdy(vRoomPos)));
        if (vRoom.x >= 0.0 && roomDist < ${f(ROOM_FADE[1])}) {
          roomMask = textureGrad(uGlassMask, vMapUv, roomDx, roomDy).r * (1.0 - smoothstep(${f(ROOM_FADE[0])}, ${f(ROOM_FADE[1])}, roomDist));
        }
        // Break seed of this bay (0 intact), read only where there is glass to draw.
        float brokenSeed = 0.0;
        if (roomMask > 0.002 && vBay >= 0.0) brokenSeed = floor(texelFetch(uBroken, ivec2(int(mod(vBay, uBrokenW)), int(vBay / uBrokenW)), 0).r * 255.0 + 0.5);`,
      )
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = mix(roughness, ${f(GLASS_ROUGHNESS)}, roomMask * (brokenSeed > 0.5 ? 0.0 : 1.0));`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (roomMask > 0.002) {
          vec3 nW = normalize(vRoomN);
          vec3 tW = vec3(nW.z, 0.0, -nW.x) * (vRoom.z < 0.0 ? -1.0 : 1.0);
          vec3 dirW = roomRay / roomDist;
          float ndv = -dot(dirW, nW);
          if (ndv > 0.02) {
            // Where on the bay's cell this pixel is (the atlas layout, facadeKit.ts), in metres along and up the window.
            float variant = vRoom.x;
            float colI = mod(variant, ${f(BAY_ATLAS.cols)});
            float rowI = variant >= ${f(BAY_ATLAS.cols)} ? 2.0 : 0.0;
            float cu = clamp(vMapUv.x * ${f(BAY_ATLAS.cols)} - colI, 0.0, 1.0);
            float v0 = 1.0 - (rowI * ${f(BAY_ATLAS.cell)} + ${f(BAY_ATLAS.groundPx)}) / ${f(BAY_ATLAS.height)};
            float cv = clamp((vMapUv.y - v0) * ${f(BAY_ATLAS.height / BAY_ATLAS.groundPx)}, 0.0, 1.0);
            float bw = abs(vRoom.z);
            float yf = ${f(ROOM.floor)} * vRoom.w;
            float yc = ${f(ROOM.ceiling)} * vRoom.w;
            vec3 o = vec3(cu * bw, clamp(cv * vRoom.w, yf + 0.01, yc - 0.01), 0.0);
            // The ray in the bay's frame: along u, up, into the room.
            vec3 d = vec3(dot(dirW, tW), dirW.y, ndv);
            d = mix(d, vec3(1e-4), lessThan(abs(d), vec3(1e-4)));
            // Slab test against the far planes of the box (the window plane is the near one).
            vec3 lim = vec3(d.x > 0.0 ? bw : 0.0, d.y > 0.0 ? yc : yf, ${f(ROOM.d)});
            vec3 t3 = (lim - o) / d;
            float t = min(t3.x, min(t3.y, t3.z));
            vec3 hit = o + d * t;
            float face;
            vec2 fuv;
            if (t == t3.z) { face = 0.0; fuv = vec2(hit.x / bw, (hit.y - yf) / (yc - yf)); }
            else if (t == t3.x) { face = d.x > 0.0 ? 2.0 : 1.0; fuv = vec2(hit.z / ${f(ROOM.d)}, (hit.y - yf) / (yc - yf)); }
            else { face = d.y > 0.0 ? 4.0 : 3.0; fuv = vec2(hit.x / bw, hit.z / ${f(ROOM.d)}); }
            // The face is read at the mip its texels per pixel call for (a derivative of the seam would pick the smallest).
            float lod = max(0.0, log2(max(roomMpp * uRoomPx / ${f(ROOM.w)} * 1.5, 1e-3)));
            float roomIdx = floor(vRoom.y);
            vec3 inside = textureLod(uRoom, vec3(fuv, roomIdx * ${f(ROOM_FACES.length)} + face), lod).rgb;
            // The bay's lights: closed (a few leave a night light on), the rest open at their own brightness.
            float roll = vRoom.y - roomIdx;
            float lightK = roll < ${f(L.closed)}
              ? (roll < ${f(L.nightLight)} ? ${f(L.nightGain)} : ${f(L.closedGain)})
              : mix(${f(L.openGain[0])}, ${f(L.openGain[1])}, (roll - ${f(L.closed)}) / ${f(1 - L.closed)});
            // Glass reflects more the shallower the angle: the room gives way to the street's mirror.
            float fres = pow(1.0 - ndv, 5.0);
            vec3 lit = inside * lightK * (1.0 - 0.9 * fres) * ${f(ROOM_GAIN)};
            if (brokenSeed > 0.5) {
              // The bay's glass is gone in places and cracked in the rest, with no reflection (the roughness above).
              float h = vRoom.w;
              vec2 m = vec2(cu * bw, cv * h);
              vec2 hit1 = vec2(bw * (0.28 + 0.44 * fract(brokenSeed * 0.618)), h * (0.34 + 0.32 * fract(brokenSeed * 0.377)));
              vec2 hit2 = vec2(bw * fract(brokenSeed * 0.2171 + 0.15), h * (0.2 + 0.6 * fract(brokenSeed * 0.7131)));
              float crackLod = max(0.0, log2(max(roomMpp * 128.0 / 2.6, 1e-3)));
              float web = textureLod(uCrack, (m - hit1) / 2.6 + 0.5, crackLod).r;
              web = max(web, 0.75 * textureLod(uCrack, (m - hit2) / 1.5 + 0.5, crackLod).r);
              // Panes of about 0.6 by 0.8 m: the nearer the impact, the likelier one is gone.
              vec2 pc = floor(m / vec2(0.62, 0.8));
              float ph = fract(sin(dot(pc + brokenSeed, vec2(12.9898, 78.233))) * 43758.5453);
              float gone = step(ph, 0.5 - 0.32 * clamp(length(m - hit1) / 2.2, 0.0, 1.0));
              // The top row keeps a jagged edge of shards hanging from the frame where its panes are gone.
              float down = h - m.y;
              float tooth = abs(fract(m.x * 2.7 + brokenSeed * 0.13) - 0.5) * 2.0;
              float hang = step(down, 0.5 * (1.0 - tooth) + 0.05) * step(down, 0.8);
              gone *= 1.0 - hang;
              lit = mix(lit * (1.0 - 0.25 * web), lit * 0.06, gone);
              lit += vec3(0.5, 0.62, 0.78) * web * (1.0 - gone) * (0.22 + 0.16 * lightK);
            }
            totalEmissiveRadiance = mix(totalEmissiveRadiance, lit, roomMask);
          }
        }`,
      );
  };
  mat.customProgramCacheKey = () => (glass ? 'podium:rooms:glass' : 'podium:rooms');
  return mat;
}
