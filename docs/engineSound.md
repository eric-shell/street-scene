# Engine sound

How the engine voices are made, what each of the first four engines is modelled on, and the plan for the rest. Code: `src/audio/engineSynth.ts` (the pure synth and the program built from a car's `EngineSpec`), `src/audio/engineWorklet.ts` (runs it on the audio thread), `src/audio/engineAudio.ts` (the voice: silencer convolution, intake, turbo, levels). Tests: `tests/engineVoice.test.ts`, `e2e/engine.spec.ts`.

## The model

The structure is Ange Yaghi's **Engine Simulator** (github.com/ange-yaghi/engine-sim, MIT; `src/synthesizer.cpp`, `src/piston_engine_simulator.cpp::writeToSynthesizer`) without its gas simulation. What that program showed is that an engine's character is mostly *when* and *how strongly* each cylinder's exhaust pulse reaches the tailpipe, not the waveform of a single pulse. So:

1. **Firing schedule.** Every layout has its real firing order and bank assignment (`SCHEDULE` in `engineSynth.ts`): a cylinder fires at `k / n` of the combustion cycle (720° for a four stroke, 360° per rotor).
2. **Exhaust paths.** Each cylinder's pulse travels its header primary to the collector; the arrival delay is the extra length over the shortest primary at 343 m/s, and the amplitude falls as 1 / length² (engine-sim's rule, against a 1 m reference). Header style is per car: tubular headers are nearly equal, a turbo's log manifold is short but position dependent, a boxer's "unequal" headers put the left bank half a metre further away.
3. **Pulse.** A blowdown rise (raised cosine, ~0.012 of the cycle), an exponential exhaust stroke decay and a scavenging dip, as a wavetable over cycle phase, so pulses shorten in time as revs rise. A turbine downstream widens the rise and eats the dip (`smear`). Each firing gets a shot to shot amplitude variance, largest at idle (the lope); the limiter drops firings at random.
4. **Per pipe post chain** (engine-sim's `renderAudio`): band limit at 1.5 to 2.6 kHz (their 1.9 kHz input filter), a wandering sample delay (their `JitterFilter`), a 10 Hz DC block, then `edge × derivative + pressure × (air × lowpassed noise + (1 − air))`. The derivative is what a pipe end radiates and carries the tone; the noise term is the turbulence that makes it breathe. Engine-sim runs almost pure derivative (`dF_F_mix = 0.01` of a `/dt` derivative is a ×440 weight), we keep `edge` per layout.
5. **Leveler.** A power follower sets a slow gain so the raw voice sits at the same loudness at idle and at the redline, whatever the train's crest factor; the voice applies load, rpm and distance on top, plus a `trim` from the program (bright, derivative heavy trains come through the silencer response quieter than bass heavy ones; a V8 through two pipes comes out hot) so the four cars measure within a few dB of each other at the engine bus.
6. **Tailpipes.** A twin pipe car (`pipes: 2`) renders each pipe on its own channel, left and right, and the second pipe runs 5 cm further: summed in mono the two banks' trains would otherwise cancel exactly (the chain is linear), which real cars avoid because you hear two tailpipes and they are never equal. Heard from one pipe a cross-plane V8 bank measures +2.5 dB uneven, a flat-plane bank −14 dB, an inline six's three −21 dB.
7. **Silencer.** The sum is convolved (`ConvolverNode`) with an impulse response we render ourselves (`renderImpulse`): a unit direct path, the pipe column's half wave modes for the system length, the silencer chamber and a tailpipe ring for sporty ones as resonances given by Q and their boost over the direct path (a decaying sine of amplitude A and time constant τ has gain Aτ/2 at its frequency, so amplitudes are tiny and a +6 dB mode is a +6 dB mode), and a diffuse noise tail sized by its energy against the direct path. The first version sized the sines like impulses, which made every mode a +40 dB peak that sub-harmonic content lit up at random; levels only became predictable once the modes were physical. Engine-sim ships recorded responses; ours are synthesized so everything stays runtime generated and nothing of theirs is redistributed.
8. **Intake and body.** The worklet also renders the intake (a softer pulse half a cycle from the exhaust one, scaled by throttle^1.5, through a trumpet band pass on the main thread: individual throttle bodies honk, a plenum murmurs) and the valvetrain tick (a 1.5 ms noise burst at each firing, loudest with the throttle closed).
9. **Events.** The sim's gear change cut (`shiftTimer`) zeroes the load; rpm pinned at the redline with the pedal down turns the limiter on; overrun pops come from the model below.

### Overrun pops and the exhaust flash

Real pops are unburnt fuel lighting in a hot exhaust, so the voice keeps two states (`OVERRUN` in `engineAudio.ts`) and the sim knows nothing about them:

- **Heat** rises under load at revs with a 4 s time constant and cools over 20 s. A cold engine barely pops on the overrun; one that has been driven hard does.
- **Fuel** is dumped into the pipe on a lift from above 45 % of the redline, the amount rising steeply with how high the lift was (and ×1.3 for a turbo running rich under boost); it burns off over 1.2 s, and the pedal takes it back in 0.15 s.
- **Three ways in.** On the limiter (rpm within 150 of the redline with the pedal down, which the sim holds in top gear and the garage bounces on) the cut dumps mixture every few firings: a stream of 3 to 9 events per second by silencer, mostly crackles. A high rev upshift's cut pops with chance `0.35 × freedom × heat`. On the overrun the chance is `pops × 0.45 × fuel × heat × dt` per second, where `pops` is the silencer's freedom (quiet 0.3, sport 1.2, straight 2.5, turbo ×0.6): a hot sport car pops on roughly a quarter of its lifts from the top, rarely from half revs, a quiet turbo car one in twenty. 45 % of overrun events are a single bang (a 40 ms crack with a 90 Hz thump), the rest a burst of two to four crackles 30 to 80 ms apart.
- Pops join the exhaust **after** the leveler at their own peak (about 0.25 a crackle, 0.55 a bang, against the engine's 0.1 RMS; soft clipped), so the leveler cannot duck them and they read the same whatever the engine is doing; the silencer response still colours them. Measured at the bus they peak about 5 dB over the engine's own peaks.
- The same event fires the sound in the worklet (`port.postMessage({ pop })`, `EngineSynth.pop`) and `EngineVoice.onPop`, which the race session and the garage route to `CarView.popFlash`: an orange additive cone at that tailpipe (the nitrous flame's position) that bursts out and dims over 70 ms for a crackle, 160 ms for a bang. No light is added (a new point light would recompile every lit material); the flash is emissive only.

### Grain

Three things made the first version hiss above 4 kHz, and all were sources rather than something to filter: the valvetrain tick fired a highpassed noise burst at every firing (350 a second for a six at 7000 rpm, a continuous crackle), so it now fires at most every 25 ms and fades out by three quarters of the redline; the jitter noise was nearly white (engine-sim's 10 kHz cutoff), so the wander is now band limited to 600 Hz and reads as the pipe moving; and the turbulence noise was 2 kHz wide, now 1.2 kHz. The pulse wavetable went from 2048 to 8192 entries so the derivative of its interpolation no longer steps at idle. On top of that the voice rolls off above 6.5 kHz (`VOICE.top`), since nothing but grain lives there. Decel is only 3 dB under full throttle now (`0.7 + 0.3 × load`) and the leveler recovers in 0.15 s after a lift, so the overrun, where the pops and the silencer are heard, no longer drops away.

Everything is deterministic from a seed (xorshift); each voice gets its own seed so rivals never phase lock with the player. Rivals run a `lite` program: half the silencer response, no intake or valvetrain.

Cost, measured headless at 48 kHz in Node: 5 to 13 ms of CPU per second of audio per voice (about 1 %), on the audio thread, not the frame. The convolution is native. Four voices in a race are well inside budget on a laptop; phones have not been measured yet.

## Data

The manifest's `engine` block gained an optional `voice` (vocabulary in `src/shared/carSpec.ts`, validated by `npm run validate` and the tests):

| Field | Values | What it changes |
|---|---|---|
| `headers` | `equal`, `unequal` | Unequal: the second bank's primaries are 0.5 m longer, arriving late and weaker (boxer rumble). |
| `pipes` | `1`, `2` | Two keeps each bank, or each half of an inline six, on its own pipe, so uneven per bank patterns reach the tailpipe. |
| `muffler` | `quiet`, `sport`, `straight` | System length, band limit, pops per lift, and the impulse response (long low modes vs short bright ring). |
| `intake` | `plenum`, `itb` | Throttle bodies: a loud resonant honk that follows the pedal. |
| `crank` | `cross`, `flat` | V8 only: cross-plane banks fire 180-270-180-90 (burble), flat-plane 180-180-180-180 (scream). |

Defaults by layout are `LAYOUT_VOICE`; turbo engines default to the quiet silencer, the rest to sport.

## The first four engines

### Proto Hatch: Subaru EJ flat four, turbo (WRX)

- Reference: Subaru EJ20/EJ25 turbo in the Impreza WRX (GC/GD/GH). 180° flat four, firing order 1-3-2-4 with cylinders 1 and 3 on the right bank: opposed pairs share crank timing, so each bank fires twice 180° apart then rests for a full turn. Redline 6500 to 7000; the sim's Hatch runs 7200.
- The rumble: the classic "Subaru sound" is the **unequal length header**: the left bank's primaries cross under the engine to reach the right bank's collector, so its pair of pulses arrives late and weaker. Equal length headers (2015+ WRX FA20) take it away, which engine-sim demonstrates with its two EJ25 scripts (`assets/engines/atg-video-2/01_subaru_ej25_eh.mr` vs `02_subaru_ej25_uh.mr`: primaries 2", 3", 3", 5" against 2", 3", 500 mm, 550 mm).
- Spec: `B4`, `turbo`, `voice: { headers: 'unequal', muffler: 'sport' }`. Measured unevenness (energy at cycle harmonics off the firing grid over energy on it): +1.5 dB at 3500 and +1.1 dB at 7000 rpm against −19 / −12 dB on equal headers.
- Still to add: the turbo whistle as a blade pass harmonic series rather than one sine, wastegate flutter on the lift, a deeper idle (the EJ idles near 700 with a visible lope). The sport silencer gives it the occasional overrun pop.

### Proto Compact: BMW S54 inline six (E46 M3)

- Reference: S54B32, 3.2 l inline six, firing order 1-5-3-6-2-4, six individual throttle bodies, 6-2-1 headers (cylinders 1-3 and 4-6 grouped) into twin pipes, redline 8000. engine-sim's `assets/engines/bmw/M52B28.mr` is the sibling six (same order, 20" primaries, two exhaust systems).
- The sound: even 120° firing with no bank asymmetry, so the voice is smooth and the character comes from the **intake** (the ITB honk that follows the pedal from 4000 up) and a bright, metallic edge from short sport silencers. Measured unevenness −16 to −24 dB: as even as it should be.
- Spec: `I6`, `na`, `voice: { pipes: 2, muffler: 'sport', intake: 'itb' }`. Measured −13 dB uneven in mono at 3500 rpm (−21 dB per pipe), so the 5 cm crossover does not lump it.
- Still to add: a cam timing / VANOS step in the intake resonance at mid rpm, more rasp above 6000 (raise `edge` with rpm), the famous overrun crackle (more pops for `straight`).

### Proto Coupe: Toyota 2JZ-GTE inline six, twin turbo (Supra JZA80)

- Reference: 3.0 l inline six, firing order 1-5-3-6-2-4, sequential twin turbos fed by a single cast log manifold, one exhaust after the turbines, redline 6800 to 7000 (the sim's Coupe runs 7600). engine-sim: `assets/engines/atg-video-2/03_2jz.mr` (40" primaries, two 100" systems in the NA script).
- The sound: the turbines smear every pulse and the single quiet system rounds it off, so the Supra is a deep, smooth hum with the turbo whoosh and blow-off on top. The voice: `smear` (wider pulse, lower band limit, less edge, more air), one pipe, the quiet silencer with the longest response.
- Spec: `I6`, `turbo`, `voice: { pipes: 1, muffler: 'quiet' }`.
- Still to add: the sequential turbo's two stage spool (second turbine joins near 4000), a stronger induction whoosh band that follows boost, and a BOV with pitch drop.

### Proto Wagon: Audi 4.0 TFSI V8, twin turbo (RS6 C7/C8)

- Reference: 4.0 l 90° cross-plane V8, firing order 1-5-4-8-6-3-7-2 (Audi numbering, cylinders 1-4 on bank 1), "hot vee" turbos inside the V with one turbine per bank, twin pipes with each bank on its own side, valved sport exhaust, redline 6800 to 7000, lumpy idle near 650. engine-sim's cross-plane reference is `assets/engines/atg-video-2/07_gm_ls.mr` (per bank primaries 3·spacing+2 cm down to 5 cm, two systems of 100" and 172"); its flat-plane counterpart is `08_ferrari_f136_v8.mr`.
- The sound: cross-plane banks fire 180-270-180-90, and with one pipe per bank that unevenness reaches the tailpipes: the V8 burble, softened by the turbines. Measured per pipe: +2.5 dB uneven at 3500 and +3.6 dB at 7000 against −14 / −10 dB for a flat-plane bank; the mono sum keeps −5 to −1 dB of it through the crossover.
- Spec: `V8`, `turbo`, `voice: { pipes: 2, muffler: 'sport', crank: 'cross' }` on `protoWagon` (the car arrived from the donor model work: 1820 kg, AWD 40/60, eight speeds, redline 6800).
- Still to add: the valved exhaust as a second `muffler` the garage can switch (quiet on cruise, sport on load), the deeper idle lope (`rough` with a slow 1 to 2 Hz wander), a longer, boomier response for the big silencers.

## The plan for the rest

Each layout already has a schedule and a `LAYOUT_VOICE` entry so every car sounds plausibly like its layout today; the items below are what would make each one *recognisable*, with a reference engine and the engine-sim script where one exists.

| Layout | Reference | What makes it | To do |
|---|---|---|---|
| I3 | Ford 1.0 EcoBoost, Toyota GR Yaris G16E | 240° even firing, thrummy, odd harmonics | Stronger `rough`, an intake growl band near 300 Hz |
| I5 | Audi 2.5 TFSI (RS3), Volvo T5 | 1-2-4-5-3, 144° even; the warble is a 2.5 order from the long/short runner stagger | Tune `stagger` against a reference recording; engine-sim `assets/engines/audi/i5.mr` and `atg-video-1/07_audi_i5.mr` |
| V6 even fire | Nissan VQ35, Honda J35 | Banks alternate; each bank an even three | Per bank primaries 3-into-1, `pipes: 2` default; a VQ "snarl" is intake plus a 1.2 kHz ring |
| V6 odd fire | Buick 231 (90° V6 with a 60° crank gap) | 90-150 alternating intervals | Needs an uneven `fire` schedule (engine-sim `atg-video-2/05_odd_fire_v6.mr`); add `crank: 'odd'` to the vocabulary |
| VR6 | VW VR6 2.8 / 3.2 (Golf R32) | One head, 15° stagger: runners alternate short and long | Tune `stagger` (0.07 m now) and a single large plenum intake |
| B6 | Porsche 911 (M96 / 9A1) | Even per bank threes, twin pipes, intake howl at 5000+, fan noise in air cooled ones | `intake: 'itb'`-style resonance per bank; an air cooled variant with a fan whine |
| V8 cross | GM LS, Audi 4.0 TFSI (above) | 180-270-180-90 per bank | Done; `muffler` switching |
| V8 flat | Ferrari F136 (458), Shelby GT350 Voodoo | Even banks, 180° pairs, the scream from 7000 up | Done in schedule; raise `edge` with rpm, add intake trumpets |
| V10 | Lexus LFA 1LR-GUE, Lamborghini V10 (72°) | Even 72°, two uneven fives per bank | Check per bank pattern against a recording; LFA's intake "howl" is a tuned surge tank: a strong intake resonance near 500 Hz |
| V12 / W12 | Ferrari F140 (812), BMW S70 (McLaren F1), Bentley W12 | Two inline sixes 60° apart; silky, 6th order whine | Lower `rough`, `pipes: 2`; W12 adds the VR stagger per bank |
| W16 | Bugatti Veyron / Chiron | Four banks, quad turbo | Four pipes merged two and two; four `smear`ed turbines |
| R2 / R3 | Mazda 13B-REW (RX-7), 20B (Cosmo) | One combustion per rotor per shaft turn, long port opening: the "brap" | Pulse shape is wider already; add the apex seal rasp (noise burst per face), the famous bridge port idle lope, and the exhaust pop on overrun |
| Supercharged | Shelby GT500, Hellcat, Lotus Exige | Roots / twin screw whine at a fixed ratio of crank speed (×2.5 to ×3.4) with lobe harmonics | A whine partial set like the turbo whistle but rpm locked; `aspiration: 'supercharged'` is in the vocabulary already |

Features that apply to every engine, roughly in order of what the ear notices:

1. **Turbo and blow-off** rebuilt as a blade pass harmonic series with flutter, and a boost dependent induction whoosh; the whistle currently is one sine.
2. **Exhaust modes** per car (a valved silencer: cruise vs sport), chosen in the garage like a part.
3. **Space.** Rivals already pan and fall off with distance; add Doppler (pitch by closing speed), a short reflection when driving under the elevated railway or through a tunnel, and a low pass for the interior cameras (hood, bumper) against the chase camera.
4. **Nitrous** backfire pops through the silencer when the shot ends, instead of the separate hiss only (the overrun pop path can carry it: a bang with fuel 1).
5. **Gear whine and road** are separate SFX today; a straight cut gearbox whine locked to wheel speed would suit the straight-silencer builds.
6. **Phones.** Measure the worklet and four convolvers on a mid Android device; `lite` already halves rivals' response length, and the next knob is one shared convolver for all rivals.

## How to work on it

- Headless: `buildProgram(spec)` and `EngineSynth.render(...)` run under `npx tsx` or Vitest; `tests/engineVoice.test.ts` has `unevenness()` (energy at cycle harmonics off the firing grid vs on it, in dB) and `tone()` (Goertzel at one frequency) to compare programs without listening, and `renderImpulse` gives the silencer response to inspect. Rendering to WAV for listening is a 20 line script (see the session that built this, or write the Float32Array as 16 bit PCM).
- In the browser: `/dev` with `?garage`, press the gas (Space) to rev; the Street view cruises at part throttle. `e2e/engine.spec.ts` checks the worklet registers and a voice runs. Levels were balanced by driving each car's `EngineVoice` from a Playwright script with an `AnalyserNode` on `audioHub().engineBus` (headless Chromium renders the graph): at full throttle the four cars read 0.12 to 0.16 RMS there, idle 0.03 to 0.07, with the bus compressor after it; the share of power above 5 kHz sits 13 to 26 dB under the whole.
- Two things that bit while building it: `ConvolverNode.normalize` (on by default) buries a long response by 25 dB, so it is off and the response is peak normalized instead; and two symmetric tailpipes summed in mono cancel a cross-plane bank's unevenness exactly, hence the stereo pipes and the crossover.
- References to keep handy: engine-sim's `assets/engines/**/*.mr` for firing orders (`ignition_module.connect_wire`), bank angles and primary lengths; its `es/sound-library/impulse_responses.mr` for which responses it pairs with what; the layout tables above for the real cars.
