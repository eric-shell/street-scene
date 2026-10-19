// Temporary stub, replaced in milestone 7.
import type { GameRenderer } from '../render/scene';
import type { CarAssetLibrary } from '../render/carAssets';
import type { GarageState } from './storage';

export class GarageScreen {
  constructor(_gr: GameRenderer, _assets: CarAssetLibrary, _ui: HTMLElement, _g: GarageState, _a: Record<string, boolean>, cb: { onChange(g: GarageState): void; onExit(): void; onTestDrive(): void }) {
    setTimeout(() => cb.onExit(), 0);
  }
  tick(): void {}
  render(_dt: number): void {}
  dispose(): void {}
}
