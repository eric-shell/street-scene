/**
 * The AudioWorklet processor that runs an EngineSynth on the audio thread:
 * no inputs, three outputs (the exhaust with a channel per tailpipe, the
 * intake, the body) that the EngineVoice on the main thread filters,
 * convolves and mixes. Parameters arrive as
 * k-rate AudioParams so the voice can ramp them with setTargetAtTime; the
 * program comes in processorOptions. Loaded by engineAudio.ts through Vite's
 * `?worker&url` import (bundled as its own module, so this file and what it
 * imports must stay free of DOM and window code). The worklet scope has no
 * TypeScript lib, hence the declarations below.
 */
import { ENGINE_PROCESSOR, EngineSynth, SYNTH_PARAMS, type EngineMessage, type EngineProgram, type SynthParams } from './engineSynth';

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
}
declare function registerProcessor(name: string, ctor: unknown): void;
declare const sampleRate: number;

class EngineProcessor extends AudioWorkletProcessor {
  private readonly synth: EngineSynth;
  private readonly params = Object.fromEntries(SYNTH_PARAMS.map((p) => [p.name, p.defaultValue])) as unknown as SynthParams;
  private alive = true;

  static get parameterDescriptors() {
    return SYNTH_PARAMS.map((p) => ({ ...p, automationRate: 'k-rate' }));
  }

  constructor(options: { processorOptions: { program: EngineProgram } }) {
    super(options);
    this.synth = new EngineSynth(options.processorOptions.program, sampleRate);
    // 'stop' lets the node be garbage collected (returning false ends processing); a pop is an overrun bang or crackle.
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as EngineMessage;
      if (m === 'stop') this.alive = false;
      else if (m && typeof m === 'object' && 'pop' in m) this.synth.pop(m.pop.at, m.pop.pipe, m.pop.gain, m.pop.size);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    if (!this.alive) return false;
    const exhaust = outputs[0];
    const intake = outputs[1]?.[0];
    const body = outputs[2]?.[0];
    if (!exhaust?.length || !intake || !body) return true;
    for (const p of SYNTH_PARAMS) this.params[p.name] = parameters[p.name][0];
    this.synth.render(exhaust, intake, body, this.params);
    return true;
  }
}

registerProcessor(ENGINE_PROCESSOR, EngineProcessor);
