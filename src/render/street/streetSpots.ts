/**
 * Where the road's iron and steel are, for the ears: every manhole cover and storm drain the decals draw (a disc)
 * and every rail of the tram tracks (a segment), in a hash grid so the session can ask "what is under this wheel"
 * a few times a frame without scanning the city. Built by streetDecals.ts with the decals themselves (so only what is
 * drawn can clank, at the tier's density), read by game/session/audio.ts to play the clank and the rail tick for the
 * player's wheels. Render only: nothing here touches the sim, and the road surface stays as the sim has it.
 */

/** Grid cell size (m): a wheel moves under 1 m a frame and a rail piece is about 4 m. */
const CELL = 6;

/** What a disc is: a cover rings differently from a grate. */
export type SpotKind = 'manhole' | 'drain';

export interface IronDisc {
  x: number;
  z: number;
  /** Radius a tyre must pass within to hit it (m). */
  r: number;
  kind: SpotKind;
}

export interface RailPiece {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

const key = (ix: number, iz: number): number => (ix + 32768) * 65536 + (iz + 32768);

export class StreetSpots {
  readonly discs: IronDisc[] = [];
  readonly rails: RailPiece[] = [];
  private readonly discGrid = new Map<number, number[]>();
  private readonly railGrid = new Map<number, number[]>();

  addDisc(x: number, z: number, r: number, kind: SpotKind): void {
    this.insert(this.discGrid, this.discs.length, x - r, z - r, x + r, z + r);
    this.discs.push({ x, z, r, kind });
  }

  addRail(ax: number, az: number, bx: number, bz: number): void {
    this.insert(this.railGrid, this.rails.length, Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz));
    this.rails.push({ ax, az, bx, bz });
  }

  /** Calls `fn(index)` for the discs near the box (maybe twice for one: callers dedupe by their own rate limit). */
  discsNear(x0: number, z0: number, x1: number, z1: number, fn: (i: number) => void): void {
    this.visit(this.discGrid, x0, z0, x1, z1, fn);
  }

  /** Calls `fn(index)` for the rail pieces near the box. */
  railsNear(x0: number, z0: number, x1: number, z1: number, fn: (i: number) => void): void {
    this.visit(this.railGrid, x0, z0, x1, z1, fn);
  }

  private insert(grid: Map<number, number[]>, id: number, x0: number, z0: number, x1: number, z1: number): void {
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
        const k = key(ix, iz);
        const cell = grid.get(k);
        if (cell) cell.push(id);
        else grid.set(k, [id]);
      }
    }
  }

  private visit(grid: Map<number, number[]>, x0: number, z0: number, x1: number, z1: number, fn: (i: number) => void): void {
    if (grid.size === 0) return;
    for (let ix = Math.floor(Math.min(x0, x1) / CELL); ix <= Math.floor(Math.max(x0, x1) / CELL); ix++) {
      for (let iz = Math.floor(Math.min(z0, z1) / CELL); iz <= Math.floor(Math.max(z0, z1) / CELL); iz++) {
        const cell = grid.get(key(ix, iz));
        if (cell) for (const i of cell) fn(i);
      }
    }
  }
}
