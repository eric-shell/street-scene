import { describe, expect, it } from 'vitest';
import manifest from '../src/assets/carManifest.json';
import { DRIVE_WHEELS, ENGINE_LAYOUTS, ENGINE_POSITIONS, EngineLayout, EnginePosition, EngineSpec, drivetrainCode, engineName, engineSpecErrors, firingsPerRev, specBadges } from '../src/shared/carSpec';
import { DRIVETRAIN_LAYOUTS, SELECTABLE_CAR_IDS, getBaseTuning } from '../src/sim/tuning';

const cars = manifest.cars as { id: string; engine: EngineSpec; engineSwaps?: { id: string; engine: EngineSpec }[] }[];
const spec = (layout: EngineLayout, aspiration: EngineSpec['aspiration'] = 'na', position: EnginePosition = 'front'): EngineSpec => ({ layout, aspiration, position });

describe('car spec labels', () => {
  it('every car in the manifest has a valid engine spec', () => {
    for (const c of cars) expect(engineSpecErrors(c.engine), c.id).toEqual([]);
    for (const c of cars) for (const s of c.engineSwaps ?? []) expect(engineSpecErrors(s.engine), `${c.id} ${s.id}`).toEqual([]);
    expect(engineSpecErrors(undefined)).toHaveLength(1);
    expect(engineSpecErrors({ type: 'v6', cylinders: 6 })).toHaveLength(5); // three missing fields, two unknown ones
    expect(engineSpecErrors({ layout: 'V7', aspiration: 'na', position: 'front' })).toEqual([expect.stringContaining('engine.layout "V7"')]);
  });

  it('the optional voice block is checked field by field', () => {
    const base = { layout: 'B4', aspiration: 'turbo', position: 'front' };
    expect(engineSpecErrors({ ...base, voice: { headers: 'unequal', pipes: 2, muffler: 'sport', intake: 'itb', crank: 'flat' } })).toEqual([]);
    expect(engineSpecErrors({ ...base, voice: {} })).toEqual([]);
    expect(engineSpecErrors({ ...base, voice: 'loud' })).toEqual(['engine.voice must be an object']);
    expect(engineSpecErrors({ ...base, voice: { muffler: 'loud' } })).toEqual([expect.stringContaining('engine.voice.muffler "loud"')]);
    expect(engineSpecErrors({ ...base, voice: { pipes: 3 } })).toEqual([expect.stringContaining('engine.voice.pipes 3')]);
    expect(engineSpecErrors({ ...base, voice: { exhaust: 'dual' } })).toEqual([expect.stringContaining('engine.voice.exhaust is not a known field')]);
  });

  it("a swapped build leads with a Swap tag in its own ink, then the swapped engine's tags", () => {
    const b = specBadges(spec('I5', 'turbo'), 'awd', '07K 2.5 Turbo');
    expect(b.map((x) => x.text)).toEqual(['Swap', 'FA', 'I5', 'Turbo']);
    expect(b.map((x) => x.ink)).toEqual(['swap', 'drive', 'engine', 'boost']);
    expect(b[0].title).toContain('07K 2.5 Turbo');
    expect(specBadges(spec('I5', 'turbo'), 'awd').map((x) => x.text)).toEqual(['FA', 'I5', 'Turbo']);
  });

  it('the selectable cars carry a drivetrain code and an engine layout', () => {
    const badges = Object.fromEntries(SELECTABLE_CAR_IDS.map((id) => [id, specBadges(cars.find((c) => c.id === id)!.engine, getBaseTuning(id).drivetrain.layout).map((b) => b.text)]));
    expect(badges).toEqual({ wendtStrom: ['FA', 'VR6'], kazamaRotor: ['FR', 'R2', 'Turbo'], albrechtKombi: ['FA', 'I5', 'Turbo'], daltonFiend: ['FR', 'V8', 'S/C'], tachibanaZenith: ['FR', 'I6', 'Turbo'], tachibanaRunabout: ['MR', 'I4', 'Turbo'], nakayaGrove: ['FR', 'I4'] });
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
