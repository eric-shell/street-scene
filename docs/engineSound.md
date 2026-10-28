# Engine sound

How the engine voices are made, what each of the first four engines is modelled on, and the plan for the rest. Code: `src/audio/engineSynth.ts` (the pure synth and the program built from a car's `EngineSpec`), `src/audio/engineWorklet.ts` (runs it on the audio thread), `src/audio/engineAudio.ts` (the voice: silencer convolution, intake, turbo, levels). Tests: `tests/engineVoice.test.ts`, `e2e/engine.spec.ts`.

## The model

The structure is Ange Yaghi's **Engine Simulator** (github.com/ange-yaghi/engine-sim, MIT; `src/synthesizer.cpp`, `src/piston_engine_simulator.cpp::writeToSynthesizer`) without its gas simulation. What that program showed is that an engine's character is mostly *when* and *how strongly* each cylinder's exhaust pulse reaches the tailpipe, not the waveform of a single pulse. So:

1. **Firing schedule.** Every layout has its real firing order and bank assignment (`SCHEDULE` in `engineSynth.ts`): a cylinder fires at `k / n` of the combustion cycle (720° for a four stroke, 360° per rotor).
2. **Exhaust paths.** Each cylinder's pulse travels its header primary to the collector; the arrival delay is the extra length over the shortest primary at 343 m/s, and the amplitude falls as 1 / length² (engine-sim's rule, against a 1 m reference). Header style is per car: tubular headers are nearly equal, a turbo's log manifold is short but position dependent, a boxer's "unequal" headers put the left bank half a metre further away.
3. **Pulse.** A blowdown rise (raised cosine, ~0.012 of the cycle), an exponential exhaust stroke decay and a scavenging dip, as a wavetable over cycle phase, so pulses shorten in time as revs rise. A turbine downstream widens the rise and eats the dip (`smear`). Each firing gets a shot to shot amplitude variance, largest at idle (the lope); the limiter drops firings at random.
4. **Per pipe post chain** (engine-sim's `renderAudio`): band limit at 1.5 to 2.6 kHz (their 1.9 kHz input filter), a wandering sample delay (their `JitterFilter`), a 10 Hz DC block, then `edge × derivative + pressure × (air × lowpassed noise + (1 − air))`. The derivative is what a pipe end radiates and carries the tone; the noise term is the turbulence that makes it breathe. Engine-sim runs almost pure derivative (`dF_F_mix = 0.01` of a `/dt` derivative is a ×440 weight), we keep `edge` per layout.
5. **Leveler and loudness.** A power follower sets a slow gain so the raw voice sits at the same RMS at idle and at the redline, whatever the train's crest factor; the voice applies load, rpm and distance on top. Equal RMS is not equal loudness (a bright six with throttle bodies reads louder than a smeared turbo at the same RMS), so `buildProgram` measures each program through a model of the main thread chain (`estimateLoudness`: the spectra of 0.12 s of both tips at 3500 rpm full throttle times the silencer response, the presence peak and the top roll-off, plus the intake and body through their bands, K-weighted as LUFS does since A-weighting discounts the bass an engine lives in; about ten milliseconds, once per voice) and sets `trim` so every program lands on `LOUDNESS_REF`. Nothing is hand levelled: a new layout, silencer or intake is matched the moment it exists, and `tests/engineVoice.test.ts` runs the full chain with the real convolution to check the cars stay within 2 dB and none is mono. The chain's numbers (`CHAIN`) live in `engineSynth.ts` so the model and the nodes cannot drift apart.
6. **Tailpipes.** Every voice renders two tips, left and right. A twin pipe car (`pipes: 2`) puts a bank on each, with the second pipe 5 cm further: summed in mono the two banks' trains would otherwise cancel exactly (the chain is linear), which real cars avoid because you hear two tailpipes and they are never equal. A single exhaust sends the one train through two tips with their own turbulence and jitter and a 0.3 ms path difference, so it is as wide as a twin pipe car instead of a mono point. Heard from one pipe a cross-plane V8 bank measures +2.5 dB uneven, a flat-plane bank −14 dB, an inline six's three −21 dB.
7. **Silencer.** The sum is convolved (`ConvolverNode`) with an impulse response we render ourselves (`renderImpulse`): a unit direct path, the pipe column's half wave modes for the system length, the silencer chamber and a tailpipe ring for sporty ones as resonances given by Q and their boost over the direct path (a decaying sine of amplitude A and time constant τ has gain Aτ/2 at its frequency, so amplitudes are tiny and a +6 dB mode is a +6 dB mode), and a diffuse noise tail sized by its energy against the direct path. The first version sized the sines like impulses, which made every mode a +40 dB peak that sub-harmonic content lit up at random; levels only became predictable once the modes were physical. Engine-sim ships recorded responses; ours are synthesized so everything stays runtime generated and nothing of theirs is redistributed.
8. **Intake and body.** The worklet also renders the intake (a softer pulse half a cycle from the exhaust one, scaled by throttle^1.5, through a trumpet band pass on the main thread: individual throttle bodies honk, a plenum murmurs) and the valvetrain tick (a 1.5 ms noise burst at each firing, loudest with the throttle closed).
9. **Events.** The sim's gear change cut (`shiftTimer`) zeroes the load; rpm pinned at the redline with the pedal down turns the limiter on; overrun pops come from the model below.

### Overrun pops and the exhaust flash

Real pops are unburnt fuel lighting in a hot exhaust, so the voice keeps two states (`OVERRUN` in `engineAudio.ts`) and the sim knows nothing about them:

- **Heat** rises under load at revs with a 4 s time constant and cools over 20 s. A cold engine barely pops on the overrun; one that has been driven hard does.
- **Fuel** is dumped into the pipe on a lift from above 45 % of the redline, the amount rising steeply with how high the lift was (and ×1.3 for a turbo running rich under boost); it burns off over 1.2 s, and the pedal takes it back in 0.15 s.
- **Three ways in.** On the limiter (rpm within 150 of the redline with the pedal down, which the sim holds in top gear and the garage bounces on) the cut dumps mixture every few firings: a stream of 3 to 9 events per second by silencer, mostly crackles. A high rev upshift's cut pops with chance `0.35 × freedom × heat`. On the overrun the chance is `pops × 0.45 × fuel × heat × dt` per second, where `pops` is the silencer's freedom (quiet 0.3, sport 1.2, straight 2.5, turbo ×0.6): a hot sport car pops on roughly a quarter of its lifts from the top, rarely from half revs, a quiet turbo car one in twenty. 45 % of overrun events are a single bang (a 40 ms crack with a 90 Hz thump), the rest a burst of two to four crackles 30 to 80 ms apart.
- Pops join the exhaust **after** the leveler at their own peak (about 0.12 a crackle, 0.27 a bang, against a levelled tip's 0.05 RMS; soft clipped), so the leveler cannot duck them and they read the same whatever the engine is doing; the silencer response still colours them (its pipe modes lift the bang's thump, which is why the thump is kept small). Measured at the bus a bang peaks about 6 dB over the engine's own peaks.
- The same event fires the sound in the worklet (`port.postMessage({ pop })`, `EngineSynth.pop`) and `EngineVoice.onPop`, which the race session and the garage route to `CarView.popFlash`: an orange additive cone at that tailpipe (the nitrous flame's position) that bursts out and dims over 70 ms for a crackle, 160 ms for a bang. No light is added (a new point light would recompile every lit material); the flash is emissive only.

### Grain

Three things made the first version hiss above 4 kHz, and all were sources rather than something to filter: the valvetrain tick fired a highpassed noise burst at every firing (350 a second for a six at 7000 rpm, a continuous crackle), so it now fires at most every 25 ms and fades out by three quarters of the redline; the jitter noise was nearly white (engine-sim's 10 kHz cutoff), so the wander is now band limited to 600 Hz and reads as the pipe moving; and the turbulence noise was 2 kHz wide, now 1.2 kHz. The pulse wavetable went from 2048 to 8192 entries so the derivative of its interpolation no longer steps at idle. On top of that the voice rolls off above 6.5 kHz (`VOICE.top`), since nothing but grain lives there. Decel is only 3 dB under full throttle now (`0.7 + 0.3 × load`) and the leveler recovers in 0.15 s after a lift, so the overrun, where the pops and the silencer are heard, no longer drops away.

Everything is deterministic from a seed (xorshift); each voice gets its own seed so rivals never phase lock with the player. Rivals run a `lite` program: half the silencer response, no intake or valvetrain.

Cost, measured headless at 48 kHz in Node: 5 to 13 ms of CPU per second of audio per voice (about 1 %), on the audio thread, not the frame. The convolution is native. Four voices in a race are well inside budget on a laptop; phones have not been measured yet.

## Data

The manifest's `engine` block gained an optional `voice` (vocabulary in `src/shared/carSpec.ts`, validated by `npm run validate` and the tests):

| Field | Values | What it changes |
|---|---|---|
| `headers` | `equal`, `unequal` | Unequal: the second bank's primaries run `headerSpread` further, so its pulses arrive late and weaker (the boxer rumble, the VR6 growl). |
| `headerSpread` | 0 to 1 (m) | How much further, with unequal headers. Defaults: 0.5 (a boxer's crossover under the engine), 0.3 for a VR6. |
| `pipes` | `1`, `2` | Two keeps each bank, or each half of an inline six, on its own pipe, so uneven per bank patterns reach the tailpipe. |
| `crossover` | `none`, `h`, `x` | Between twin pipes: an H-pipe hands 20 % of each bank's pulse to the other pipe, an X-pipe 45 %, evening out the per pipe pattern (smoother, raspier); nothing with one pipe. |
| `muffler` | `quiet`, `sport`, `straight` | System length, band limit, pops per lift, and the impulse response (long low modes vs short bright ring). |
| `intake` | `plenum`, `itb` | Throttle bodies: a loud resonant honk that follows the pedal. |
| `crank` | `cross`, `flat` | V8 only: cross-plane banks fire 180-270-180-90 (burble), flat-plane 180-180-180-180 (scream). |

Defaults by layout are `LAYOUT_VOICE`; turbo engines default to the quiet silencer, the rest to sport.

Per-car donor data (engine, intake, exhaust, drivetrain, sound character and the voice fields to use): [carEngines.md](carEngines.md).

## The garage engines

### Wendt Strom: VW VR6, naturally aspirated (Golf R32 Mk4)

- Reference: 3.2 l VR6 (BFH/BDB), 15° narrow V sharing one head, firing order 1-5-3-6-2-4, 84.0 x 95.9 mm, 24 valves with variable cam timing, 10.9 to 11.3:1, Bosch Motronic ME 7.1.1. One manifold per three cylinders but runners of two lengths, as the narrow V staggers them.
- The sound: even 120° firing, but odd cylinders sit on one side of the narrow V, so 1-5-3-6-2-4 fires three from one side and then three from the other. The far side's runners reach round the V and run longer, so its three pulses arrive late and weaker: a beat once a cycle under the six's even note, the hollow, gravelly growl the VR6 is known for (the "Chewbacca" sound). The runners are also staggered within a side (`stagger`). No turbines, so the pulses stay sharp.
- Spec: `VR6`, `na`, `voice: { headers: 'unequal', headerSpread: 0.35, pipes: 1, muffler: 'sport' }` (the R32's twin centre tips come from one system). The far side's pulses arrive 1.0 ms late at about 0.7 of the gain.
- Still to add: tune `headerSpread` and `stagger` against a recording of the R32, and the intake honk of its large plenum from 4000 up.

### Kazama Rotor: Mazda 13B-REW twin rotor, sequential twin turbo (RX-7 FD)

- Reference: 1308 cc two rotor Wankel, sequential twin turbos (the secondary joins near 4,500 rpm), 9.0:1, redline 8,000. Each rotor fires once per eccentric shaft turn, so two rotors fire as often as a four cylinder at the same rpm, but evenly and with no valvetrain.
- The sound: a smooth, high buzz from even firing and short exhaust ports, rounded by the turbines; the brap at idle comes from port overlap.
- Spec: `R2`, `turbo`, `voice: { pipes: 1, muffler: 'sport' }`.
- Still to add: the idle brap (port overlap as a rough, slow lope at low rpm), the secondary turbo's step near 4,500 rpm, and the rotary's metallic ring at high rpm.

### Brandt Kombi: Audi 2.2 20V turbo inline five (S2 Avant donor)

- Reference: the 2,226 cc 20 valve turbocharged inline five of the 1992-95 Audi S2 (engine codes 3B, then ABY from October 1992: 230 PS / 169 kW at 5,900 rpm, 350 N·m from 1,950 to 3,000 rpm), one KKK K24 turbo on a short log manifold, firing order 1-2-4-5-3, quattro with a Torsen centre differential and the 01E six speed. Sources: Wikipedia's Audi S2 (the 2,226 cc five, codes 3B and ABY, 230 PS and 350 N·m with 380 N·m on overboost, 246 km/h) and a catalogue listing of the ABY at 230 PS / 5,900 rpm and 350 N·m / 1,950 rpm; the 01E ratios are the RS2's (CRB) 3.500 / 1.889 / 1.320 / 1.034 / 0.857 / 0.711 on the 4.111 final drive, the S2's CGR box being listed with the same (forum sources disagree on its fifth and sixth).
- The sound: even 144° firing, but the five's runners are not alike (the short, position dependent log manifold feeding the turbine gives each cylinder its own path), so the pulses reach the pipe with a slow uneven pattern: the warble of an Audi five, rather than a header spread. The headers stay `equal`. One turbine smears the pulses, and the stock S2 has one exhaust system ending in twin tips, so the voice is one pipe (`pipes: 1`, two tips rendered from the one train) behind the quiet (turbo default) silencer.
- Spec: `I5`, `turbo`, `voice: { headers: 'equal', pipes: 1, muffler: 'quiet' }`. The `I5` program (`SCHEDULE.I5` is 1-2-4-5-3 at 0.2 cycle steps, `LAYOUT_VOICE.I5` adds `rough` and the runner `stagger`) needed no change.
- Still to add: tune `stagger` against a recording of an S2 or RS2, and the K24's whoosh band.

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
| Supercharged | Shelby GT500, Hellcat, Demon | Roots / twin screw whine at a fixed ratio of crank speed (x2.5 to x3.4) with lobe harmonics | Done (`BLOWER` in `engineAudio.ts`): rpm-locked partials at rpm / 60 x `blowerRatio` x `blowerLobes` plus an air rush band, loud with `boost` and the pedal, faint with the bypass open; no lag. The Ridgeway Fiend is the first (4 lobes, 2.5, 21.3 psi) |

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
