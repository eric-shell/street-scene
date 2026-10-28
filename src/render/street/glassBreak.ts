/**
 * Shop glass that breaks: the break state of every glass ground bay of the podiums (buildings/facadeKit.ts
 * `glassBays`), the lookup from a car hitting a building to the bay in front of it, and the textures the podium
 * shader reads (buildings/podiumMaterial.ts): a one-texel-per-bay state map and a small crack web.
 *
 * The sim reports a wall hit with no position, so the hit is placed from the car: the point the car is moving
 * into (its centre plus its velocity direction times its half length) is matched against the bays by a coarse grid
 * of their centres; the nearest bay whose face the point is at (inside its width, a little in front of it or in
 * the wall) and which the car is driving into breaks. Breaking is monotonic for the race. The state texel holds a
 * seed (1..255; 0 is intact) that moves the crack web and the missing panes per bay. A hit that is not on glass (a
 * plain wall, a lobby without a room) finds no bay and breaks nothing. Render only; a replay raises the same wall
 * events, so it breaks the same bays. Updating a texel re-uploads a texture of a few hundred bytes.
 */
import * as THREE from 'three';
import type { GlassBay } from '../buildings/facadeKit';

/** Hit rules: the least impact speed (m/s) that breaks glass; how far in front of the bay face (m) and into the wall the contact point may be; the cell of the lookup grid (m). */
export const GLASS = { minSpeed: 6, front: 3.2, behind: 0.9, along: 0.15, cell: 16 } as const;
/** Width of the state texture (texels); bays wrap onto further rows. */
const STATE_W = 256;
/** Side of the crack web texture (px). */
const CRACK_PX = 128;

export class GlassBays {
  /** Break seed per bay (0 intact, 1..255 broken), the texture's data. */
  readonly state: Uint8Array;
  /** One texel per bay for the podium shader; sampled with texelFetch, so no filtering. */
  readonly stateTex: THREE.DataTexture;
  /** The crack web (R: crack lines, soft edged), the same for every bay; the shader places and scales it per bay. */
  readonly crackTex: THREE.DataTexture;
  private readonly grid = new Map<number, number[]>();
  private seedCounter = 0;

  constructor(readonly bays: readonly GlassBay[]) {
    const rows = Math.max(1, Math.ceil(bays.length / STATE_W));
    this.state = new Uint8Array(STATE_W * rows);
    this.stateTex = new THREE.DataTexture(this.state, STATE_W, rows, THREE.RedFormat, THREE.UnsignedByteType);
    this.stateTex.magFilter = THREE.NearestFilter;
    this.stateTex.minFilter = THREE.NearestFilter;
    this.stateTex.needsUpdate = true;
    this.crackTex = makeCrackWeb();
    bays.forEach((b, i) => {
      const k = this.key(Math.floor(b.x / GLASS.cell), Math.floor(b.z / GLASS.cell));
      const list = this.grid.get(k);
      if (list) list.push(i);
      else this.grid.set(k, [i]);
    });
  }

  private key(cx: number, cz: number): number {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  /**
   * The unbroken bay a car at (x, z) heading `yaw` is driving into, or -1: `reach` metres ahead of its centre is
   * the contact point. The event is read after the tick resolved the hit, so the velocity is spent (or bounced
   * back) and only the heading says where the car was going; a car reversing into glass finds nothing. The
   * nearest face wins; the car must be pointing into the face.
   */
  find(x: number, z: number, yaw: number, reach: number): number {
    const dx = Math.sin(yaw);
    const dz = Math.cos(yaw);
    const px = x + dx * reach;
    const pz = z + dz * reach;
    const cx = Math.floor(px / GLASS.cell);
    const cz = Math.floor(pz / GLASS.cell);
    let best = -1;
    let bestD = Infinity;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = this.grid.get(this.key(cx + i, cz + j));
        if (!list) continue;
        for (const id of list) {
          if (this.state[id]) continue;
          const b = this.bays[id];
          const rx = px - b.x;
          const rz = pz - b.z;
          const out = rx * b.nx + rz * b.nz;
          if (out > GLASS.front || out < -GLASS.behind) continue;
          if (Math.abs(rx * -b.nz + rz * b.nx) > b.halfLen + GLASS.along) continue;
          if (dx * b.nx + dz * b.nz > -0.2) continue;
          const d = Math.abs(out);
          if (d < bestD) {
            bestD = d;
            best = id;
          }
        }
      }
    }
    return best;
  }

  /** Break bay `id` (a no-op once broken): picks its seed and uploads the state. Returns the seed 1..255, 0 if it was already broken. */
  breakBay(id: number): number {
    if (id < 0 || id >= this.bays.length || this.state[id]) return 0;
    this.seedCounter = (this.seedCounter * 73 + 41 + id * 7) % 255;
    const seed = this.seedCounter + 1;
    this.state[id] = seed;
    this.stateTex.needsUpdate = true;
    return seed;
  }

  dispose(): void {
    this.stateTex.dispose();
    this.crackTex.dispose();
  }
}

/** A crack web on a small canvas: radial cracks from the middle with jagged segments and a few rings joining them, white on black. */
function makeCrackWeb(): THREE.DataTexture {
  const c = document.createElement('canvas');
  c.width = c.height = CRACK_PX;
  const g = c.getContext('2d');
  const out = new Uint8Array(CRACK_PX * CRACK_PX);
  if (g) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, CRACK_PX, CRACK_PX);
    g.strokeStyle = '#fff';
    g.lineCap = 'round';
    // A small deterministic generator: the web is the same in every city.
    let s = 12345;
    const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    const mid = CRACK_PX / 2;
    const rays = 15;
    const tips: number[][] = [];
    for (let i = 0; i < rays; i++) {
      const a = ((i + r() * 0.6) / rays) * Math.PI * 2;
      let x = mid;
      let y = mid;
      let rad = 0;
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(x, y);
      const ring: number[] = [];
      while (rad < mid * 0.98) {
        rad += 4 + r() * 9;
        const aa = a + (r() - 0.5) * 0.28;
        x = mid + Math.cos(aa) * rad;
        y = mid + Math.sin(aa) * rad;
        g.lineTo(x, y);
        ring.push(x, y);
        // A short side branch now and then.
        if (r() < 0.22) {
          g.stroke();
          g.lineWidth = 1.1;
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x + Math.cos(aa + (r() - 0.5) * 2) * (6 + r() * 14), y + Math.sin(aa + (r() - 0.5) * 2) * (6 + r() * 14));
          g.stroke();
          g.lineWidth = 2.2;
          g.beginPath();
          g.moveTo(x, y);
        }
      }
      g.stroke();
      tips.push(ring);
    }
    // Rings: join the same step of neighbouring rays with a line, the web of a hit on a pane.
    g.lineWidth = 1.2;
    for (const step of [2, 4, 7]) {
      g.beginPath();
      for (let i = 0; i <= rays; i++) {
        const t = tips[i % rays];
        const k = Math.min(step, t.length / 2 - 1) * 2;
        if (i === 0) g.moveTo(t[k], t[k + 1]);
        else g.lineTo(t[k], t[k + 1]);
      }
      g.stroke();
    }
    // Fade out to the edge so the web never ends on a hard square.
    const grad = g.createRadialGradient(mid, mid, mid * 0.45, mid, mid, mid);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = grad;
    g.fillRect(0, 0, CRACK_PX, CRACK_PX);
    const px = g.getImageData(0, 0, CRACK_PX, CRACK_PX).data;
    for (let i = 0; i < out.length; i++) out[i] = px[i * 4];
  }
  const t = new THREE.DataTexture(out, CRACK_PX, CRACK_PX, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
