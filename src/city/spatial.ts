/** Uniform grid broadphase for static 2D items (segments, edges, boxes). */
export class SpatialGrid {
  readonly cells = new Map<number, number[]>();

  constructor(
    readonly cellSize: number,
    readonly originX: number,
    readonly originZ: number,
    readonly cols: number,
    readonly rows: number,
  ) {}

  static forBounds(minX: number, minZ: number, maxX: number, maxZ: number, cellSize: number): SpatialGrid {
    const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
    const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
    return new SpatialGrid(cellSize, minX, minZ, cols, rows);
  }

  private ci(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.originX) / this.cellSize)));
  }

  private cj(z: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.originZ) / this.cellSize)));
  }

  /** Insert an item covering an axis aligned box. */
  insertBox(id: number, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const i0 = this.ci(minX);
    const i1 = this.ci(maxX);
    const j0 = this.cj(minZ);
    const j1 = this.cj(maxZ);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = j * this.cols + i;
        let cell = this.cells.get(key);
        if (!cell) {
          cell = [];
          this.cells.set(key, cell);
        }
        cell.push(id);
      }
    }
  }

  insertSegment(id: number, ax: number, az: number, bx: number, bz: number, pad = 0): void {
    this.insertBox(id, Math.min(ax, bx) - pad, Math.min(az, bz) - pad, Math.max(ax, bx) + pad, Math.max(az, bz) + pad);
  }

  /**
   * Visit every item id near the query box exactly once, in ascending id order
   * so results are deterministic regardless of insertion details.
   */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[] {
    out.length = 0;
    const i0 = this.ci(minX);
    const i1 = this.ci(maxX);
    const j0 = this.cj(minZ);
    const j1 = this.cj(maxZ);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = this.cells.get(j * this.cols + i);
        if (!cell) continue;
        for (const id of cell) out.push(id);
      }
    }
    if (i0 !== i1 || j0 !== j1) {
      out.sort((a, b) => a - b);
      let w = 0;
      for (let r = 0; r < out.length; r++) if (r === 0 || out[r] !== out[r - 1]) out[w++] = out[r];
      out.length = w;
    }
    return out;
  }
}
