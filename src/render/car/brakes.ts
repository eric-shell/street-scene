/**
 * Brake units behind the wheels: a drilled rotor that spins with the wheel and a caliper that
 * steers and cambers with it but stays put (the car view parents them to the spin and hub
 * groups). Both are built in wheel space (center at the origin, axle along X, +X outboard) at a
 * reference bead radius and scaled to the axle's real bead, so a wheel size change only rescales
 * them, and placed along the axle behind the wheel's spokes, whose depth the car view measures
 * per axle (wheels differ in offset, and the front and rear may wear different wheels). The hat's
 * outboard face is at x = 0, so a mesh at the spoke back's x, less a clearance, clears the spokes.
 * The rotor face is a small byte texture (brushed steel, the drilled holes in swept columns, the
 * hat and its lug nuts) used as color and bump map, so the holes cost no triangles. The
 * columns sweep with the wheel's forward spin (the outer hole leads); the right side's rotors
 * are mirrored by the car view's negative x scale, so they are the opposite hand, as real ones are. The wheel GLBs'
 * barrels are open at the back (carWheels.py strips the packs' own brakes), so the rotor shows
 * through the spokes.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const BRAKE = {
  /** Bead radius the geometry is built at (m); the car view scales the meshes by bead / refBead. */
  refBead: 0.23,
  /** Rotor radius per axle as a fraction of the bead radius: a big front kit, the rears run smaller. */
  rotor: [0.7, 0.62],
  /** Rotor thickness (m, at the reference bead). */
  thickness: 0.028,
  /** Hat (bell) radius as a fraction of the rotor's, and how far it stands outboard of the disc face (m). */
  hat: 0.55,
  hatDepth: 0.02,
  /** Air between the hat's face and the back of the spokes (m). */
  clearance: 0.012,
  /** Caliper: ring radius as a fraction of the rotor's and body width along the axle (× tube). */
  caliperRadius: 0.84,
  caliperWidth: 1.8,
  /** Caliper body per axle: tube radius (m) and the arc of the rotor it clamps (rad). The fronts do most of the stopping and wear the bigger calipers. */
  caliperTube: [0.038, 0.034],
  caliperArc: [1.75, 1.2],
  /** Where each axle's caliper sits: on the leading (car's front) or trailing side of the hub, and how far above the hub's height (rad). */
  caliperAt: [{ leading: false, up: 0.45 }, { leading: true, up: 0.45 }],
  /** Drilled holes: columns around the friction ring, holes per column, their radius (texture units, the face is radius 1) and how far a column sweeps (rad). */
  columns: 12,
  perColumn: 3,
  hole: 0.02,
  sweep: 0.22,
  /** Rotor glow at full heat (emissive intensity). */
  glow: 0.45,
  /**
   * How fast the rotors heat while braking and cool once off the brakes (1/s): a few seconds of hard
   * braking before a visible glow, a long fade back to bare steel. The glow follows the square of the
   * heat, so a tap of the brakes barely warms them.
   */
  heatUp: 0.3,
  coolDown: 0.06,
} as const;

/** Texture size (px) and the plain point of the friction ring that the rotor's edge and the hat's sides sample. */
const TEX = 128;
const PLAIN_UV: [number, number] = [0.88, 0.5];

/**
 * Rotor face in texture space: the cap of a cylinder maps its radius to half the unit square.
 * Value 1 is bare steel; the holes and the hat go dark, the lug nuts bright. The same bytes are
 * the bump map, so the holes read as dents under the street lights.
 */
export function rotorTexture(): THREE.DataTexture {
  const n = TEX;
  const data = new Uint8Array(n * n * 4);
  const value = (u: number, v: number): number => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.hypot(dx, dy) * 2;
    const a = Math.atan2(dy, dx);
    if (r < BRAKE.hat) {
      // The hat: flat and darker, five lug nuts on a ring.
      let lug = 0;
      for (let i = 0; i < 5; i++) {
        const t = (i / 5) * Math.PI * 2;
        const d = Math.hypot(dx - 0.14 * Math.cos(t), dy - 0.14 * Math.sin(t)) * 2;
        lug = Math.max(lug, 1 - Math.min(1, Math.max(0, (d - 0.03) / 0.015)));
      }
      return 0.55 + 0.4 * lug;
    }
    // Brushed friction ring: fine concentric grooves, then the drilled holes. Each column's holes step
    // outward from the hat and forward in spin (a growing texture angle is the forward turn on the face
    // seen through the spokes), so the nearest column is found through the sweep at this radius.
    let s = 0.86 + 0.06 * Math.sin(r * 260);
    const step = (Math.PI * 2) / BRAKE.columns;
    const inner = BRAKE.hat + 0.09;
    const outer = 0.92;
    const col = Math.round((a - (BRAKE.sweep * (r - inner)) / (outer - inner)) / step);
    for (let i = 0; i < BRAKE.perColumn; i++) {
      const rr = inner + ((outer - inner) * i) / (BRAKE.perColumn - 1);
      const ha = col * step + (BRAKE.sweep * (rr - inner)) / (outer - inner);
      const hole = Math.hypot(dx - (rr / 2) * Math.cos(ha), dy - (rr / 2) * Math.sin(ha)) * 2;
      s = Math.min(s, 0.12 + 0.88 * Math.min(1, Math.max(0, (hole - BRAKE.hole) / 0.01)));
    }
    return s;
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = Math.round(255 * value((i + 0.5) / n, (j + 0.5) / n));
      data.set([c, c, c, 255], (j * n + i) * 4);
    }
  }
  const tex = new THREE.DataTexture(data, n, n);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Point every vertex's UV at one texel. */
function pinUv(geo: THREE.BufferGeometry, from: number, to: number, [u, v]: [number, number]): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = from; i < Math.min(to, uv.count); i++) uv.setXY(i, u, v);
}

/** Shrink the cap UVs about the center so a smaller cylinder samples only the matching part of the face. */
function scaleCapUv(geo: THREE.BufferGeometry, from: number, k: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = from; i < uv.count; i++) uv.setXY(i, 0.5 + (uv.getX(i) - 0.5) * k, 0.5 + (uv.getY(i) - 0.5) * k);
}

/** From the disc's center plane to the hat's outboard face (m). */
function hatHeight(): number {
  return BRAKE.thickness / 2 + BRAKE.hatDepth;
}

/** One axle's rotor (disc plus hat) at the reference bead, as one geometry for one draw. */
export function buildRotorGeometry(axle: 0 | 1): THREE.BufferGeometry {
  const R = BRAKE.refBead * BRAKE.rotor[axle];
  const seg = 40;
  const disc = new THREE.CylinderGeometry(R, R, BRAKE.thickness, seg, 1);
  // The torso's vertices come first in a CylinderGeometry; their side UVs would smear the face across the edge.
  pinUv(disc, 0, (seg + 1) * 2, PLAIN_UV);
  disc.rotateZ(Math.PI / 2);
  disc.translate(-hatHeight(), 0, 0);
  const hatH = hatHeight();
  const hat = new THREE.CylinderGeometry(R * BRAKE.hat, R * BRAKE.hat, hatH, 24, 1);
  pinUv(hat, 0, 25 * 2, PLAIN_UV);
  scaleCapUv(hat, 25 * 2, BRAKE.hat);
  hat.rotateZ(-Math.PI / 2);
  hat.translate(-hatH / 2, 0, 0);
  const geo = mergeGeometries([disc, hat]);
  disc.dispose();
  hat.dispose();
  geo.clearGroups();
  return geo;
}

/** One caliper at the reference bead: a thick arc clamped over the rotor's edge where BRAKE.caliperAt puts it. */
export function buildCaliperGeometry(axle: 0 | 1): THREE.BufferGeometry {
  const R = BRAKE.refBead * BRAKE.rotor[axle];
  const arc = BRAKE.caliperArc[axle];
  const at = BRAKE.caliperAt[axle];
  const geo = new THREE.TorusGeometry(R * BRAKE.caliperRadius, BRAKE.caliperTube[axle], 6, 12, arc);
  // Torus axis Z → X; its arc then starts straight behind the hub and climbs, so center it on the height asked for.
  geo.rotateY(Math.PI / 2);
  geo.rotateX(at.up - arc / 2);
  if (at.leading) geo.rotateY(Math.PI);
  geo.scale(BRAKE.caliperWidth, 1, 1);
  geo.translate(-hatHeight(), 0, 0);
  return geo;
}
