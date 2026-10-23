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
 * The caliper is a monoblock in the manner of a Brembo GT: a body swept along the rotor's edge,
 * its section a rounded block (soft outboard shoulders, tighter inboard edges) whose ends round
 * off like the real castings, with a raised logo plate in the middle of the outboard face. It
 * stands a little past the rotor's edge and reaches in over the pads, clear of the hat.
 * The plate carries the house brake brand: its face is UV mapped along the arc onto a small mask
 * (caliperLogoTexture) that the caliper material blends to white over the paint, so the letters cost
 * no triangles or draws. They read clockwise with their tops outward, as on real calipers; the right
 * side's mirrored meshes take a mirrored mapping, so the logo reads true on both sides.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { drawTexture, fitFont } from '../textures/canvasKit';

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
  /**
   * Caliper body per axle (m, at the reference bead; the fronts do most of the stopping and wear the bigger,
   * six piston calipers): how far it stands past the rotor's edge, how far it reaches in from it over the
   * pads, and how deep each half is from its rotor face to its own face (the piston housings).
   */
  caliperOver: [0.018, 0.015],
  caliperReach: [0.066, 0.056],
  caliperHousing: [0.05, 0.043],
  /** The arc the caliper spans, rounded ends included (rad). */
  caliperArc: [1.45, 1.2],
  /** Edge radii of the body's section (m): the soft outboard shoulders, the tighter inboard edges. */
  caliperRound: [0.013, 0.006],
  /** The logo plate on the outboard face: share of the body's arc and height it covers, and how far it stands proud (m). */
  caliperPlate: { arc: 0.56, height: 0.5, rise: 0.0025 },
  /** The logo on the plate: the house brake brand (a fictional tuner name, never a real maker's) and its ink (linear grey, 1 = white). */
  caliperLogo: { text: 'RAIJIN', ink: 0.86 },
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

/** A body swept along an arc about the axle: its section's radial and axial extents (m) and its corner radii. */
interface Sweep {
  rIn: number;
  rOut: number;
  xIn: number;
  xOut: number;
  /** Arc it spans (rad), centered on angle 0 (straight behind the hub). */
  arc: number;
  /** Corner radii of the section (m): the outboard (+X) edges and the inboard ones. */
  round: [number, number];
  /** UV per vertex from its arc angle (rad) and radius (m); without it every vertex samples (0, 0). */
  uv?: (phi: number, r: number) => [number, number];
}

/**
 * Sweep a rounded block section along an arc. Toward each end the section shrinks radially along a
 * quarter circle as long as half its height, so the body ends in a half round seen from outboard (and
 * slims a little along the axle, as a casting's ends do); the last section is flat, which closes it.
 * Samples crowd toward the ends where the outline turns. Angle 0 points straight behind the hub (-Z),
 * angles climb toward +Y, as rotateX turns them.
 */
function sweptBody(s: Sweep, segs: number): THREE.BufferGeometry {
  const rm = (s.rIn + s.rOut) / 2;
  const hr = (s.rOut - s.rIn) / 2;
  const xm = (s.xIn + s.xOut) / 2;
  const hx = (s.xOut - s.xIn) / 2;
  // The section in (x, r) about its center, counterclockwise, three points to a corner.
  const prof: [number, number][] = [];
  const corner = (cx: number, cr: number, rad: number, a0: number) => {
    for (let k = 0; k < 3; k++) prof.push([cx + rad * Math.cos(a0 + (k * Math.PI) / 4), cr + rad * Math.sin(a0 + (k * Math.PI) / 4)]);
  };
  const [ro, ri] = s.round;
  corner(hx - ro, hr - ro, ro, 0);
  corner(-hx + ri, hr - ri, ri, Math.PI / 2);
  corner(-hx + ri, -hr + ri, ri, Math.PI);
  corner(hx - ro, -hr + ro, ro, Math.PI * 1.5);
  const half = s.arc / 2;
  const endArc = Math.min(half, hr / rm);
  const pos: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const u = (i / segs) * 2 - 1;
    const phi = half * Math.sin((u * Math.PI) / 2);
    const d = Math.max(0, Math.abs(phi) - (half - endArc)) / endArc;
    const f = Math.sqrt(Math.max(0, 1 - d * d));
    const g = 0.6 + 0.4 * f;
    for (const [px, pr] of prof) {
      const r = rm + pr * f;
      pos.push(xm + px * g, r * Math.sin(phi), -r * Math.cos(phi));
      uv.push(...(s.uv?.(phi, r) ?? [0, 0]));
    }
  }
  const n = prof.length;
  const index: number[] = [];
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j;
      const b = i * n + ((j + 1) % n);
      const c = a + n;
      const e = b + n;
      index.push(a, b, c, b, e, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/**
 * One caliper at the reference bead: the swept body and its logo plate, on the rotor's edge where
 * BRAKE.caliperAt puts it. `mirrored`: for the right side's meshes, which the car view mirrors (negative
 * x scale); their logo mapping is mirrored back so it reads true.
 */
export function buildCaliperGeometry(axle: 0 | 1, mirrored = false): THREE.BufferGeometry {
  const R = BRAKE.refBead * BRAKE.rotor[axle];
  const arc = BRAKE.caliperArc[axle];
  const at = BRAKE.caliperAt[axle];
  const face = BRAKE.thickness / 2 + BRAKE.caliperHousing[axle];
  const body: Sweep = { rIn: R - BRAKE.caliperReach[axle], rOut: R + BRAKE.caliperOver[axle], xIn: -face, xOut: face, arc, round: [...BRAKE.caliperRound] };
  const P = BRAKE.caliperPlate;
  const mid = (body.rIn + body.rOut) / 2;
  const h = ((body.rOut - body.rIn) * P.height) / 2;
  const plateArc = arc * P.arc;
  // Increasing angle runs counterclockwise seen from outboard: the logo reads the other way, tops outward.
  const dir = mirrored ? 1 : -1;
  const plate: Sweep = {
    rIn: mid - h,
    rOut: mid + h,
    xIn: face - 0.004,
    xOut: face + P.rise,
    arc: plateArc,
    round: [0.002, 0.002],
    uv: (phi, r) => [0.5 + (dir * phi) / plateArc, (r - (mid - h)) / (2 * h)],
  };
  const parts = [sweptBody(body, 22), sweptBody(plate, 12)];
  const geo = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  // Centered behind the hub; turn it up to the height asked for, on the trailing side or (mirrored about
  // the hub's vertical) the leading one. A turn, not a flip, so the outboard face stays outboard.
  geo.rotateX(at.leading ? Math.PI - at.up : at.up);
  geo.translate(-hatHeight(), 0, 0);
  return geo;
}

/**
 * The logo plate's lettering as a mask (white on black, linear): the plate's face maps onto it, and
 * everything else on the caliper samples its black corner. Null without a DOM to draw it on (the
 * calipers are then plain).
 */
export function caliperLogoTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const w = 256;
  const ht = 64;
  return drawTexture(
    w,
    ht,
    (g) => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, w, ht);
      const text = BRAKE.caliperLogo.text;
      fitFont(g, text, w * 0.78, ht * 0.62, (px) => `italic 900 ${px}px 'Google Sans Flex', system-ui, sans-serif`);
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, w / 2, ht / 2 + 2);
    },
    { srgb: false, repeat: false },
  );
}
