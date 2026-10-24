/**
 * The garage room's materials: every one the merged meshes use (the
 * textured wall, deck and door, painted and galvanized steel, rubber, the
 * shop's red, blue, yellow and orange), the glow colors pushed past 1 so the
 * bloom catches the tubes and work lamps, and the nameplate and banner tables
 * the badge and banner atlases are built from (the props that hang them pick a
 * row). One set shared by every prop, so each material ends up as exactly one
 * merged mesh. Render only.
 */
import * as THREE from 'three';
import { PALETTE } from '../../ui/kit/palette';
import type { Disposable } from '../../render/disposer';
import { badgeTexture, bannerTexture, bayNumbersTexture, beerSignTexture, calendarTexture, clockTexture, deckTexture, doorTexture, drawerTexture, exitTexture, glowTexture, lineTexture, partsBoxTexture, pegboardTexture, platesTexture, posterTexture, stainTexture, washTexture, whiteboardTexture, workOrderTexture } from '../showroomTextures';

/** Fluorescent tube glow, pushed past 1 so the bloom catches it, and the warm work lamps. */
export const GLOW = {
  tube: new THREE.Color(0xe9f0ff).multiplyScalar(2.6),
  lamp: new THREE.Color(0xffc98a).multiplyScalar(2.4),
  screen: new THREE.Color(PALETTE.cyan).multiplyScalar(0.9),
} as const;

/** The flagship cabs' nameplates, in the badge atlas's row order: series name, line, the accent they are lit in. */
export const BADGES = [
  { name: 'STREET SCENE', line: 'PRO SERIES  ·  CUSTOM GARAGE', color: PALETTE.cyan },
  { name: 'STREET SCENE', line: 'NIGHT SHIFT  ·  FABRICATION', color: PALETTE.purple },
  { name: 'STREET SCENE', line: 'RACE DEPT  ·  TUNING', color: PALETTE.pink },
  { name: 'STREET SCENE', line: 'DRIFT LAB  ·  SUSPENSION', color: PALETTE.green },
] as const;

/** The tuners' banners hung from the trusses, in bannerTexture's row order. */
export const BANNERS = [
  { name: 'KUROGANE', line: 'AERO WORKS  ·  WIDE BODY', color: PALETTE.orange },
  { name: 'HAYATE', line: 'NIGHT SERIES  ·  COILOVERS', color: PALETTE.cyan },
  { name: 'KIBA', line: 'FORGED WHEELS  ·  SINCE 98', color: PALETTE.yellow },
] as const;

/** Every material the room's merged meshes use. Textured ones carry their maps. */
export function createMaterials(track: <T extends Disposable>(x: T) => T, wallMap: THREE.Texture) {
  const std = (p: THREE.MeshStandardMaterialParameters) => track(new THREE.MeshStandardMaterial(p));
  const basic = (color: THREE.Color) => track(new THREE.MeshBasicMaterial({ color }));
  const decal = (map: THREE.Texture, order: number, opacity = 1) => {
    const m = std({ map: track(map), transparent: true, opacity, depthWrite: false, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    m.userData.renderOrder = order;
    return m;
  };
  const glowMap = track(glowTexture());
  const pool = (color: string, k = 0.55) => {
    const l = track(new THREE.MeshBasicMaterial({ map: glowMap, color: new THREE.Color(color).multiplyScalar(k), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    l.userData.renderOrder = 3;
    return l;
  };
  const deck = track(deckTexture());
  deck.repeat.set(12, 12);
  return {
    wall: std({ map: wallMap, roughness: 0.92 }),
    deck: std({ map: deck, roughness: 0.7, metalness: 0.4 }),
    door: std({ map: track(doorTexture()), roughness: 0.5, metalness: 0.5 }),
    steel: std({ color: 0x26272b, roughness: 0.5, metalness: 0.6 }),
    galv: std({ color: 0x74777d, roughness: 0.45, metalness: 0.7 }),
    rust: std({ color: 0x4e2f1d, roughness: 0.9, metalness: 0.2 }),
    lift: std({ color: 0x1f3f63, roughness: 0.45, metalness: 0.3 }),
    red: std({ color: 0x9a1b25, roughness: 0.35, metalness: 0.25 }),
    black: std({ color: 0x18181b, roughness: 0.4, metalness: 0.3 }),
    blue: std({ color: 0x1d4f9a, roughness: 0.4, metalness: 0.25 }),
    yellow: std({ color: 0xbf9420, roughness: 0.5, metalness: 0.2 }),
    orange: std({ color: 0xc8541c, roughness: 0.55 }),
    rubber: std({ color: 0x101012, roughness: 0.9 }),
    chrome: std({ color: 0xb8bcc6, roughness: 0.2, metalness: 0.95 }),
    cast: std({ color: 0x45474c, roughness: 0.65, metalness: 0.55 }),
    primer: std({ color: 0x6b6d70, roughness: 0.85 }),
    carbon: std({ color: 0x0d0e10, roughness: 0.22, metalness: 0.3 }),
    panel: std({ color: 0xd2501f, roughness: 0.25, metalness: 0.2 }),
    cardboard: std({ color: 0x7a5d3f, roughness: 0.95 }),
    wood: std({ color: 0x3e3127, roughness: 0.85 }),
    stainless: std({ color: 0xa9adb3, roughness: 0.32, metalness: 0.85 }),
    gunmetal: std({ color: 0x3a3d44, roughness: 0.38, metalness: 0.45 }),
    /** Appliance white: the fridge, gauge faces. */
    enamel: std({ color: 0xd9d7d0, roughness: 0.4, metalness: 0.1 }),
    tubeOff: std({ color: 0x8d9096, roughness: 0.3 }),
    tube: basic(GLOW.tube.clone()),
    /** The dying batten's tubes: its own material so it can stutter. */
    tubeFlicker: basic(GLOW.tube.clone()),
    lamp: basic(GLOW.lamp.clone()),
    screen: basic(GLOW.screen.clone()),
    pegboard: std({ map: track(pegboardTexture()), roughness: 0.8 }),
    drawersRed: std({ map: track(drawerTexture('#9a1b25')), roughness: 0.35, metalness: 0.25 }),
    drawersBlack: std({ map: track(drawerTexture('#1d1d21')), roughness: 0.4, metalness: 0.3 }),
    drawersBlue: std({ map: track(drawerTexture('#1d4f9a')), roughness: 0.4, metalness: 0.25 }),
    drawersGunmetal: std({ map: track(drawerTexture('#3a3d44')), roughness: 0.38, metalness: 0.45 }),
    /** The flagship cab's deep candy red, glossier than the shop's other paint. */
    candy: std({ color: 0xa80d1a, roughness: 0.16, metalness: 0.6 }),
    drawersCandy: std({ map: track(drawerTexture('#a80d1a')), roughness: 0.16, metalness: 0.6 }),
    candyOrange: std({ color: 0xc4480e, roughness: 0.16, metalness: 0.6 }),
    drawersCandyOrange: std({ map: track(drawerTexture('#c4480e')), roughness: 0.16, metalness: 0.6 }),
    candyBlue: std({ color: 0x0d3fa8, roughness: 0.16, metalness: 0.6 }),
    drawersCandyBlue: std({ map: track(drawerTexture('#0d3fa8')), roughness: 0.16, metalness: 0.6 }),
    /** The flagship cabs' accent lights: the underglow strips and the seams between each cab and its lockers. */
    accentCyan: basic(new THREE.Color(PALETTE.cyan).multiplyScalar(2.2)),
    accentPurple: basic(new THREE.Color(PALETTE.purple).multiplyScalar(2.2)),
    accentPink: basic(new THREE.Color(PALETTE.pink).multiplyScalar(2.2)),
    accentGreen: basic(new THREE.Color(PALETTE.green).multiplyScalar(2.2)),
    badge: track(new THREE.MeshBasicMaterial({ map: track(badgeTexture(BADGES)), color: new THREE.Color(1.6, 1.6, 1.6) })),
    poster0: std({ map: track(posterTexture('KUROGANE', 'AERO WORKS', PALETTE.orange, 0)), roughness: 0.8, transparent: true }),
    poster1: std({ map: track(posterTexture('HAYATE', 'NIGHT SERIES', PALETTE.cyan, 1)), roughness: 0.8, transparent: true }),
    poster2: std({ map: track(posterTexture('KIBA', 'FORGED WHEELS', PALETTE.yellow, 2)), roughness: 0.8, transparent: true }),
    whiteboard: std({ map: track(whiteboardTexture()), roughness: 0.3 }),
    workOrder: std({ map: track(workOrderTexture()), roughness: 0.9 }),
    boxKurogane: std({ map: track(partsBoxTexture('KUROGANE', 'AERO WORKS', PALETTE.orange)), roughness: 0.95 }),
    boxHayate: std({ map: track(partsBoxTexture('HAYATE', 'NIGHT SERIES', PALETTE.cyan)), roughness: 0.95 }),
    boxKiba: std({ map: track(partsBoxTexture('KIBA', 'FORGED WHEELS', PALETTE.yellow)), roughness: 0.95 }),
    /** The beer sign over the fridge: additive, so only its lines show, pushed past the bloom. */
    beerSign: track(new THREE.MeshBasicMaterial({ map: track(beerSignTexture()), color: new THREE.Color(0xff5a3c).multiplyScalar(2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })),
    line: decal(lineTexture(), 1, 0.85),
    stain: decal(stainTexture(), 2, 0.6),
    /** Sodium street light leaking under the roller door: additive, so it only ever brightens the floor. */
    leak: (() => {
      const l = track(new THREE.MeshBasicMaterial({ map: track(glowTexture()), color: new THREE.Color(0xffa040).multiplyScalar(0.9), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      l.userData.renderOrder = 3;
      return l;
    })(),
    leakEdge: basic(new THREE.Color(0xffb050).multiplyScalar(1.6)),
    /** Each underglow's pool on the floor in front of its cab: additive, like the door's leak. */
    glowCyan: pool(PALETTE.cyan, 0.22),
    glowPurple: pool(PALETTE.purple, 0.22),
    /** Faked light, no lighting cost: the pools under the battens, the exit signs' green, the heater's warmth. */
    poolTube: pool('#dfe8ff', 0.16),
    poolExit: pool('#3cff7a', 0.14),
    poolHeater: pool('#ff7a2a', 0.6),
    /** Light washing down the wall or a hutch's back under an LED strip. */
    wash: (() => {
      const l = track(new THREE.MeshBasicMaterial({ map: track(washTexture()), color: new THREE.Color(0xe8f0ff).multiplyScalar(0.32), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      l.userData.renderOrder = 3;
      return l;
    })(),
    exit: track(new THREE.MeshBasicMaterial({ map: track(exitTexture()), color: new THREE.Color(1.6, 1.6, 1.6) })),
    heaterCoil: basic(new THREE.Color(0xff6a20).multiplyScalar(2.4)),
    /** The beer cooler's lit interior and its glass door. */
    coolerLight: basic(new THREE.Color(0xdfefff).multiplyScalar(0.95)),
    glass: std({ color: 0x9fb4c8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.2, depthWrite: false }),
    bayNumbers: decal(bayNumbersTexture(), 1, 0.8),
    banner: std({ map: track(bannerTexture(BANNERS)), roughness: 0.9 }),
    plates: std({ map: track(platesTexture()), roughness: 0.6, metalness: 0.3 }),
    clock: std({ map: track(clockTexture()), roughness: 0.4 }),
    calendar: std({ map: track(calendarTexture()), roughness: 0.9 }),
    glowPink: pool(PALETTE.pink, 0.22),
    glowGreen: pool(PALETTE.green, 0.22),
  };
}
export type Mats = ReturnType<typeof createMaterials>;
