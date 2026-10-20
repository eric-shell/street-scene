import { describe, expect, it } from 'vitest';
import manifest from '../src/assets/carManifest.json';
import { DRIVE_WHEELS, ENGINE_LAYOUTS, ENGINE_POSITIONS, EngineLayout, EnginePosition, EngineSpec, drivetrainCode, engineName, engineSpecErrors, firingsPerRev, specBadges } from '../src/shared/carSpec';
import { DRIVETRAIN_LAYOUTS, SELECTABLE_CAR_IDS, getBaseTuning } from '../src/sim/tuning';

const cars = manifest.cars as { id: string; engine: EngineSpec }[];
const spec = (layout: EngineLayout, aspiration: EngineSpec['aspiration'] = 'na', position: EnginePosition = 'front'): EngineSpec => ({ layout, aspiration, position });

describe('car spec labels', () => {
  it('every car in the manifest has a valid engine spec', () => {
    for (const c of cars) expect(engineSpecErrors(c.engine), c.id).toEqual([]);
    expect(engineSpecErrors(undefined)).toHaveLength(1);
    expect(engineSpecErrors({ type: 'v6', cylinders: 6 })).toHaveLength(5); // three missing fields, two unknown ones
    expect(engineSpecErrors({ layout: 'V7', aspiration: 'na', position: 'front' })).toEqual([expect.stringContaining('engine.layout "V7"')]);
  });

  it('the selectable cars carry a drivetrain code and an engine layout', () => {
    const badges = Object.fromEntries(SELECTABLE_CAR_IDS.map((id) => [id, specBadges(cars.find((c) => c.id === id)!.engine, getBaseTuning(id).drivetrain.layout).map((b) => b.text)]));
    expect(badges).toEqual({ protoHatch: ['FF', 'I4', 'Turbo'], protoCompact: ['FR', 'I6'], protoCoupe: ['FR', 'V6', 'Turbo'] });
  });

  it('drivetrain codes are the standard two letters: engine position then driven wheels', () => {
    const codes = new Set<string>();
    for (const p of Object.keys(ENGINE_POSITIONS) as EnginePosition[]) for (const d of DRIVETRAIN_LAYOUTS) codes.add(drivetrainCode(p, d));
    expect([...codes].sort()).toEqual(['FA', 'FF', 'FR', 'MA', 'MF', 'MR', 'RA', 'RF', 'RR']);
    for (const d of DRIVETRAIN_LAYOUTS) expect(DRIVE_WHEELS[d].code).toHaveLength(1);
  });

  it('names read naturally and firing rates follow the layout', () => {
    expect(engineName(spec('I4', 'turbo'))).toBe('Turbocharged inline 4');
    expect(engineName(spec('V6'))).toBe('Naturally aspirated V6');
    expect(specBadges(spec('B4', 'turbo', 'rear'), 'awd').map((b) => b.title)).toEqual(['Rear engine, all-wheel drive', 'Turbocharged flat 4', 'Turbocharged flat 4']);
    expect(firingsPerRev(spec('I4'))).toBe(2);
    expect(firingsPerRev(spec('V6'))).toBe(3);
    expect(firingsPerRev(spec('V8'))).toBe(4);
    // A rotor fires once per eccentric shaft revolution: a twin rotor sounds like a four.
    expect(firingsPerRev(spec('R2'))).toBe(2);
    for (const l of Object.keys(ENGINE_LAYOUTS) as EngineLayout[]) expect(firingsPerRev(spec(l)), l).toBeGreaterThan(0);
  });
});
