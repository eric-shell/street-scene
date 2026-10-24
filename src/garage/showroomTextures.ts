/**
 * Canvas textures for the garage (garage/showroom.ts): stained concrete, grimy
 * block walls, the roof deck, the roller door, worn paint lines, oil stains,
 * diamond plate, the pegboard, drawer fronts, aged posters, the jobs board,
 * work orders, the tuners' parts boxes, the beer sign, the nameplates, the
 * banners, bay numbers, exit signs, plates, clock and calendar, the light
 * washes, and the dyno screen redrawn as it runs.
 * Each is drawn once per visit (a few milliseconds in all) from a fixed hash,
 * so the room looks the same every time. Render only.
 *
 * The painters live beside this file in textures/, one module per family
 * (brushes, surfaces, boards, signage, effects); this is the one path the
 * showroom and the neon signs import them by.
 */
export { noise } from './textures/brushes';
export { concreteTextures, wallTexture, deckTexture, doorTexture, lineTexture, stainTexture, plateTextures, hazardTexture } from './textures/surfaces';
export { pegboardTexture, drawerTexture, whiteboardTexture, workOrderTexture, partsBoxTexture } from './textures/boards';
export { posterTexture, badgeTexture, beerSignTexture, exitTexture, bayNumbersTexture, bannerTexture, platesTexture, clockTexture, calendarTexture } from './textures/signage';
export { washTexture, dynoScreen, glowTexture, shadowTexture } from './textures/effects';
