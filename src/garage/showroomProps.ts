/**
 * The garage's furniture, built from primitives into one merged mesh per
 * material (the Kit): two-post lifts, fluorescent battens on chains, the roof
 * trusses and pipe runs, workbenches, rolling tool chests, shelving, tires, an
 * engine hoist, the tool truck's roll cabs and lockers, the shop's machines
 * and wall dressing, seats and bins, banners, signs and the dyno. Each prop is
 * drawn in a local frame (x along its wall, +z facing into the room) that
 * Kit.place() puts in the room. Render only; garage/showroom.ts lays the room out.
 *
 * The props live beside this file in props/, one module per kind of thing
 * (kit, materials, lifts, workAreas, toolStorage, wallDressing, equipment,
 * furnishings, atmosphere); this is the one path the showroom imports them by.
 */
export { GLOW, BADGES, BANNERS, createMaterials } from './props/materials';
export type { Mats } from './props/materials';
export { Kit } from './props/kit';
export { lift, batten, roof } from './props/lifts';
export type { LiftFit } from './props/lifts';
export { workbench, toolChest, shelving, tire, tireRack, drum, compressor, engineHoist, jackAndStands, panels, extinguisher } from './props/workAreas';
export { rollCab, locker, utilityCart, tireChanger, wheelBalancer, welder, carryBox } from './props/toolStorage';
export type { CabTop } from './props/toolStorage';
export { toolBoard, wallCabinets, whiteboard, clipboard, ceilingReel } from './props/wallDressing';
export { partsWasher, benchGrinder, drillPress, hydraulicPress, sandblaster, acMachine, alignmentConsole, transmissionJack, underhoistStand, batteryCharger, brakeBleeder, laptopCart, smokeMachine } from './props/equipment';
export { rollingStool, creeperSeat, trashCan, ragBin, wheelBoxes, coffeeCorner, flagshipCab, cellPlane } from './props/furnishings';
export type { CabStyle } from './props/furnishings';
export { lightPool, exitSign, bayNumber, banner, plateRow, wallClock, calendar, wallTv, floorDrain, cleanup, cones, spaceHeater, drumFan, beerCooler, dyno } from './props/atmosphere';
export type { DynoFit } from './props/atmosphere';
