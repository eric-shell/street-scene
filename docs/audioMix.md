# The audio mix

How every sound in the game is balanced against the others, what the player can set, and how the balance is kept as sounds are added. Code: `src/audio/engineAudio.ts` (`AudioHub`, the mixer: buses, calibration, levels, the limiter), `src/audio/sfx.ts` (the effects and the world's voices, with their levels at the top of the file), `src/audio/uiSound.ts` (menu sounds), `src/audio/musicPlayer.ts` (music, on its own element). Guard: `e2e/audioMix.spec.ts`. The engine voices themselves are in [engineSound.md](engineSound.md).

## Buses and settings

```
engine    ─┐
effects   ─┤
ambience  ─┼─ master ─ limiter ─ out
interface ─┘
music (an <audio> element, its own volume)
```

| Bus | What is on it | Setting |
|---|---|---|
| engine | every `EngineVoice` (player and rivals) | Engine |
| effects | impacts (car, wall, barrier, rail, props), scrapes, nitrous, horn, countdown beeps, fireworks | Effects |
| ambience | crowd beds and cheers, train rumble, helicopters, thunder, the crossing bell | Ambience |
| interface | menu ticks, presses, blips, whooshes, the wipe, the garage door | Interface |
| master | the four above | Master |
| music | the player | Music (in the player and here) |

A slider maps to gain by its square. Each bus also carries a fixed calibration (`MIX.calibration`) that sets where it sits with every slider at its default, so the defaults *are* the intended balance and a slider only moves away from it. The interface bus was once calibrated 6 dB under the rest, which left every menu sound buried under the menu music; it now sits with the others, and the menu sounds are set by peak against the music instead. The old single "Engine volume" slider, which scaled every synthesized sound, becomes the Master on first load after the change (the engine itself goes to full), so nobody's chosen loudness jumps.

The master ends in a limiter (threshold −3 dBFS, 20:1, 2 ms attack), not a musical compressor. Before, everything went through one 4:1 compressor at −18 dBFS that the engine alone drove 5 dB into, so a loud engine ducked every effect and a crowd could duck the engine; with the sources gain staged against each other the limiter only has to catch a crash, a cheer and a bang landing together.

## The balance

Measured at the output with every level at its default, each source alone and right at the listener (`e2e/audioMix.spec.ts` prints this table and holds every line to its target). The player's engine at full throttle is the reference; the music line is the track's RMS through the player's default slider.

| Source | Before (dBFS RMS) | Now | Target | Why |
|---|---|---|---|---|
| engine, full throttle | −19 | −19 | −19 | the reference, 8 dB over the music |
| engine, idle | −25 | −25 | −25 | |
| garage engine, showroom idle | −26 | −36 | −36 | a burble under the menus, 10 dB under the music |
| garage engine, showroom rev to 6800 | −16 | −16 | −16 | the swell is the point |
| garage engine, Street view cruise | −21 | −30 | −30 | a hum under the music, not a drone over it |
| garage engine, Street view rev to 6800 | −18 | −17 | −17 | swells 13 dB over the cruise |
| music (player default 0.6) | −26 | −26 | −26 | sits under the engine, the player's slider moves it |
| car crash 20 m/s | −19 (peak −13) | −14 (peak −5) | −13 | the hardest hit tops the engine's peaks |
| car crash 8 m/s | −24 | −19 | −18 | a tap stays under the engine |
| wall slam 15 m/s | −16 | −10 | −11 | the biggest impact there is |
| rail scrape hit 10 m/s | −22 | −19 | −17 | |
| dumpster 15 m/s | −17 | −16 | −16 | |
| garbage can 12 m/s | −23 | −21 | −20 | |
| bush 12 m/s | −30 | −27 | −25 | leafy, quiet by design |
| countdown beep / go | −19 | −15 | −15 | heard over an idling grid |
| firework (close) | −21 | −15 | −14 | a distant crash |
| horn | −24 | −18 | −18 | cuts through the engine |
| nitrous | −30 | −21 | −21 | just under the engine, it was buried |
| crowd bed (adjacent stand, full) | −14 | −26 | −24 | it was louder than the engine |
| crowd cheer (finish, beside you) | −12.5 (peak −1) | −20 | −21 | it drowned the finish |
| train rumble (at the tracks) | −24 | −24 | −24 | a bed |
| helicopter (overhead) | −30 | −27 | −28 | a bed |
| thunder, 200 m | −11 (peak −2) | −19 | −18 | level with the engine, the loudest thing it should be |
| thunder, 1800 m | −13 | −25 | −25 | it was as loud as near; the distance curve now falls to a tenth at three times `near` |
| crossing bell | −25 | −24 | −24 | |
| menu press (peak) | −31 | −15 (RMS −32) | −32 | a click peaks over the music's −26; short sounds read low as RMS |
| menu hover tick (peak) | −44 | −28 (RMS −48) | −48 | under the press, so sweeping a list is not a rattle |
| menu step whoosh (peak) | −40 | −19 (RMS −32) | −32 | |
| garage door up / down (peak) | −38 / −20 | −17 / −9 | −32 (up) | the rattle was 18 dB under the clunk and lost under the music |

What was wrong before: the crowds and thunder were set hotter than the player's own engine, nitrous and the horn were set so low the engine covered them, the countdown beeps barely cleared an idle, and the shared compressor let whichever source was loudest duck the rest. Every number had been chosen on its own; none against the engine.

Two things to know when setting a level: a centred mono source loses 3 dB in its `StereoPannerNode` (equal power), while the engine voices and the stereo crowd clips do not, so mono effects need that much more; and the impact banks are rendered to a 0.95 peak, so their loudness differs by material (a wall slam's 50 ms hit is twice a bush's), which is the intent.

## Keeping it consistent

- A new sound goes on the bus that matches what it is, with its level set against the engine's −19 dBFS RMS using the table, then gets a line in `TARGETS` in `e2e/audioMix.spec.ts` so the next change cannot move it unnoticed. Run `npm run e2e -- e2e/audioMix.spec.ts` (about a minute; it prints the table).
- The spec plays each source on a synthetic page that imports the audio modules straight from Vite, so it works even when a screen is broken. It taps the node a source really feeds: a dynamic `import()` in the page can get its own module instance with its own `AudioContext`, and a tap on that hub hears nothing.
- The garage's engine (showroom and Street view) gets its level from `revVoice` in `src/garage/revModel.ts`: quiet at the engine's rest rpm, swelling with the revs (and a little ahead of them with the pedal) to full at the redline. The table in `REV_LEVEL` sets the rest and top levels per presentation; the spec measures all four through that same function.
- The engine voices are matched to each other separately (every program is trimmed to one K-weighted loudness, see engineSound.md); this table only sets where the engine bus sits.
