import { describe, expect, it } from 'vitest';
import { VOICE_CHARACTER } from '../src/audio/engineAudio';
import { ENGINE_LAYOUTS, type EngineLayout } from '../src/shared/carSpec';
import manifest from '../src/assets/carManifest.json';

describe('engine voice characters', () => {
  it('cover every layout with finite, bounded settings', () => {
    for (const layout of Object.keys(ENGINE_LAYOUTS) as EngineLayout[]) {
      const ch = VOICE_CHARACTER[layout];
      expect(ch, layout).toBeDefined();
      for (const v of [ch.drive, ch.filterQ, ch.main, ch.sub, ch.beat, ch.order.mul, ch.order.gain, ch.order.detune, ch.noise.harmonic, ch.noise.gain, ...ch.lowpass]) expect(Number.isFinite(v)).toBe(true);
      expect(ch.beat).toBeGreaterThanOrEqual(0);
      expect(ch.beat).toBeLessThan(0.6);
      expect(ch.main * (1 + ch.beat)).toBeLessThanOrEqual(1);
      expect(ch.lowpass[0]).toBeGreaterThan(200);
    }
  });

  it('tell a V6 from an inline six, and the Coupe from the Compact', () => {
    expect(VOICE_CHARACTER.V6.beat).toBeGreaterThan(VOICE_CHARACTER.I6.beat + 0.2);
    expect(VOICE_CHARACTER.V6.order.mul).toBe(0.5);
    expect(VOICE_CHARACTER.I6.order.mul).toBe(2);
    const coupe = manifest.cars.find((c) => c.id === 'protoCoupe')!;
    const compact = manifest.cars.find((c) => c.id === 'protoCompact')!;
    expect(coupe.engine.layout).toBe('V6');
    expect(VOICE_CHARACTER[coupe.engine.layout as EngineLayout]).not.toBe(VOICE_CHARACTER[compact.engine.layout as EngineLayout]);
  });
});
