/**
 * The GPU resources a build creates (geometries, materials, textures, render targets, instanced meshes),
 * freed together. `track(x)` remembers x and returns it, so a resource is tracked where it is made:
 * `const mat = track(new THREE.MeshStandardMaterial(...))`. Nothing tracked leaks when a scene is rebuilt.
 */
export interface Disposable {
  dispose(): void;
}

export class Disposer {
  private readonly items: Disposable[] = [];

  /** Remember `x` for dispose(); returns it. An arrow, so it can be passed or destructured. */
  readonly track = <T extends Disposable>(x: T): T => {
    this.items.push(x);
    return x;
  };

  /** Free everything tracked, in the order it was tracked. */
  dispose(): void {
    for (const x of this.items) x.dispose();
    this.items.length = 0;
  }
}
