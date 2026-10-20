/**
 * Hills renderer: nothing to draw. The hill is terrain (a height modifier,
 * src/city/districts/hills.ts), and everything standing on it already
 * follows world.heightAt: roads, curbs and sidewalks are subdivided strips,
 * buildings sit on their lowest corner with a plinth where the ground rises
 * (render/buildings.ts), props, rails, crowds and the El sample the ground.
 * The module exists so every area kind has a renderer and there is a place
 * for hill dressing later (retaining walls on the steepest flanks, stairs
 * beside the steepest sidewalks, a summit lookout).
 */
import type { DistrictRenderer } from './kit';

export const hillsRenderer: DistrictRenderer = {
  kinds: ['hills'],
  build() {},
};
