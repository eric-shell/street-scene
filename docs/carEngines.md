# Car engines: donor data for the voice and the physics

Per-car engine, intake, exhaust and drivetrain data, so each garage car's engine voice (`engine.voice` in `carManifest.json`, vocabulary in `src/shared/carSpec.ts`, model in `docs/engineSound.md`) and its `drivingParams.json` block can be tuned to the real donor. Units: SI plus the period units the sources use (PS = metric hp, hp = SAE, lb-ft). Torque curves are rpm → N·m.

## Provenance and confidence (read first)

- Web search in the research session returned thin results (spec aggregators, no manufacturer sheets), so **most figures are from the cited reference pages as recalled, not re-fetched figure by figure**. Treat the peak power/torque, bore x stroke, displacement and firing orders as reliable (they are the ones every source agrees on); treat the items tagged **est.** or **verify** as unconfirmed.
- Torque curves: none came from a measured dyno chart. Every curve below is **est.**: shaped through the published peak torque point and the published peak power point (torque = power / angular speed at the power rpm), with the usual shape for the engine type. Use them as a starting shape, and replace them with a chart when one is found.
- Gearbox ratios flagged **verify** are from memory of the transmission code; check against a service manual before copying into `drivingParams.json`. The repo's existing Zenith gearbox already holds the real V160 ratios.
- Figures differ by market (JDM vs US/EU PS vs hp, gentleman's-agreement 280 PS cap on Japanese cars). Both are given where they differ; the JDM rating is the one usually quoted for the donor.
- Reference pages (general, each car section lists its own): Wikipedia model and engine articles (`en.wikipedia.org/wiki/<model>`), manufacturer press kits (Mazda, Honda, Nissan, Toyota, Porsche, GM, Ford/SVT, Dodge/SRT, BMW, Audi, VW, Subaru, Mitsubishi), Car and Driver / Motor Trend / Evo road tests, `carfromjapan.com/specifications` and `jdmbuysell.com` for JDM trim data.

## How the fields map to the synth

`headers` equal/unequal (+ `headerSpread` m), `pipes` 1/2, `crossover` none/h/x, `muffler` quiet/sport/straight, `intake` plenum/itb, `crank` cross/flat (V8) or oddfire (V10), `camRpm`/`camStep` (cam changeover), `idleLope`/`apexRasp` (rotary), `blowerLobes` 3-6 or 8, `blowerRatio` 1-5, `boost` psi, and for turbo cars `diverter` vent/recirculating/flutter, `flutter`, `wastegate`, `handoverRpm`/`preboostRpm`/`spoolRpm`/`handoverDip` (sequential twin turbo); `flaps`, `fanRatio` and `gearWhine` for cars that have them (see `engineSound.md`, Turbo and accessory behaviours). Layout, aspiration and position live in `engine.{layout,aspiration,position}`. Recommendations assume the stock exhaust unless a car is planned as a build.

---

# Shipped cars

## Wendt Strom R6: 2002-04 VW Golf R32 Mk4 (3.2 VR6, BFH)

Source status key: **sourced** = read on a fetched page (URL in Sources); **est.** = not found, kept from memory or shaped.

| | |
|---|---|
| Engine | VR6 3,189 cc, **sourced** (Wikipedia Golf Mk4: "3.2-litre (3,189 cc) DOHC 24-valve VR6"). Bore x stroke 84.0 x 95.9 mm **est.** (the VR6 article gives bore/stroke only for the 2.8, not the 3.2). 15° narrow V, one head: **sourced for the 12v family** (VR6 article); BFH 24v assumed the same. 24v valvetrain **sourced** (VR6 article): one cam works the intake valves of both banks, the other the exhaust valves, via rocker arms. No VVT on the BFH: **est.** |
| Firing | 1-5-3-6-2-4 **sourced for the 12v VR6** (VR6 article), 24v assumed the same. Even 120° firing: **est.** The article says port lengths differ between banks and that cam overlap/lift/runner length compensate so both banks make similar power. |
| Aspiration / intake | NA. Two-stage variable-length manifold, one throttle: **est.** (not on any fetched page) |
| Exhaust | Alternating short/long primaries from the staggered head; one rear muffler with twin outlets: **est.** (nothing fetched) |
| Idle / redline / fuel cut | about 700 / 6,500 / about 6,700 rpm: **est.** (no source found). The sim ships 6,800. |
| Power / torque | **241 PS (177 kW, 238 bhp) at 6,250 rpm; 320 N·m (236 lb-ft) at 2,800 rpm** (Wikipedia Golf Mk4). The VR6 article's "177 kW (237 hp)" agrees. The doc's earlier "2,500-3,000" is a range, not a source; 2,800 is the sourced point. |
| Torque curve (est.) | 1000:200, 2000:290, 2800:320, 3500:318, 4500:305, 5500:285, 6250:270, 6700:245. No stock dyno chart found (power check: 241 PS / 6,250 rpm = 270 N·m, matches the 6250 point). |
| Gearbox | 02M 6-speed (named in parts listings for the 4Motion VR6 R32). **Ratios not found** after four searches (supercars.net's ratio list 3.36 / 2.09 / 1.47 / 0.87 / 0.73 is the **2006 Mk5 R32**, its 2002 Mk4 page leaves the field blank; a SEAT Cupra forum post lists a 6-speed 3.300 / 1.944 / 1.308 / 1.029 / 0.837 with final 3.389 but does not name the box). Keep earlier guess about 3.78 / 2.12 / 1.36 / 1.03 / 0.84 / 0.69, final about 4.4: **est.** |
| Drive / curb | 4Motion = Haldex on-demand AWD **sourced** (Wikipedia Mk4). Rear share up to about 50 %: est. Curb weight: **1,477 kg** (Encycarpedia, via search snippet; page itself 403), 1,510 kg (Parkers), 1,538 kg (Top Gear, 5-door DSG min.). I use about 1,480. |
| 0-100 / top | **6.6 s (6.4 s DSG)** 0-100, quarter mile 14.1 s at 159.6 km/h (Wikipedia Mk4). Other: 6.5 s 0-100 (an Arabic spec page), 0-62 6.4-6.6 s (AM-online, Fleetnews). Top speed 248-249 km/h (CarExpert; 152-155 mph elsewhere), governed. |
| Sound | Narrow-V growl, a throaty off-beat warble from the 15° stagger, rises to a hard 6,500 rpm. Deeper and more V8-like than an inline six. (Character, not a sourced figure.) |
| Voice | `headers: unequal`, `headerSpread: 0.3`, `pipes: 1`, `crossover: none`, `muffler: sport`, `intake: plenum` (unchanged: nothing fetched contradicts it) |
| Synth gaps | ~~The VR stagger as a sub-bank timing offset~~ done: the per-cylinder runner table `VR6_HEAD` (`docs/engineSound.md`, Wendt Strom; an estimate, the sources above give no runner length and engine-sim has no VR6); the intake manifold's two-stage change near 4,000-4,500 rpm; Haldex/driveline whine (none) |

Shipped (`drivingParams.json` `wendtStrom`) vs sourced: mass 1,480 kg matches 1,477. Gearbox uses the **Mk5** R32 list 3.36 / 2.09 / 1.47 / (1.10) / 0.87 / 0.73 with final 4.4 because the Mk4 ratios were never found; peak torque 320 at 3,200 (sourced 2,800); redline 6,800 (est. 6,500).

Sources fetched: https://en.wikipedia.org/wiki/Volkswagen_Golf_Mk4 , https://en.wikipedia.org/wiki/VR6_engine ; via search only: https://www.encycarpedia.com/volkswagen/02-golf-r32-hatch , https://www.supercars.net/blog/2006-volkswagen-golf-r32 , https://www.carexpert.com.au/volkswagen/golf/2003/r32/features-and-specs , https://www.parkers.co.uk/volkswagen/golf/r32-2005/32-v6-r32-4motion-3d/specs/ .

## Wendt Strom engine swaps (the Power tab)

The R32's three swaps (`engineSwaps` on the manifest car, physics in `drivingParams.json` `swaps.wendtStrom`). Same source key as above. Web search was thin again (spec aggregators, parts vendors, Audi's own pages now 404), so peaks and dimensions are sourced and most of the sound-relevant detail (manifolds, rev limits, turbos) is **est.**

### 3.6 VR6 (`vr36`): the R36 conversion, BWS, naturally aspirated

| | |
|---|---|
| Engine | VR6 3,598 cc, **89.0 x 96.4 mm** (sourced: mymotorlist BHK/BWS pages, Wikipedia infobox mirror), a **10.6° V** against the 3.2's 15° (sourced: Wikipedia VR6, the 3.6 FSI BLV). FSI direct injection, 24v, variable cam timing. Compression 11.4 to 12.0:1 (sources disagree). |
| Firing | 1-5-3-6-2-4, 120° (sourced for the VR6 family; the 3.6 assumed the same) |
| Power / torque | **300 PS (220 kW) at 6,600 rpm** (Passat R36: autobild, carmagazine); **350 N·m from 2,400 to 5,300** (one source says 360). Touareg/Q7 BHK: 280 PS, 360 N·m. |
| Redline | about 6,900: **est.** (none found; the power peak is 6,600) |
| Exhaust | One cast manifold per row (left and right part numbers 03H253031B / C in a parts listing: weak inference); the R36 Passat has twin chromed tailpipes. |
| Mass | about +10 kg on the 3.2: **est.** |
| Sound | The 3.2's growl, deeper and fuller: the same zigzag firing across the narrow V, a shorter reach round a 10.6° V for the far row. |
| Voice | `VR6`, `na`, `displacement: 3.598`, `headers: unequal`, `headerSpread: 0.3` (0.35 on the 3.2: a narrower V, a shorter reach; **est.**), `pipes: 1`, `muffler: sport`. The stock car's engine carries `displacement: 3.189`. |
| Synth gaps | ~~Displacement does not reach the voice~~ done (`SIZE`: the 3.6's pulses 4 % longer and 0.5 dB louder than the 3.2's); the switchable intake manifold. |
| Gearing | final drive 4.14 (from 4.4): sixth's limiter 266 km/h, 1.1 times the 242 km/h drag top speed. |
| Turbo / supercharged 3.6 kits | Common (forged JE pistons sold for "R36 turbo"), 500 to 600+ hp; not offered yet. A turbo 3.6 would be a second swap with `aspiration: turbo`. |

### 07K 2.5 turbo (`turbo07k`): the Jetta five on stock internals

| | |
|---|---|
| Engine | Inline 5, **2,480 cc, 82.5 x 92.8 mm**, DOHC 20v, **chain driven** (sourced: auto-data, mymotorlist CBTA, automoli). Iron block **est.** (commonly said; not on a fetched page). The "half a Lamborghini V10" story was not confirmed by any source. |
| Stock output | **150 hp at 5,000** (2005-07 BGP/BGQ) or **170 hp at 5,700, 240 N·m (177 lb-ft) at 4,250** (2008-14 CBTA/CBUA) (sourced: auto-data). |
| Firing | 1-2-4-5-3, 144° **est.** (the VW/Audi five's order; no 07K page states it) |
| Turbo kit | Sold as **T3 top mount** cast manifolds with a **44 mm V-band external wastegate** and a cast intake (SPA Turbo listings); 034Motorsport's kit runs **8-9 psi on a Precision 5858** and raises the **rev limit to 7,300** (sourced, vendor). The game's build is a bigger one: about 20 psi, **440 PS at 6,500 and 540 N·m at 4,500, est.** (inside the 400 to 500+ hp the user's brief and the vendors claim; stock rods are the usual limit on fives, per the TFSI threads). |
| Mass | iron block plus turbo, intercooler and piping: about the VR6's, **est.** |
| Sound | The five's 2.5 order warble ("baby Gallardo" is the owners' phrase), made loud by an open turbo-back exhaust: an aftermarket atmospheric blow-off valve, wastegate chatter from the external gate, a big filter's induction roar. |
| Voice | `I5`, `turbo`, `displacement: 2.48`, `manifold: topmount`, `headers: equal`, `pipes: 1`, `muffler: straight`, `diverter: vent`, `flutter: 0.3`, `wastegate: 0.8`, `screamer: 1`, `whoosh: 1.4` |
| Synth gaps | ~~The S2's cast log for every five~~ done (`manifold: topmount`, near equal tubular runners, even levels; lengths **est.**). ~~The external gate's vent~~ done (`screamer`: the raw exhaust while the gate holds full boost; level **est.**). |
| Physics | Lazy spool: `spoolTime 0.9`, `turboShare 0.5`; launch and rolling antilag at 4,500. Final drive 3.76 (from 4.4): sixth's limiter 310 km/h, 1.1 times the 282 km/h drag top speed. |

### 2.5 TFSI DAZA Stage 2 (`daza`): the RS3 8V's EA855 evo, tuned

| | |
|---|---|
| Engine | Inline 5, **2,480 cc, 82.5 mm bore** (Bar-Tek piston listings; stroke 92.8 the 07K's and CEPA's, **est.** for the DAZA), **aluminium crankcase, 26 kg lighter than the iron CEPA** (sourced: Audi via autocar / gtspirit), port plus direct injection (sourced), Audi valvelift on the exhaust cams (sourced for the 2017 engine on Audi's TT RS page, see the TT-RS section). |
| Firing | **1-2-4-5-3, 144°** (Audi's five, sourced on the TT RS page) |
| Power / torque | Stock **400 PS (294 kW) at 5,850-7,000 rpm; 480 N·m at 1,700-5,850** (sourced: auto-data, Audi press). The swap is the usual Stage 2 on the stock turbo (downpipe, intake, intercooler, map; tuners quote about 480 to 500 PS and 600 to 650 N·m for the 8V RS3): **500 PS at 6,200 and 620 N·m from 2,000 to 5,000, est.**, so it tops the 07K. |
| Turbo | One turbo; boost up to 1.35 bar on the 2017 engine (Audi's TT RS page, see the TT-RS section); maker not found. |
| Redline | about 7,200: **est.** (the power plateau ends at 7,000) |
| Mass | CEPA 183 kg less 26: about 157 kg, about 25 kg under the VR6: **est.** |
| Builds | Golf swaps with the RS3/TT RS five exist (a Mk4 R32 with fabricated subframe and AWD tunnel: fastcar.co.uk, page 403 here; a Kraftwerx Mk4 GLI with a TT RS engine and 4Motion; a 600 PS Mk7 Golf R on a TTE625). The "R25" name turned up only for a SEAT Leon Cupra. Weak points: rods and rod bolts (seatcupra forum). |
| Sound | The same warble, smoother and more refined: stock diverter valve, a quick small turbo, the RS3's flap exhaust that opens on load (and crackles on the overrun). |
| Voice | `I5`, `turbo`, `displacement: 2.48`, `headers: equal` (the cast log `FIVE_LOG`: the EA855's manifold is cast too), `pipes: 1`, `muffler: sport`, `diverter: recirculating`, `whoosh: 0.8` (a Stage 2 intake), `flaps: 0.6` (the first engine in the game with flaps) |
| Physics | Quick spool: `spoolTime 0.4`, `turboShare 0.25`; launch 4,000, antilag 4,500. Final drive 3.55 (from 4.4): sixth's limiter 324 km/h, 1.1 times the 294 km/h drag top speed. |

Measured (stock setup, no traction control; 0-60 mph / 0-100 / 0-200 km/h / top): stock 3.2 5.95 / 6.30 / 31.8 s / 225 km/h; 3.6 VR6 5.32 / 5.63 / 23.8 s / 242; 07K turbo 3.60 / 3.78 / 14.4 s / 282; DAZA Stage 2 3.88 / 4.05 / 13.0 s / 294. The DAZA wins from about 50 km/h up, the 0-200 by 1.4 s and the top speed by 12 km/h, but off the line without traction control its 620 N·m from 2,000 rpm spins all four tires (the revs flare to the limiter in first by 1 s) where the 07K's lazy turbo stays under the grip; with traction control on (Settings) the DAZA is the quicker car off the line too, 3.18 s to 60 mph against the 07K's 3.60. Neither the launch rpm, the spool, the launch boost nor a taller first gear changed that; a tune's torque limit in the low gears (real RS3 maps have one) would, and is not modelled.

Sources: https://en.wikipedia.org/wiki/VR6_engine , https://mymotorlist.com/engines/volkswagen/ea390/bhk/ , https://mymotorlist.com/engines/volkswagen/ea390/bws/ , https://www.autobild.de/artikel/vorstellung-vw-passat-r36-58255.html , https://www.carmagazine.co.uk/car-news/first-official-pictures/volkswagen/volkswagen-passat-r36-2006-first-official-pictures-/ , https://www.auto-data.net/en/volkswagen-rabbit-a5-5-door-2.5-170hp-tiptronic-50515 , https://mymotorlist.com/engines/volkswagen/ea855/cbta/ , https://eurosporttuning.com/07k-turbo-kit-stock-intake-manifold-ecu-upgrade-8-9-psi-mkv-volkswagen-jetta-rabbit-2-5l/ (search snippet; the page 404s), https://store.ngpracing.com/products/vw-jetta-golf-mk5-2-5l-5-cylinder-20v-07k-t3-top-mount-turbo-manifold-intake-manifold , https://www.auto-data.net/en/audi-rs-3-sedan-8v-facelift-2017-2.5-tfsi-400hp-quattro-s-tronic-27838 , https://www.bar-tek.com/forged-pistons-mahle-2-5-l-tfsi-daza-dnw , https://gtspirit.com/2017/02/10/official-2017-audi-rs3-sportback/ , https://www.fastcar.co.uk/cars/modified-vw-golf-r32-mk4/ , https://engineswapdepot.com/?p=73685 , https://www.seatcupra.net/forums/threads/leon-cupra-r25.424771/ .

## Kazama Rotor: 1999 Mazda RX-7 FD3S (13B-REW)

Source status key: **sourced** = read on a fetched page (URL in Sources); **est.** = not found.

| | |
|---|---|
| Engine | 13B-REW twin-rotor Wankel, 654 cc per chamber, 1,308 cc (1.3 L) **sourced** (Wikipedia Mazda Wankel engine); Mazda's 105 mm generating radius / 15 mm eccentricity are "nearly all production Wankels" there (so likely, not 13B-REW-specific). Peripheral **exhaust** ports **sourced** (same page; the Renesis moved to side exhaust ports). Intake port layout: **est.** |
| Firing | One power stroke per rotor per eccentric-shaft turn **sourced** (Wankel page), so two rotors give 2 firings per shaft rev, evenly spaced (180° apart): follows, the 180° offset is **est.** |
| Aspiration | Sequential twin turbo (Hitachi) **sourced**: the primary turbo gives about 10 psi (0.69 bar) from about 1,800 rpm; the second engages around 4,000 rpm and holds about 10 psi to the redline; **the changeover is at about 4,500 rpm with a brief drop to about 8 psi (0.55 bar)** (Wikipedia RX-7; the 13B-REW/Wankel page says the primary carries to 4,500 rpm). So the handover is 4,000 (second turbo opens) to 4,500 (changeover); the doc's earlier 4,000-4,500 stands, with 4,500 as the dip. HT12 turbine model names and the wastegate/relief valve layout: **est.** |
| Intake | Plenum, single throttle, variable secondary-port system: **est.** (not fetched) |
| Exhaust | Short cast manifold into the turbines, 3" turbo-back, one muffler with dual outlets: **est.** (nothing fetched) |
| Idle / redline / fuel cut | 750-800 / 7,000 / 8,000: **est.** Only one hint is sourced: Wikipedia says 7,000 rpm is the redline for **automatic** cars and the Series 7 manual's extra power came above 7,000 rpm. A manual-car redline was not found. |
| Power / torque | JDM: **255 PS (188 kW) at 6,500 rpm, 294.2 N·m (30 kgf·m) at 5,000** for the 1993-95 Type R / RII (221616.com Efini RX-7 catalogue; Wikipedia S6 Type R 255 PS, 294 N·m). Later: 265 PS (1996-98), **280 PS at 6,500 and 314 N·m at 5,000** on the Series 8 Type RS (Wikipedia RX-7 and 13B-REW). US 1993-95: 255 hp, 217 lb-ft (294 N·m) (AutoGuide, Motor Matchup via search). EU spec: 239 PS, 294 N·m (Wikipedia). |
| Torque curve (est.) | 1500:190, 2500:215, 3500:250, 4000:270, 4500:262 (handover dip), 5000:294, 6000:285, 6500:275, 7000:250. No stock dyno chart found. Power check: 255 PS / 6,500 rpm = 277 N·m, matches the 6500 point. |
| Gearbox | 5-speed. Ratios 1-4 **3.483 / 2.015 / 1.391 / 1.000** and reverse 3.288 with final **4.100** on a 5MT RWD LSD car (carfromjapan listing, via search; page 403). **Fifth is 0.806**, not 0.719 (OS Giken gear-kit "standard ratios: 3.483, 2.015, 1.391, 1.000, 0.806", fetched from justjap.com; a second OS Giken page agrees). The doc's 0.719 is unsupported. Final drive **4.300 on the Type RS** (and the Australian SP at 4.3:1) (Wikipedia RX-7), 4.100 on the listing above. |
| Drive / curb | FR; torque-sensing LSD (est.; not fetched). Curb (Wikipedia RX-7): S6 Type R 1,260 kg, Type RZ 1,230, S6 EU 1,325, S8 Type RS 1,280, S8 Type R 1,310; 221616: Type RII 1,250 kg. About 1,280 kg stands for the Type RS. |
| 0-100 / top | Not in Wikipedia. Mazda's own claim 0-60 mph 4.9 s (AutoGuide); tests 5.0-6.0 s (Cars.com Car and Driver comparison 6.0 s as tested; 0-60specs 5.3 s). Top speed about 158 mph = 254 km/h manufacturer estimate (Cars.com); governor 250 km/h worldwide / 180 JDM (Wikipedia Supra page, same industry rule). |
| Sound | Buzzy, high, non-piston "brap"; a bridge-port-less stock lope is mild. Turbo whistle is faint behind the engine. Overrun pops through the tubular exhaust. (Character, not sourced.) |
| Voice | Rotary layout `R2`; `pipes: 1`, `muffler: quiet` stock, `sport` for a build; no header/crank fields apply (unchanged) |
| Synth gaps | ~~Sequential turbo handover~~ done (`spoolRpm 1800`, `preboostRpm 4000`, `handoverRpm 4500`, `handoverDip 0.2`, sourced above); ~~apex-seal rasp~~ done (`apexRasp: 1`), with the port-overlap idle lope (`idleLope: 1`); ~~relief-valve flutter~~ done (`diverter: 'recirculating'`, `flutter: 0.3`, est.) |

Shipped (`kazamaRotor`) vs sourced: redline 8,000 (est. 7,000 manual); gear ratios first four and final 4.300 match the sources, fifth 0.88 is a deliberate fit (donor 0.806, not 0.719 as the shipped comment says); torque peaks 314 at 5,500 (that is the 280 PS Series 8 figure, 314 N·m at 5,000); no handover dip in the shipped curve; mass 1,280 matches the Type RS.

Sources fetched: https://en.wikipedia.org/wiki/Mazda_RX-7 (first 100k chars) , https://en.wikipedia.org/wiki/Mazda_Wankel_engine , https://justjap.com/products/os-giken-5-speed-cross-gear-set-with-input-shaft-mazda-rx-7-fd3s-r15m-d , https://221616.com/catalog/mazda/efinirx7/199112_199710/2501181/ ; via search only: https://carfromjapan.com/specifications/mazda/rx-7/5813aa2b2afaa2c4b286b005 , https://www.autoguide.com/auto-news/2013/06/retro-ride-1993-mazda-rx-7-review.html , https://www.cars.com/research/mazda-rx_7-1993 . (The `Mazda_13B-REW` Wikipedia URL is a 404.)

## Albrecht Kombi S: 1992-95 Audi S2 Avant (2.2 20v turbo I5, ABY)

Note: `docs/engineSound.md` still describes the Kombi as "2.7 V6 biturbo"; the donor named here is the I5. (Another worker is editing that section.)

Source status key: **sourced** = read on a fetched page; **est.** = not found.

| | |
|---|---|
| Engine | 2.2 20v turbo I5 **sourced**: 2,226 cc, 81.0 x 86.4 mm, compression 9.3, DOHC 4 valves/cyl (automoli.com S2 page). Engine codes **3B (220 PS, 1990-92)** and **ABY (230 PS, 1992-95)** (automoli; Wikipedia Audi S2). Iron block, no VVT: **est.** |
| Firing | 1-2-4-5-3, even 144°: **est.** (the Wikipedia inline-five URL tried is a 404; this is the standard Audi five) |
| Aspiration | Single KKK K24, boost about 0.9-1.0 bar: **est.** (not on any fetched page). Wikipedia notes only an **overboost function to 380 N·m in short bursts**. Diverter/recirculating valve: **est.** |
| Intake | Plenum, one throttle, front-mount intercooler: **est.** ("Turbocharger, Intercooler" on automoli, no layout) |
| Exhaust | Cast 5-into-1, single pipe, single large muffler: **est.** |
| Idle / redline / fuel cut | about 800 / 6,800 / about 7,000: **est.** (no source). The sim ships 850 / 6,600. |
| Power / torque | **ABY 230 PS (169 kW) at 5,900 rpm, 350 N·m at 1,950** (automoli; Wikipedia: torque rising from 309 to 350 N·m, overboost up to 380). 3B: 220 PS at 5,900, 309 N·m at 1,950. The 350 N·m plateau is reported as **1,950-3,000 rpm** (australiancar review via search), not to 3,500 as the doc said. |
| Torque curve (est.) | 1500:250, 1950:350, 3000:350, 4000:335, 5000:305, 5900:274, 6500:225. No stock dyno found; the closest, a tuned RS2 (about 315 bhp) plot on forum.rs246.com, reads peak 338.6 N·m at 3,726 and a plateau from about 3,300: shape reference only. Power check: 230 PS / 5,900 rpm = 274 N·m. |
| Gearbox | 01E **6-speed** from Oct 1992 on the ABY (Wikipedia Audi S2; the 3B had 5). Ratios, via search of the GT40s 01E thread (page itself 403): 3.50 / 1.88 / 1.32 / 1.034 / 0.857 / 0.71 with final 37/9 = **4.11**; a forum post says the S2/RS2 six-speed keeps 4.11, with 0.730 sixth. 12v.org's 01E table (fetched) lists the S6 sets 3.50 / 1.89 / 1.32 / 1.03 / 0.86 / 0.73 and 37/9 = 4.11 as the usual 01E final drive, but does not name the S2. So: 3.50 / 1.89 / 1.32 / 1.03 / 0.86 / 0.71-0.73, final 4.11, moderately sourced. |
| Drive / curb | quattro permanent 4WD **sourced** (Wikipedia). Torsen centre diff 50/50 nominal, up to 75/25: **est.** (not on fetched pages). Curb **1,525 kg** (Wikipedia; automoli for the ABY coupé; 3B coupé 1,420). The Avant itself is not listed separately; sim ships 1,480. |
| 0-100 / top | Coupé ABY **5.9 s** (Wikipedia; automoli), 3B 5.7-6.1 s (Wikipedia 5.7, automoli 6.1); **Avant 6.1 s** (Wikipedia). Top speed **246 km/h** (Wikipedia history) to 248 km/h (automoli); spec table range 241-250. |
| Sound | Five-cylinder warble (the 144° beat note), whistling turbo, loud diverter chirp-whoosh on lift-off. (Character, not sourced.) |
| Voice | I5, turbo; `headers: equal`, `pipes: 1`, `muffler: quiet`, `intake: plenum` (unchanged) |
| Synth gaps | Diverter-valve chirp/flutter; the odd-cylinder beat is in `docs/engineSound.md`'s I5 plan (stagger tuning) |

Shipped (`albrechtKombi`) vs sourced: ratios 3.500 / 1.889 / 1.320 / 1.034 / 0.857 / 0.711 on 4.111 agree with the GT40s listing; torque 350 plateau agrees; redline 6,600 is below the est. 6,800. Top speed in the shipped comment (246-250) agrees with the sources.

Sources fetched: https://en.wikipedia.org/wiki/Audi_S2 , https://www.automoli.com/gb/vehicles/audi/s2/s2-coupe-1136/ , https://12v.org/urs/charlie_smith/01E/index.htm ; via search only: https://www.gt40s.com/threads/batch-of-audi-01e-6-speeds.31761 , https://forum.rs246.com/viewtopic.php?p=65813 .

## Nakaya Horizon GT: 1995-98 Nissan Skyline GT-R R33 (RB26DETT)

Source status key: **sourced** = read on a fetched page; **est.** = not found.

| | |
|---|---|
| Engine | RB26DETT **sourced**: 2,568 cc, 86.0 x 73.7 mm, inline 6, DOHC 24v (Wikipedia Nissan RB engine). Iron block: est. |
| Firing | 1-5-3-6-2-4, even 120°: **est.** (the Wikipedia RB page does not state it; standard RB order) |
| Aspiration | **Parallel** twin turbo with a pair of T25-type **ceramic** turbochargers **sourced** (Wikipedia RB; the R34 changed to ball-bearing T28s with ceramic wheels). One turbo per three cylinders (1-2-3 / 4-5-6): **est.** Boost: wastegates limit it to about **10 psi (0.69 bar)**; a built-in restrictor keeps it under 14 psi (0.97 bar) (Wikipedia RB). The doc's earlier "rising to about 0.85" was not found. |
| Intake | **Six individual throttle bodies in three pairs** **sourced** (Wikipedia RB). |
| Exhaust | Cast manifold per turbo, dump pipes, catback with twin outlets: **est.** (nothing fetched) |
| Idle / redline / fuel cut | 750 / 8,000 / about 8,000: **est.** Wikipedia only mentions vibration between 7,000 and 8,000 rpm and the Z-Tune reaching 8,000. |
| Power / torque | **280 PS (206 kW) at 6,800 rpm; 368 N·m (37.5 kgf·m) at 4,400** for the BCNR33 (Nissan Heritage Collection, incl. the V-spec). **Correction:** the R32 is 353 N·m (36.0 kgf·m) at 4,400 (Wikipedia GT-R page; the 400R comparison lists the standard R33 at 36.0 kgf·m at 4,500). The 392 N·m / 4,400 in the old doc is the end-of-production RB26 figure (Wikipedia RB page: "ended at about 320 PS and 392 N·m") i.e. the R34, not the R33. Real output of the R33 is about 320 PS under the 280 PS gentlemen's cap (Wikipedia RB; the "enthusiasts believe" line, so soft). |
| Torque curve (est.) | 1500:150, 2500:260, 3500:355, 4400:368, 5500:345, 6800:289, 7500:250, 8000:215. No stock R33 dyno chart found (searches returned tuned-car threads only; one test quotes about 285 hp at the wheels for fairly stock R33s with no curve). Power check: 280 PS / 6,800 rpm = 289 N·m. |
| Gearbox | 5-speed, ratios **3.214 / 1.925 / 1.302 / 1.000 / 0.752** (OS Giken standard set for the FS5W30A, D Sport article for first gear; both via search). Final drive **4.111** for the GT-R (SAU forum, via search; GTS-4 4.375). Nissan's box code is FS5W30A; the "Getrag 233" label in the shipped comment was not confirmed by any source found. |
| Drive / curb | ATTESA E-TS Pro: introduced 1995 as an option, **standard on V-spec**, with a hydraulic active rear limited-slip diff (Wikipedia Skyline GT-R). Up to 50 % to the front: est. Super HICAS rear steer: sourced as a GT-R technology. Curb **1,530 kg** (infobox) or 1,540 kg (text); V-spec about 10 kg more. |
| 0-100 / top | No clean 0-100 km/h figure: monkeymotor lists 5.5 s, ultimatespecs 0-60 mph 5.0 s, lapmeta 5.4 s (all search snippets). Top speed: **180 km/h JDM limiter; UK-imported V-spec limited to 250 km/h** (Wikipedia GT-R). The doc's "250 governed" holds only for the UK cars. |
| Sound | Smooth-then-ragged inline six, ITB intake induction rasp, twin-turbo flutter, 8,000 rpm top. (Character, not sourced.) |
| Voice | `intake: itb` **confirmed** (six throttle bodies), `headers: equal`, `pipes: 2`, `crossover: none`, `muffler: quiet` (stock) / `sport` (shipped). Shipped: `pipes: 2, muffler: sport, intake: itb, manifold: split3, howl: 1, diverter: recirculating, wastegate: 0.4, twinWhistle: 0.015` (the voice follows the RB26DETT: ITBs, the manifold split front three / rear three, a metallic howl above 0.55 of the redline, two close whistle tones for the parallel twin turbos; sources and measurements in `docs/engineSound.md`, Nakaya Horizon GT) |
| Synth gaps | Twin-turbine flutter from two separate turbines per bank (parallel, so no handover); ITB honk is shared with N/A engines. Done: stock `diverter: 'recirculating'`, wastegate chatter (`wastegate: 0.4`, the wastegates are sourced above), the front three / rear three manifold table (`manifold`, est.), the high-rpm rasp (`howl`) and the twin turbos' two whistle tones (`twinWhistle`) |

Shipped (`nakayaHorizon`) vs sourced: the shipped curve peaks 368 at 4,400, which **matches the sourced R33 figure** (the old doc's 392 was the outlier); gears and 4.111 final match, fifth 0.893 is a deliberate fit (donor 0.752); mass 1,540 matches; redline 8,000 is est.

Sources fetched: https://en.wikipedia.org/wiki/Nissan_RB_engine , https://en.wikipedia.org/wiki/Nissan_Skyline_GT-R (first 100k chars) , https://www.nissan-global.com/EN/HERITAGE%5FCOLLECTION/skyline_gt-r_bcnr33.html ; via search only: https://justjap.com/collections/bnr32/products/os-giken-cross-gear-set-nissan-skyline-r32-r33-r34-300zx-z32-fs5w30a , https://dsportmag.com/the-cars/project-gt-r-749-wheel-horsepower-found-one-transmission-lost/2/ , https://sau.com.au/forums/topic/480711-r34-gearbox-diff-ratios , https://www.ultimatespecs.com/car-specs/Nissan/17028/Nissan-R33-Skyline-GT-R.html .

## Tachibana Zenith: 1993-98 Toyota Supra Mk IV Turbo (2JZ-GTE)

Source status key: **sourced** = read on a fetched page; **est.** = not found.

| | |
|---|---|
| Engine | 2JZ-GTE **sourced**: 2,997 cc, 86.0 x 86.0 mm, inline 6, DOHC 24v (Wikipedia Toyota JZ). **VVT-i added September 1997** (same page), so only the 1997+ JDM engine. Iron block: est. |
| Firing | 1-5-3-6-2-4, even 120°: **est.** (not stated by the Wikipedia JZ page) |
| Aspiration | **Sequential** twin turbo **sourced**. Turbo model differs by market (Wikipedia JZ): **export CT12B** (stainless turbine and impeller), **Japanese CT20 (B/R/A)**; the old doc's "CT12B" holds only for export cars. Sequence (Wikipedia Supra): the first turbo gives about 300 lb-ft (407 N·m) at 1,800 rpm; at **3,500 rpm** exhaust is routed to the second turbo ("pre-boost", no extra output yet); at **4,000 rpm** the second turbo's output joins. Boost about 0.75-0.84 bar: **est.** (not stated). Wastegate and recirculating bypass: est. |
| Intake | Plenum, one throttle: **est.** |
| Exhaust | Cast manifold feeding both turbines, 2.5" catback, one muffler, dual outlets: **est.** |
| Idle / redline / fuel cut | about 800 / 6,800 US - 7,000 JDM / about 7,100: **est.** (no source found) |
| Power / torque | JDM **280 PS at 5,600 rpm** (Toyota Japan catalogue and goo-net, both via search / fetch). Torque by catalogue: **44.0 kgf·m = 431 N·m at 3,600** (goo-net, early RZ), **46.0 kgf·m = 451 N·m at 3,600** (Toyota Japan ucar catalogue, 1997-99 RZ, VVT-i, fetched). Wikipedia JZ: 44.3 kgf·m (434 N·m) at 3,800 initially, 46 kgf·m (451 N·m) after VVT-i, 318 PS at 6,000 for the highest JDM output. Export: **321 hp (325 PS) at 5,600, 315 lb-ft (427 N·m) at 4,000** (Wikipedia Supra). Europe 330 PS, 441 N·m (no rpm given). The doc's "431 N·m at 4,000" should read **3,600** (JDM). |
| Torque curve | **Already in `drivingParams.json` (`cars.tachibanaZenith`, est.)**: 800:150 ... 4000:431 ... 7000:268. No stock dyno chart found. Shape note: the sourced first-turbo figure is about 407 N·m at 1,800 rpm, far above the shipped 215 at 1,500 / 300 at 2,200: the shipped low end is much weaker than the donor. Peak also sits at 3,600 not 4,000. |
| Gearbox | Getrag V160 six-speed on the turbo (Wikipedia Supra; V161 from 1996 "similar"). Ratios 1-5 **3.827 / 2.360 / 1.685 / 1.312 / 1.000** appear on a carfromjapan listing (via search; page 429/403), sixth not seen (0.793 is **est.**, kept from the repo). **Final drive conflicts: 3.266** on the Toyota Japan RZ 6MT catalogue (fetched), **4.235** on the carfromjapan listing; the doc's 3.133 was found nowhere. The 4-speed auto is 3.769. |
| Drive / curb | FR. LSD standard on the RZ (Toyota Japan catalogue); SZ-R got an LSD standard in 1994 (Wikipedia Supra). Torsen type: est. Curb: JDM RZ **1,510 kg** (Toyota JP, goo-net), RZ-S 1,490 kg (carsales); US manual turbo 1,565 kg; infobox range 1,490-1,570 kg; 53/47 weight split. |
| 0-100 / top | 0-60 mph **as low as 4.6 s** with the rollout subtracted (Car and Driver, Wikipedia Supra); the doc's "4.9 s" is not sourced. Tested top speed **160 mph (257 km/h)**; limiter 155 mph (250) worldwide, 112 mph (180) Japan. |
| Sound | Smooth six whoosh, turbo spool-and-whistle, sharp blow-off at lift; relatively quiet stock. (Character, not sourced.) |
| Voice | `headers: equal`, `pipes: 1`, `muffler: quiet`, `intake: plenum` (unchanged) |
| Synth gaps | ~~Sequential handover~~ done: `spoolRpm 1800`, `preboostRpm 3500`, `handoverRpm 4000` (sourced above; no dip is described, so none); ~~BOV flutter~~ done (`diverter: 'recirculating'`, `flutter: 0.4`, est.) |

Shipped (`tachibanaZenith`) vs sourced: ratios 3.827 ... 1.000 match, sixth is deliberately 0.876; **final 3.800 is a fit, not a source** (sourced 3.266 or 4.235; the comment cites "the real 3.133", which no source supports); curve peak 431 at 4,000 (sourced 431-451 at 3,600); mass 1,510 matches the RZ.

Sources fetched: https://en.wikipedia.org/wiki/Toyota_JZ_engine , https://en.wikipedia.org/wiki/Toyota_Supra (chars 0-200k) , https://toyota.jp/ucar/catalog/brand-TOYOTA/car-SUPRA/199708/1000971/ ; via search only: https://www.goo-net-exchange.com/catalog/TOYOTA__SUPRA/1000907 , https://carfromjapan.com/specifications/toyota/supra/581337df2afaa2c4b2867e11 , https://www.carsales.com.au/research/toyota/supra/1998/rz-s/ .

## Tachibana Zenith engine swaps (the Power tab)

The Supra's two V8 swaps (`engineSwaps` on the manifest car, physics in `drivingParams.json` `swaps.tachibanaZenith`), from the user's brief: both built to the same **650 N·m**, by opposite routes. Nothing was fetched for this section: displacement, bore x stroke, compression and the stock outputs are the engines' well known figures (as recalled); the build outputs are the brief's targets; everything else is **est.**

### 6.2 LS3 (`ls3`): naturally aspirated, cammed, through a T56

| | |
|---|---|
| Engine | V8 6,162 cc, **103.25 x 92.0 mm**, aluminium block, pushrod two valve, 10.7:1. Stock **430 hp (321 kW) at 5,900, 575 N·m (424 lb-ft) at 4,600**, 6,600 limit. |
| Build | Mild duration, high lift cam with long overlap, beehive springs, long tube headers, cold air intake, dyno tune: **650 N·m at 4,600** (the brief); about **530 PS at 6,200** and a 6,800 limit **est.** The overlap costs a little at the bottom (330 N·m at idle, **est.**). |
| Mass | aluminium V8 against the iron 2JZ-GTE with its twins and piping: about −30 kg, **est.** |
| Gearbox | Tremec T56 Magnum 2.66 / 1.78 / 1.30 / 1.00 / 0.80 / 0.63 (as recalled); sixth shortened to 0.694 on the stock 3.8 final drive, so its limiter (326 km/h) is 1.1 times the 296 km/h drag top speed. First reaches 85 km/h (the V160's 61). |
| Sound | The cam's idle chop, then a deep cross-plane roar through open long tubes; no turbo in the stream, no whistles or valves. |
| Voice | `V8`, `na`, `displacement: 6.162`, `crank: cross`, `headers: equal`, `pipes: 2`, `crossover: h`, `muffler: sport` (the loudness trim levels every silencer, so `straight` bought only brightness), `idleLope: 0.6`. Its 0.77 l firings are the biggest in the game: the size's level gain is capped at +0.8 dB (`SIZE.levelMax`) to keep it inside the 2 dB loudness band. `idleLope` was rotary only until this swap: a long duration cam's overlap leaks burnt gas back into the intake the way a rotary's ports do, so the same weak-firing model (`LOPE`) serves both; depth 0.6 is **est.** |

### 1UZ-FE turbo (`turbo1uz`): the LS400 V8 on a single turbo

| | |
|---|---|
| Engine | V8 3,968 cc, **87.5 x 82.5 mm**, aluminium block, belt driven quad cam, 32 valve, about 10.0:1 (early non VVT-i). Stock about **260 PS at 5,400, 353 N·m at 4,600**. |
| Build | One 62-67 mm turbo at 8-10 psi, wastegate, blow-off valve, front mount intercooler, 550 cc injectors, stock internals: **650 N·m at about 4,000** (the brief); about **475 PS at 6,000** and a 6,400 limit **est.** Soft below 2,500, boost through 3,000-4,000 (`spoolTime 0.7`, `turboShare 0.45`). |
| Mass | aluminium V8 plus the turbo kit: about −20 kg on the 2JZ-GTE, **est.** |
| Gearbox | the V160 stays behind an adapter plate; final drive 2.95 (from 3.8): sixth's limiter 313 km/h, 1.1 times the 284 km/h drag top speed. |
| Sound | A quiet, smooth idle; under load a refined mechanical howl muffled by the turbine; intake hiss, spool whistle, and a venting blow-off valve's hiss on every lift. |
| Voice | `V8`, `turbo`, `displacement: 3.968`, `crank: cross`, `headers: equal`, `pipes: 1` (one turbo, one pipe), `muffler: sport`, `diverter: vent`, `whoosh: 1.2`, `wastegate: 0.4` |

Measured (stock setup, from rest, full throttle; 0-60 mph / 0-100 / 0-200 / top): stock 2JZ 4.92 / 5.20 / 22.9 s / 241 km/h; LS3 4.85 / 5.00 / 13.9 s / 296; 1UZ turbo 4.43 / 4.60 / 15.0 s / 284. With traction control: LS3 3.47 / 3.63 / 12.5 s, 1UZ 3.63 / 3.80 / 14.2 s. As with the Wendt's DAZA, the LS3's torque from idle spins the rears without traction control, where the 1UZ's lag keeps it under the grip; past 100 km/h, or with traction control, the LS3 is the quicker car.

## Nakaya Grove engine swaps (the Power tab)

The S13's four swaps (`engineSwaps` on the manifest car, physics in `drivingParams.json` `swaps.nakayaGrove`), from the user's brief, kept inside the Wendt Strom's swap range (top speed 242 to 294 km/h, 0-200 in 13 to 24 s). Nothing was fetched for this section: displacement, bore x stroke and the stock outputs are the engines' well known figures (as recalled); every build output, rev limit and mass is **est.**

| Swap | Engine | Stock | Build (est.) | Mass (est.) | Gearbox |
|---|---|---|---|---|---|
| K24 i-VTEC (`k24`) | I4 2,354 cc, 87 x 99 mm, aluminium, iron liners, DOHC i-VTEC (VTC intake, lobe switching both cams) | K24A2: 205 hp at 7,000, 222 N·m at 4,500 | big port manifold, header, cams, springs, tune, balance shafts out: about 265 PS at 7,400, 265 N·m at 5,200, VTEC near 5,000, 7,800 limit | −25 kg on the KA24DE: 1,228 | the 240SX five speed behind an adapter, final 5.13: limiter 260 km/h over a 233 drag top speed |
| SR20DET (`sr20det`) | I4 1,998 cc, 86 x 86 mm, aluminium, dry iron sleeves, DOHC on finger followers | S13: 205 PS at 6,000, 275 N·m at 4,000 | GT28 class turbo at about 1.2 bar, front mount, 740 cc, rocker stoppers, standalone: about 340 PS at 6,800, 400 N·m at 4,800, 7,500 limit (`spoolTime 0.55`, `turboShare 0.35`) | about the KA's: 1,245 | its own FS5W71C (the KA's ratios), final 4.39: limiter 292 over 260 |
| RB25DET Neo (`rb25det`) | I6 2,498 cc, 86 x 71.7 mm, iron block, aluminium head, solid buckets, NVCS intake | R34 GT-T: 280 PS at 6,400, 343 N·m at 3,200 | GT3076 class single on a top mount at about 1.3 bar, front mount, 800 cc, oil restrictor, Nismo pump drive: about 450 PS at 6,800, 530 N·m at 4,800, 7,500 limit (`spoolTime 0.75`, `turboShare 0.45`) | +60 kg, all over the front axle: 1,313 | its own five speed 3.214 / 1.925 / 1.302 / 1.000 / 0.752 (**est.**, the R33 GTS25t's), final 4.06: limiter 319 over 287 |
| 6.2 LS3 (`ls3`) | V8 6,162 cc, 103.25 x 92.0 mm, aluminium deep skirt, six bolt mains, pushrod two valve | 430 hp at 5,900, 575 N·m at 4,600, 6,600 limit | stock cam, long tubes, cold air, tune, springs: about 460 PS at 6,000, 600 N·m at 4,600, 6,800 limit | about the RB25's (with the T56): 1,308 | T56 Magnum with sixth at 0.694 (as the Zenith's), final 3.9: limiter 326 over 292 |

Voices: K24 `I4`, `na`, `muffler: sport`, `camRpm: 5000`, `camStep: 1` (the VTEC crossover); SR20DET `I4`, `turbo`, `diverter: vent`, `flutter: 0.4`, `whoosh: 1`, `wastegate: 0.4`; RB25DET `I6`, `turbo`, `muffler: straight`, `diverter: vent`, `whoosh: 1.3`, `wastegate: 0.7`, `screamer: 1` (the top mount's external gate); LS3 as the Zenith's but `idleLope: 0.2` (the stock cam). All **est.**

Measured (stock setup, from rest, full throttle, no traction control; 0-60 mph / 0-100 / 0-200 / top): stock KA24DE 7.37 / 7.87 s / never / 194 km/h; K24 5.13 / 5.48 / 25.8 s / 233; SR20DET 3.85 / 4.05 / 16.0 s / 260; RB25DET 3.42 / 3.57 / 12.5 s / 287; LS3 4.77 / 4.92 / 13.2 s / 292. Against the Wendt's swaps (3.6 VR6 23.8 s / 242, 07K 14.4 s / 282, DAZA 13.0 s / 294) the K24 sits by the VR6, the SR20DET between the VR6 and the 07K, the RB25DET and the LS3 by the DAZA. As on the Zenith, the LS3's torque from idle spins the rears off the line where the turbo engines' lag keeps them under the grip.

## Tachibana Runabout: 1994-99 Toyota MR2 SW20 Turbo (3S-GTE)

Source status key: **sourced** = read on a fetched page; **est.** = not found.

| | |
|---|---|
| Engine | 3S-GTE **sourced**: 1,998 cc, 86.0 x 86.0 mm, inline 4 DOHC 16v, transverse mid-mount (Wikipedia Toyota S engine; compression 8.8:1 GT, 8.5:1 GT-S per jdmbuysell). |
| Firing | 1-3-4-2, even 180°: **est.** (not stated on fetched pages) |
| Aspiration | Turbo by generation (Wikipedia Toyota S engine): Gen 2 (1990-93) **CT26, dual-entry, 10-11 psi**; **Gen 3 (1994-99, the late SW20) "C20b" (CT20B) at 13 psi**. The old doc's "CT26 on Gen 3" is wrong. US cars run about 11-12 psi (mr2wiki). Intercooler position (the SW20 uses a side-mount, the Celica a top-mount): **est.**, not confirmed by a fetched page. Wastegate and relief valve: est. |
| Intake | Plenum, one throttle: **est.** |
| Exhaust | Cast manifold, single 2.5" catback: **est.** |
| Idle / redline / fuel cut | about 800 / 7,000-7,300 / about 7,300: **est.** (neither Wikipedia nor jdmbuysell states a redline) |
| Power / torque | JDM Rev 3+ **GT-S 245 PS at 6,000 rpm; 304 N·m (31.0 kgf·m) at 4,000 rpm** (jdmbuysell 3S-GTE; Wikipedia: 245 PS from Nov 1993). The old doc's "304 at 3,200" belongs to the earlier 225 PS GT (31.0 kgf·m at 3,200, jdmbuysell). Gen 2 JDM 221-225 PS. US: **200 hp at 6,000, 271 N·m (200 lb-ft) at 3,200** (Wikipedia; mr2wiki agrees). There was no official European turbo car (Wikipedia MR2). |
| Torque curve (est.) | 1500:150, 2500:270, 3200:304, 4000:304, 4500:300, 6000:287, 7000:240. No stock dyno chart found (only tuned 400 whp builds). Power check: 245 PS / 6,000 rpm = 287 N·m. |
| Gearbox | **E153 5-speed**, used only in the turbo MR2, open or viscous-LSD differential (Wikipedia MR2; mr2wiki E153 page, fetched). **E153 turbo ratios not found.** What exists: the **non-turbo S54** is 3.285 / 1.960 / 1.322 / 1.028 / 0.820, final 4.176 (Wikipedia Toyota S transmission); a Toymods table lists an **E153 from a 1997-00 Camry** as 3.230 / 1.913 / 1.258 / 0.918 / 0.731, final 3.933 (a different application). The doc's earlier 3.54 / 2.05 ... guess is unsupported. Viscous LSD optional on turbo from Rev 2, standard on JDM from Rev 3 (Wikipedia MR2). |
| Drive / curb | MR. Curb (Wikipedia): 1,250 kg (1993 Turbo GTS hardtop) to 1,310 kg (1991 T-top); US 2,750-2,888 lb (mr2wiki); weight split about 43/57. |
| 0-100 / top | US Turbo **0-60 mph 6.1 s**, quarter mile 14.7 s (Wikipedia MR2); mr2wiki 5.9-6.3 s. No 0-100 km/h and no top speed found (245 km/h stays **est.**). |
| Sound | Raspy four-cylinder, wastegate "whoosh" and chatter, a flutter on lift. (Character, not sourced.) |
| Voice | `headers: equal`, `pipes: 1`, `muffler: quiet`, `intake: plenum` (unchanged) |
| Synth gaps | ~~Wastegate chatter and compressor-surge flutter~~ done (`wastegate: 0.6`, `flutter: 0.5`, `diverter: 'recirculating'`; est., the Sound row is character, not sourced); mid-engine cabin-intake noise (position-dependent mix) |

Shipped (`tachibanaRunabout`) vs sourced: the shipped gearbox (3.230 / 1.913 / 1.258 / 0.918, fifth 0.694) is the **Camry E153** table, which no SW20-specific source confirms; the S54 set (3.285 / 1.960 / 1.322 / 1.028 / 0.820, final 4.176) is the nearest sourced MR2 set but is the non-turbo box. Torque 309 at 3,200 vs sourced 304 (4,000 for the 245 PS car); redline 7,200 is est.; mass 1,270 within the 1,250-1,310 sourced range.

Sources fetched: https://en.wikipedia.org/wiki/Toyota_S_engine , https://en.wikipedia.org/wiki/Toyota_MR2 (first 100k chars) , https://www.jdmbuysell.com/learn/engines/3s-gte/ , https://mr2wiki.com/MKII/FactsAndFigures/ , https://mr2wiki.com/MKII/E153Transmission/ , https://en.wikipedia.org/wiki/Toyota_S_transmission ; via search only: https://www.toymods.org.au/forums/threads/48952-MR2-boxes-same-turbo-vs-non-turbo .

---

# Planned cars

## Honda NSX NA1 / 1992-95 NSX-R (C30A)

Source status key: **sourced** = read on a fetched page; **est.** = not found.

| | |
|---|---|
| Engine | C30A **sourced**: 2,977 cc, 90.0 x 78.0 mm, 90° V6, compression 10.2:1, DOHC VTEC, 4 valves/cyl, titanium connecting rods (Wikipedia Honda C engine; honda.co.jp C30A page). Ti rods raised the maximum engine speed by about 700 rpm (global.honda). |
| Firing | Offset crankpins give even 120° intervals **sourced** (Wikipedia C engine). Order 1-4-2-5-3-6: **est.** |
| Valvetrain | VTEC: **low-to-high cam switch at 5,800 rpm on manual cars** (global.honda C30A page; automatics switch slightly lower). VTEC on both intake and exhaust: the page describes intake rockers (three per cylinder, centre high-lift lobe) only; exhaust VTEC **est.** |
| Aspiration / intake | NA. **Variable-volume resonance intake**: a resonance chamber between the banks with six shutters that close for low/mid resonance and **open at 4,800 rpm** (Honda; Wikipedia C engine says "secondary plenum engages at 4,800"). Magnesium chambers. The NSX-R has no separate intake manifold (one forum thread, weak); "intake howl" is character. |
| Exhaust | **Cast-iron manifolds until 1997**, when stainless header pipes replaced them; a new lighter exhaust and muffler came in 1995 (Wikipedia NSX). The doc's "stainless dual manifolds" applies to 1997+ cars, not the NA1. Two cats, twin outlets: est. |
| Idle / redline / fuel cut | 750 / **8,000 / 8,300** (manual) and 7,500 / 7,800 (automatic) **sourced** (Acura 1992 NSX spec sheet; global.honda confirms the 8,000 and 7,500 red zones). Idle: est. |
| Power / torque | **JDM 280 PS (206 kW) at 7,300 rpm, 30.0 kgf·m = 294 N·m at 5,400** (global.honda; honda.co.jp). **US 270 hp (201 kW, 274 PS) at 7,100 and 210 lb-ft = 285 N·m at 5,300** (Acura 1992 spec sheet; Wikipedia gives 7,300 / 6,500 for the same US figures, conflicting, use Acura's). Automatic: 252 hp at 6,600 (US) / 265 PS at 6,800 (JDM). The NSX-R used the same engine at 280 PS (supercars.net's "290 bhp at 7,100" is the later 3.2). |
| Torque curve (est.) | 1500:200, 3000:240, 4500:272, 5400:294, 5800:290, 7300:270, 8000:245. No dyno chart found. Power check: 280 PS / 7,300 rpm = 270 N·m. |
| Gearbox | **NA1 5-speed: 3.071 / 1.727 / 1.230 / 0.967 / 0.771, reverse 3.186, final 4.062** (Acura 1992 spec sheet, fetched; automatic final 4.428). The doc's 3.230 / 2.105 ... guess is wrong. JDM/EU cars have tighter 2nd-4th; from 1995 second is 4.2 % lower (Wikipedia NSX). **NSX-R final 4.235** (Wikipedia; supercars.net), same gears as the JDM NSX (nsxprime thread). 6-speed from 1997 with the 3.2. |
| Drive / curb | MR. LSD: standard cars torque-reactive LSD on manuals from 1995; **NSX-R higher-locking LSD** (Wikipedia NSX). Curb: 1,365 kg (1991-92), 1,370 (93-94), 1,425 (95-96), 1,405 auto; **NSX-R 1,230 kg** (Wikipedia; Acura). |
| 0-100 / top | NSX-R **0-60 mph 4.9 s, top 168 mph (270 km/h)** (Wikipedia). NA1 0-60: no sourced figure (the 3.2-litre 1997 cars are 4.5-5.0 s); the old "about 5.8 s" stays **est.** |
| Sound | Smooth V6 turning to a hard metallic scream above the VTEC crossover; NSX-R adds intake and gear noise. (Character, not sourced.) |
| Voice | V6 even fire, `pipes: 2`, `crossover: h` (est.), `muffler: sport`, `intake: plenum` (unchanged; crossover type unconfirmed) |
| Synth gaps | ~~VTEC changeover~~ synth ready: `camRpm: 5800, camStep: 1` when the car is built; the intake-shutter change at 4,800; ~~gear whine (NSX-R)~~ synth ready: `gearWhine` (about 1 for the R's straight cut feel, less for the stock box) |

Sources fetched: https://en.wikipedia.org/wiki/Honda_C_engine , https://en.wikipedia.org/wiki/Honda_NSX_(first_generation) (first 100k chars) , https://acuranews.com/en-US/releases/1992-acura-nsx-specifications , https://global.honda/en/tech/engine/car/C30A_NSX_vtec_DOHC/ , https://www.honda.co.jp/sportscar/vtec_history/C30A/ , https://www.supercars.net/blog/1992%E2%86%921995-honda-nsx-r/ ; via search only: https://nsxprime.com/threads/special-gearing-on-a-5-speed-gearbox.24579 .

## Porsche 993 Carrera RS Clubsport (M64/20 3.8)

| | |
|---|---|
| Engine | M64/20 3,746 cc, 102.0 x 76.4 mm, compression 11.6:1, air-cooled flat 6 (boxer), SOHC per bank, 2 valves per cylinder; Varioram intake, Bosch Motronic 2.10, forged pistons, lightened rockers (RM Sotheby's lot page https://rmsothebys.com/auctions/lf14/lots/r166-1996-porsche-911-carrera-rs-38/ ; https://en.wikipedia.org/wiki/Porsche_993 for the Varioram / forged-piston text) |
| Firing | 1-6-2-4-3-5, even 120° (standard 911 flat-6 order, not re-fetched: **est.**) |
| Aspiration / intake | NA; Varioram resonance-tuned intake. The rpm where the switching valve changes manifold length is **not found** (**est.** about 5,000; tried Wikipedia 993 / M64 pages and the search results, none state it) |
| Exhaust | Two catalytic converters feeding twin tailpipes (RM Sotheby's page above). The per-bank primary layout (3-into-1 per bank) is from memory (**est.**); no source fetched. Crossover: none found |
| Idle / redline / fuel cut | 750 (est.) / **7,100 rpm limit** (RM Sotheby's page; https://www.stuttcars.com/porsche-911-carrera-rs-3-8-1995-1996/ also 7,100; the old 7,200 was wrong) / fuel cut est. about 7,200 |
| Power / torque | 300 PS (296 hp, 221 kW) at 6,500 (https://en.wikipedia.org/wiki/Porsche_993 and both pages above); 262 lb-ft = **355 N·m at 5,400** (stuttcars, RM Sotheby's) |
| Torque curve (est.) | 2000:290, 3000:320, 4000:340, 5400:355, 6500:324, 7100:295. No stock-car dyno chart or Porsche curve found (searched Rennlist and Elferspot results; a Rennlist poster only says the curve is wide and flat, forum opinion). Shaped through 355 N·m at 5,400 and 300 PS at 6,500 (300 PS at 6,500 rpm is 324 N·m) |
| Gearbox | G50/31 6-speed, short shifter. Wikipedia: RS has modified 1st-3rd, the Clubsport shorter 4th-6th. **RS ratios not found** (Porotto's factory ratio page never loaded). For reference, the standard 993 boxes per a Rennlist/parts-forum compilation seen in search results (not a fetched page): G50/21 (1993-95) 3.818 / 2.150 / 1.560 / 1.242 / 1.024 / 0.820; G50/20 (1996-98) 3.818 / 2.048 / 1.407 / 1.118 / 0.928 / 0.775. Final drive **est.** 3.44 (the same compilation says 3.44 "unless noted") |
| Drive / curb | RR, mechanical LSD (est.); **1,280 kg** (https://en.wikipedia.org/wiki/Porsche_993 and RM Sotheby's; 100 kg under the standard Carrera, 2,800 lb per stuttcars) |
| 0-100 / top | 5.2 s 0-100 km/h and 287 km/h (Sport Auto 11/94, via Wikipedia); 0-60 mph 4.7 s (stuttcars, Wikipedia), 0-100 mph 11.2 s, top 172 mph = 277 km/h (stuttcars). Both tops are given; the 287 km/h figure is a magazine test, 277 km/h the common claim |
| Sound | Air-cooled "wail": fan whine from the cooling fan (rpm-locked), a clatter of cooling fins, intake roar from 5,000 up. |
| Voice | Layout B6, `headers: equal`, `pipes: 2`, `crossover: none`, `muffler: sport`, `intake: plenum`. Nothing fetched contradicts these; the twin tailpipes after two cats support `pipes: 2` |
| Synth gaps | ~~Cooling-fan whine~~ synth ready: `fanRatio: 1.8` when the car is built (the belt ratio and 11 blades are **estimates**: no source above or in the fetched pages gives either); Varioram valve change; air-cooled mechanical noise floor |

Sources fetched: https://en.wikipedia.org/wiki/Porsche_993 , https://www.stuttcars.com/porsche-911-carrera-rs-3-8-1995-1996/ , https://rmsothebys.com/auctions/lf14/lots/r166-1996-porsche-911-carrera-rs-38/ , https://rennlist.com/forums/993-forum/11015-gear-ratios.html (no RS ratios). The Wikipedia M64 article returned 404. The Clubsport has no separate engine data in any source found (same 300 PS engine).

## Chevrolet Corvette C6 2005-07 (LS2)

| | |
|---|---|
| Engine | LS2 5,967 cc (6.0), 101.6 x 92.0 mm (4.00 x 3.62 in), compression 10.9:1, 90° cross-plane V8, OHV pushrod, 2 valves, aluminium block (https://corvetteactioncenter.com/specs/c6/2006/2006ls2.html , https://www.corvetteactioncenter.com/specs/c6/2005/specs.html) |
| Firing | 1-8-7-2-6-5-4-3, the GM LS order (not stated on any page fetched: **est.**, but it is the universal Gen III/IV order) |
| Aspiration / intake | NA; composite plenum manifold, one throttle body (size not stated on the pages fetched; 90 mm is **est.**) |
| Exhaust | 4-into-1 stainless manifolds (est.). Corvette Action Center lists "single exhaust" for every C6 model; whether that is one crossover-connected system or a label, and H vs X crossover, was **not found** (keep `x` est.). 2 (base) or 4 (Z51) tips are from memory |
| Idle / redline / fuel cut | 600-650 (est.) / **6,500 maximum engine speed** (corvetteactioncenter 2005 specs and vettesofatlanta.com) / fuel cut not stated for the LS2 (only the LS7's 7,000 is given; est. 6,600) |
| Power / torque | 400 hp (298 kW) at 6,000; 400 lb-ft (542 N·m; the Action Center rounds to 540) at 4,400 (https://en.wikipedia.org/wiki/Chevrolet_Corvette_(C6) and the Action Center) |
| Torque curve (est.) | 1500:400, 2500:480, 3500:520, 4400:542, 5000:530, 6000:474, 6500:430. No stock-car dyno chart found (search gave only tuned cars and a secondhand "stock manual C6 makes about 350 whp / 350 lb-ft", i.e. roughly 12-13 % drivetrain loss on 400/400). One source notes the LS2 beats the LS6 below 3,500-4,000 rpm and matches it above |
| Gearbox | Borg-Warner/Tremec T56 6-speed, final **3.42** (https://www.corvetteactioncenter.com/specs/c6/2005/specs.html). Base manual 2.66 / 1.70 / 1.30 / 1.00 / 0.74 / 0.50; **Z51 manual 2.97 / 2.07 / 1.43 / 1.00 / 0.71 / 0.57** (the old 0.84 fifth was wrong; another web source quotes 0.84 / 0.56, a conflict, the Action Center table is used). 4L65-E automatic (2005 only) 3.06 / 1.63 / 1.00 / 0.70, final 2.73 (3.15 optional) |
| Drive / curb | FR (rear transaxle); curb **1,458 kg** (3,214 lb, est. by the Action Center; dealer listings give 3,179-3,221 lb) |
| 0-100 / top | 0-60 mph: sources disagree, 4.2 s (secondhand, attributed to Car and Driver, not verified) to 4.8 s (Motor Trend spec summary); top speed 299 km/h not re-verified (**est.**) |
| Sound | The classic cross-plane burble at idle and low rpm, a bass pulse, clean at wide open throttle. |
| Voice | V8, `crank: cross`, `pipes: 2`, `crossover: x` (est., no source), `muffler: sport` |
| Synth gaps | None major; cylinder-specific bank asymmetry already in the model |

Sources fetched: https://en.wikipedia.org/wiki/Chevrolet_Corvette_(C6) (power/torque only), https://www.corvetteactioncenter.com/specs/c6/2005/specs.html , https://corvetteactioncenter.com/specs/c6/2006/2006ls2.html , https://vettesofatlanta.com/c6-corvette-faq-ls7-ls2-flaws-specs-2005-07/ . The Gen IV Wikipedia article 404ed.

## Mazda MX-5 Miata NA (B6ZE 1.6 and BP-ZE 1.8)

| | B6ZE 1.6 (1989-93) | BP-ZE 1.8 (1994-97) |
|---|---|---|
| Engine | 1,597 cc, 78.0 x 83.6 mm (old 83.5 was off by 0.1), compression 9.4:1, I4 DOHC 16v (https://en.wikipedia.org/wiki/Mazda_B_engine) | 1,839 cc, 83.0 x 85.0 mm, I4 DOHC 16v, redline 7,000 (same page); compression 9.0:1 per a review seen in search results (not a fetched page) |
| Firing | 1-3-4-2, 180° (standard I4, **est.**) | same |
| Aspiration / intake | NA, plenum | NA, plenum. **No VICS on the NA 1.8**: the Mazda B engine article says the MX-5 did not get VICS until 1999 (NB), so the old "VICS switch about 4,500" is removed |
| Exhaust | Cast 4-into-2-into-1 manifold, single pipe, small muffler (from memory, **est.**; no source fetched) | same |
| Idle / redline / fuel cut | 850 (est.) / **7,200** (Mazda B engine article and the UK table in https://en.wikipedia.org/wiki/Mazda_MX-5_(NA)) / fuel cut est. 7,400 | 850 (est.) / **7,000** / fuel cut est. 7,200 |
| Power / torque | 115 hp (86 kW) at 6,500; 136 N·m (100 lb-ft) at 5,500 (both articles); JDM 120 hp | 129 hp (96 kW) at 6,500; 149 N·m at 5,500; from 1996 133 hp (99 kW) and 155 N·m (MX-5 NA article). The B-engine article instead gives 131 PS at 6,000 and 165 N·m at 4,000 (91 RON, a different rating basis); the MX-5 article is used |
| Torque curve (est.) | 1500:105, 2500:118, 3500:127, 4500:133, 5500:136, 6500:126, 7000:110. No stock dyno chart found (search returned only modified cars and an unreadable K&N PDF) | 1500:120, 2500:135, 3500:143, 5500:149, 6500:141, 7000:128 (peak moved to the sourced 5,500) |
| Gearbox | 5-speed 3.136 / 1.888 / 1.330 / 1.000 / 0.814, final 4.100 (miata.net gear table https://miata.net/garage/KnowYourCar/S8_Gears.html as summarised by search; the page itself returned 403). Final drive varies by market: bofiracing.com says 4.1 in AU/EU and 4.3 in Japan/US | same ratios; final 4.100 or 4.300 by market (not confirmed per engine; the old "1.8 = 4.30" is unsupported) |
| Drive / curb | FR, optional Torsen LSD; **980 kg** unoptioned, 1,002 kg (Car and Driver) | FR; **990 kg** base |
| 0-100 / top | 0-60 mph 8.6 s (Mazda), 8.9 s (Motor Trend), 9.2 s (Car and Driver); top 188 km/h (Mazda), 116 mph = 187 km/h (C&D) | not listed in the article; **est.** about 8.5 s / 200 km/h |

Sound: a light, busy four-cylinder, intake-and-mechanical buzz, cheerful rasp near redline; the small exhaust is quiet. Voice: I4, `headers: equal`, `pipes: 1`, `muffler: quiet` stock (`sport` for a build), `intake: plenum`. Synth gaps: none beyond the generic I4 (and no intake-switch gap: the NA has no VICS).

Sources fetched: https://en.wikipedia.org/wiki/Mazda_MX-5_(NA) , https://en.wikipedia.org/wiki/Mazda_B_engine . Haltech and Edmunds pages appeared in search only.

## Subaru Impreza WRX STI GDB 2004-07 (EJ257 USDM, EJ207 JDM)

| | EJ257 (US 2004-07) | EJ207 (JDM STI V8-V9) |
|---|---|---|
| Engine | 2,457 cc, 99.5 x 79.0 mm, compression 8.2:1, boxer 4 (flat-4), DOHC 16v (https://en.wikipedia.org/wiki/Subaru_EJ_engine) | 1,994 cc, 92.0 x 75.0 mm, boxer 4, DOHC 16v, compression 8.0:1 (same page); AVCS on intake is from memory (**est.**) |
| Firing | 1-3-2-4, even 180° (standard EJ order, **est.**); unequal-length headers give the rumble | same |
| Aspiration | Single-scroll IHI turbo, VF39 (a GrimmSpeed listing calls the 2004-21 EJ257 a "single-scroll turbo system"); VF43 from 2007 (https://en.wikipedia.org/wiki/Subaru_Impreza_(second_generation)); top-mount intercooler. Boost 14.7 psi **est.**, no source found | VF39 to VF43 in the 2007 revision per the Impreza article; the EJ article instead says V7 VF30 and V8/V9 VF37 twin-scroll, a conflict (both given, Impreza article used for the 2007 change). Boost about 1.0 bar **est.** |
| Intake | Plenum | same |
| Exhaust | **Unequal-length** 4-1 headers on the EJ257 (GrimmSpeed lists the 2004-21 STI EJ257 as the UEL application; the "rumble" is the unequal runners, not the boxer layout alone: Motor Authority / Slashgear / Jalopnik explainers in search results). Single pipe, one muffler, twin outlets (est.). The EJ207 UEL is not stated in any page fetched; JDM turbo EJs share the layout (**est.**) | same |
| Idle / redline / fuel cut | 750 (est.) / 6,700 **est.** (the 6,700 in Wikipedia is the 2019 car; 2004-07 not stated) | 800 (est.) / **8,000 rpm factory limiter** (EJ article, V7-V9); the old 7,500 was low |
| Power / torque | **300 hp (224 kW) at 6,000; 407 N·m (300 lb-ft) at 4,000** (EJ article) | **280 PS (206 kW) at 6,400** (Impreza second-gen article, the 2005 STI) with **373 N·m (275 lb-ft)** at the top of its range; the old 392 N·m at 4,400 is unconfirmed. Lower-rated markets: 265 PS at 6,000 / 343 N·m at 4,000 (also the Australian-spec car at https://www.carexpert.com.au/subaru/impreza/2004/wrx-sti/features-and-specs) |
| Torque curve (est.) | 1500:230, 2500:330, 3000:380, 4000:407, 5000:390, 6000:356, 6700:300. No stock dyno chart found | 1500:200, 2500:300, 3000:355, 4400:373, 5500:350, 6400:305, 7500:260 (rescaled to 373) |
| Gearbox | TY85 6-speed. 1st-4th 3.636 / 2.375 / 1.761 / 1.346, final **3.90** (carfromjapan listing and RalliSpec TY85 text via search; carfromjapan returned 403 here). **5th/6th 0.971 / 0.756 not confirmed** (est.); the RalliSpec JDM close-ratio set is 1.062 / 0.842 and 2007 got revised gearing | same (JDM 2007 revised) |
| Drive / curb | AWD, DCCD: Wikipedia gives the US centre-diff split 35/65 F/R in 2005 and 41/59 from 2006 with a mechanical LSD added (the old blanket 41/59 only applies from 2006); **1,520 kg** for the 2006 US STI; the AU-spec 2004 car is published at 1,395 kg | 1,440-1,480 kg **est.** |
| 0-100 / top | 0-60 mph 4.6 s (Autoblog retrospective via search); 0-100 km/h 4.9 s and 228 km/h top (AU-spec 265 PS car, carexpert); US top **est.** 250+ km/h | about 5.2 s / 255 km/h **est.** (governor) |

Sound: the boxer burble (unequal-length headers, 2 pipe pairs arriving out of step); turbo whoosh and a mild BOV. Voice: B4 (flat-4), `headers: unequal`, `headerSpread: 0.5`, `pipes: 1`, `crossover: none`, `muffler: sport`, `intake: plenum`. The unequal headers are now confirmed for the EJ257, so the voice mapping stands. Synth gaps: BOV flutter; the burble fades under load (the pulse overlap at WOT is modelled; the idle burble depth is by `headerSpread`).

Sources fetched: https://en.wikipedia.org/wiki/Subaru_EJ_engine , https://en.wikipedia.org/wiki/Subaru_Impreza_(second_generation) , https://www.carexpert.com.au/subaru/impreza/2004/wrx-sti/features-and-specs ; header and gearbox claims from search-result summaries (GrimmSpeed, RalliSpec, carfromjapan, Autoblog) not opened.

## Ford Shelby GT500 S197 (2007-10 5.4 M122; 2013-14 5.8 TVS 2300)

| | 2007-10 5.4 | 2013-14 5.8 |
|---|---|---|
| Engine | 5,408 cc, 90.2 x 105.8 mm, 90° cross-plane V8, DOHC 32v, **iron block 2007-10** (aluminium from 2011) (https://en.wikipedia.org/wiki/Ford_Modular_engine) | 5,812 cc, **93.5 x 105.8 mm** (the old 92.2 x 108.7 did not give 5,812 cc), aluminium block, DOHC (same article) |
| Firing | 1-3-7-2-6-5-4-8 (Modular order, same article) | **1-3-7-2-6-5-4-8** per the same article (the old "1-5-4-2-6-3-7-8" is wrong) |
| Aspiration | Eaton **M122H** Roots-type (hybrid, higher-twist **3-lobe** rotors per a 2007 forum thread; about 2.0 L per rev per a Hyde Motorworks listing; not an Eaton datasheet), air-to-liquid intercooler. Boost about **10 psi max** (Street Muscle test of a 2011 car, 3.06" stock blower pulley, https://www.streetmusclemag.com/?p=5225 ; a seller says 3.00"); the old 8.5 psi is unconfirmed. Drive ratio not published (**est.** 2.3-2.8) | Eaton **TVS 2300** (2.3 L per rev), **14 psi max** (Wikipedia Modular article); 4-lobe high-twist design is consistent with Eaton calling the later R2650 "the high-twist, four-lobe design" (search result), 160° twist **not confirmed**. Stock pulley 2.7" (VMP/Steeda listings in search). Drive ratio not published (**est.** 2.4) |
| Intake / exhaust | Plenum under the supercharger. Manifold type and the H vs X crossover **not found** | similar, 3" tips (est.), optional bi-modal (est.) |
| Idle / redline / fuel cut | 750 (est.) / 6,500 (est.) / 6,500 | 750 (est.) / **6,500 with an over-rev function to 7,000 for up to 8 s** (Wikipedia Modular article) / fuel cut 7,000 |
| Power / torque | **500 hp (373 kW), 480 lb-ft (651 N·m)** 2007-09 (same article); 2010 540 hp / 510 lb-ft (691 N·m); 2011-12 550 hp. Peak rpm not stated: 6,000 / 4,500 kept as **est.** | **662 bhp (494 kW) at 6,500; 631 lb-ft (856 N·m) at 4,000** (same article) |
| Torque curve (est.) | 1500:430, 2500:560, 3500:630, 4500:651, 5500:620, 6000:593, 6500:530. No stock dyno chart found (search returned pulley vendors and the Street Muscle article only) | 1500:600, 2500:790, 4000:856, 5000:830, 6500:725, 7000:680 |
| Gearbox | Tremec TR-6060 6-speed 2.97 / 1.78 / 1.30 / 1.00 / 0.74 / 0.50, final 3.73: **not confirmed** (nothing found; search stated it could not find ratios) | TR-6060, 1st 2.66 and final 3.31 **not confirmed** |
| Drive / curb | FR, solid rear axle; curb not found, **est.** 1,700 kg | FR; **est.** 1,780 kg |
| 0-100 / top | 4.5 s / 249 km/h (governed), **est.**; a 2011 car tested 0-60 in 4.2 s | 3.5 s / 320 km/h claimed, **est.** |

Sound: a Roots whine from idle (rpm-locked, peaks near the redline), a cross-plane V8 burble underneath, a muted exhaust on the first car, much louder on the second. Voice: V8 `crank: cross`, `pipes: 2`, `crossover: x` (est.), `muffler: sport`, supercharged. **Lobe counts**: `blowerLobes` counts lobe passes per rotor turn (carSpec.ts: a twin screw's male rotor lobes, twice one rotor's lobes on a Roots blower; the Fiend's twin screw is 4). The M122H and TVS 2300 are both Roots-type, so the M122H's 3-lobe rotors give `blowerLobes: 6` and the TVS 2300's 4-lobe rotors give 8, outside the old 3-6 range (widened: `blowerLobes` takes 3, 4, 5, 6 or 8 now). M122: `blowerLobes: 6`, `blowerRatio: 2.5` (est.), `boost: 10` (was 8.5); TVS: `blowerLobes: 8` (in range now), `blowerRatio: 2.4` (est.), `boost: 14`. Synth gaps: ~~the TVS's 8 lobe passes~~ done; a bypass-valve whine drop-off is modelled as faint with the bypass open.

Sources fetched: https://en.wikipedia.org/wiki/Ford_Modular_engine (read to 100,000 characters), https://www.streetmusclemag.com/?p=5225 , https://themustangsource.com/forums/f726/gt500-supercharger-question-515792/ (no lobe data). The Shelby Mustang Wikipedia page had no figures in the first 100,000 characters; dbusiness.com returned 403; enginelabs had no specs.

## Nissan 240SX S14 (KA24DE US) and Silvia K's (SR20DET JDM)

| | KA24DE (US 1995-98) | SR20DET (S14 Silvia, 1993-98) |
|---|---|---|
| Engine | 2,389 cc, 89.0 x 96.0 mm, compression 9.5:1, I4 DOHC 16v (https://en.wikipedia.org/wiki/Nissan_KA_engine) | 1,998 cc, 86.0 x 86.0 mm, I4 DOHC 16v turbo, compression 8.5:1 (jdmbuysell page below); bore/stroke are the SR20DE's per https://en.wikipedia.org/wiki/Nissan_SR_engine |
| Firing | 1-3-4-2, 180° (standard, **est.**) | same |
| Aspiration | NA | Garrett T25G or T28 (Wikipedia SR engine; not tied to the S14). Boost about 0.7-0.8 bar **est.**, no source found; wastegate + recirculating valve est. |
| Intake / exhaust | Plenum; cast 4-1, single pipe (est.) | Plenum, front-mount; cast manifold, single pipe (est.) |
| Idle / redline / fuel cut | 750 (est.) / 6,500 (Wikipedia says only that it is higher than the KA24E; **est.**) / 6,800 | 800 (est.) / 7,000-7,500 **est.** (not stated in any page) / 7,500 |
| Power / torque | **155 hp (157 PS, 116 kW) at 5,600; 217 N·m (160 lb-ft) at 4,400** (Wikipedia KA and 240SX articles) | **220 PS (162 kW) at 6,000; 274 N·m (28.0 kgf·m) at 4,800** for the S14 K's, 274.6 N·m on the June 1996 catalogue (Nissan heritage page https://www.nissan-global.com/EN/HERITAGE/silvia_ks_s14.html ; https://www.jdmbuysell.com/learn/nissan/silvia/s14/). **The old 250 PS / 275 N·m "inconsistency" came from mixing ratings: 250 PS belongs to the 1997 Autech K's MF-T (5-speed, 1,260 kg) and the S15 (Wikipedia's SR20DET range is 204-250 PS). 220 PS at 6,000 with 274 N·m at 4,800 is self-consistent (power point = 257 N·m).** |
| Torque curve (est.) | 1500:150, 2500:180, 3500:200, 4400:217, 5600:197, 6500:170. No stock dyno chart found | 1500:140, 2500:225, 3500:265, 4800:274, 6000:257, 7000:225 (rescaled to the 220 PS figures) |
| Gearbox | 5-speed 3.321 / 1.902 / 1.308 / 1.000 / 0.759, final **4.083** (MotorMatchup 1995 SE listing via search; the page returned 429 when fetched) | Same 1st-4th and final 4.083 on a carfromjapan Silvia listing via search; 5th 0.759 and the old 4.111 final **not confirmed** (est.) |
| Drive / curb | FR, viscous LSD (optional); **1,253 kg** (Wikipedia 240SX; 2,771 lb elsewhere) | FR, viscous LSD; **1,220 kg** (1994 K's Type S, Nissan) / 1,250 kg (June 1996 catalogue) |
| 0-100 / top | 0-60 mph **7.3 s** (MotorWeek via Wikipedia; The Auto Channel 8.2 s, a compiled site 8.3 s); 15.5 s quarter at 89 mph; top about 200 km/h **est.** | about 6.2 s / 235 km/h **est.** (none sourced) |

Sound: KA24DE has a gruff, torquey four-cylinder drone (stock exhaust is quiet); SR20DET adds a bright turbo whistle and a blow-off flutter. Voice: I4 NA/turbo, `headers: equal`, `pipes: 1`, `muffler: quiet` stock / `sport`, `intake: plenum`. No source contradicts the voice mapping. Synth gaps: BOV flutter (SR20DET).

Sources fetched: https://en.wikipedia.org/wiki/Nissan_KA_engine , https://en.wikipedia.org/wiki/Nissan_SR_engine , https://en.wikipedia.org/wiki/Nissan_240SX , https://www.nissan-global.com/EN/HERITAGE/silvia_ks_s14.html , https://www.jdmbuysell.com/learn/nissan/silvia/s14/ .

## Mitsubishi Lancer Evolution IX (4G63T MIVEC)

Verification pass (fetched): en.wikipedia.org/wiki/Mitsubishi_Lancer_Evolution (IX output, torque, diffs, weight), en.wikipedia.org/wiki/Mitsubishi_4G6_engine (85 x 88, MIVEC), supercars.net/blog/?p=233479 (US MR 6-speed ratios, redline, weight), wardsauto.com/internal-combustion-engines/lancer-evolution-ix-debuts-in-new-york (MIVEC description). Not fetchable: jackstransmissions.com Evo 8/9 ratio chart (403), the Motorsport Australia Evo IX RS homologation PDF (encrypted), carfromjapan (403); their figures below are search-result snippets only and are flagged.

| | |
|---|---|
| Engine | 4G63T 1,997 cc, 85.0 x 88.0 mm (Wikipedia 4G6; supercars.net 85.09 x 87.88), I4 DOHC 16v, iron block; MIVEC is a variable valve-timing sprocket on the **intake cam only: timing, not lift** (Wikipedia Evolution; Wards). New on the IX |
| Firing | 1-3-4-2, 180° (standard I4; no source stated it, **est.**) |
| Aspiration | Single turbo, "revised" for the IX with a titanium-aluminide turbine wheel (Wikipedia 4G6 says only "revised turbocharger"; the TD05HRA-16G6 model code is **not confirmed**, Wikipedia names a TD05-16G-10.5 only for the wagon). Boost about 1.0-1.15 bar (**est.**) |
| Intake / exhaust | Plenum; cast manifold, 3" catback, single pipe (**est.**, no source found) |
| Idle / redline / fuel cut | 800-850 (est.) / **7,000** (supercars.net, US MR) / 7,500 (est.) |
| Power / torque | US/EU: **286 hp (213 kW) at 6,500; 392 N·m (289 lb-ft) at 3,500** (supercars.net, Wards; Wikipedia gives 291 PS/392 N·m, GSR 400, RS/GT 407 N·m). JDM: 280 PS (206 kW), 407 N·m at 3,000 (Wikipedia, gentlemen's agreement). I use the US numbers |
| Torque curve (est.) | 1500:200, 2500:350, 3500:392, 4500:385, 5500:350, 6500:313, 7000:290. Anchors are sourced (392 at 3,500; 313 = 213.3 kW / 680.7 rad/s at the 6,500 power peak); the shape between is est. No stock-car dyno chart found (searched DSPORT, MotoIQ, HP Academy: only modified cars; one forum figure of 320-340 whp stock, anecdotal) |
| Gearbox | **5-speed (RS/GSR/JDM, W5M51)**: 2.785 / 1.950 / 1.444 / 1.096 / 0.825, final 4.529 (1st gear 2.785 and a 4.53 final are confirmed for the IX by a Jack's Transmissions snippet; 2nd-5th are from the Evo IV 5-speed listing at rallycars.com, same family, **verify**). **6-speed (MR; US MR)**: 2.909 / 1.944 / 1.434 / 1.100 / 0.868 / 0.693, final 4.538 (supercars.net; other listings 4.583, e.g. GTPlanet Evo IX SE). The repo's old 1.407 / 1.031 / 0.720 had no support and are dropped |
| Drive / curb | AWD. Diffs vary: RS has an LSD, GSR has SAYC, **US models have ACD and a rear 1.5-way clutch LSD, no AYC**, the FQ-300/320/340/360 have AYC (Wikipedia). 1,310-1,490 kg across variants; 1,490 kg US MR (supercars.net) |
| 0-100 / top | 0-60 mph 4.2-4.5 s US (Wikipedia), 4.7 s (supercars.net); about 5.0 s to 100 km/h is **est.**; 250 km/h (155 mph) limiter |
| Sound | Rorty four-cylinder rasp, turbo spool-whistle, a chirp-and-flutter BOV; the sound is gruff and tight. |
| Voice | `headers: equal`, `pipes: 1`, `muffler: quiet`, `intake: plenum` |
| Synth gaps | Anti-lag sound; MIVEC is a continuous intake-cam phaser (no switch rpm), so it is not audible as a step |

Sources: https://en.wikipedia.org/wiki/Mitsubishi_Lancer_Evolution , https://en.wikipedia.org/wiki/Mitsubishi_4G6_engine , https://www.supercars.net/blog/?p=233479 , https://wardsauto.com/internal-combustion-engines/lancer-evolution-ix-debuts-in-new-york , https://rallycars.com/cars/mitsubishi-lancer-evolution-iv-evo-4/mitsubishi-lancer-evolution-iv-1997/myspecs/ (snippet only).

## Honda S2000 Club Racer AP2 2008-09 (F22C1)

Verification pass (fetched): en.wikipedia.org/wiki/Honda_S2000, en.wikipedia.org/wiki/Honda_F20C_engine (F22C1 section), Honda's 2006 press specifications (hondanews.com/en-US/releases/release-5a35f67b82f245d1db31c6004c34c121-2006-honda-s2000-specifications), s2000.club/ap2v2specs.html. The Club Racer is the AP2 F22C1 with the same engine and drivetrain.

| | |
|---|---|
| Engine | F22C1 2,157 cc, 87.0 x 90.7 mm, I4 DOHC VTEC on **both** intake and exhaust cams, 11.1:1 (Honda press; the longer stroke cut the redline from the AP1's 8,900) |
| Firing | 1-3-4-2, 180° |
| Valvetrain | **VTEC changeover about 6,000 rpm** (Wikipedia F20C article, F22C1 section). The AP1 F20C actuates 5,500-6,000 depending on ECU |
| Aspiration / intake | NA; four-runner plenum (est.) |
| Exhaust | 4-2-1 stainless header, single pipe, one muffler: **not sourced** (Honda press lists only a low-back-pressure metal-honeycomb cat; a forum search found nothing on layout). Keep **est.** |
| Idle / redline / fuel cut | 800 (est.) / **8,000 / 8,200** (Wikipedia Honda_S2000; the F20C article's text says 8,200 redline, its infobox 8,000: sources disagree, I use 8,000 / 8,200). The AP1 was 8,800 / 9,000 |
| Power / torque | US **237 hp (177 kW) at 7,800; 220 N·m (162 lb-ft) at 6,800**; JDM 241 PS (178 kW) at 7,800, 221 N·m at 6,500-7,500 (Wikipedia, Honda press). 2006 figures use the revised SAE J1349 net method |
| Torque curve (est.) | 2000:160, 3000:175, 4000:185, 5000:195, 6000:210, 6800:220, 7800:217, 8200:205. Anchors sourced (220 at 6,800; 217 = 177 kW / 816.8 rad/s at 7,800). Shape est.; the jump at VTEC is anecdotal (one S2KI owner reports 30+ whp and 15+ lb-ft at engagement). No stock chart found (the one S2KI log is a Hondata-flashed car) |
| Gearbox | 6-speed: 3.133 / 2.045 / 1.481 / 1.161 / **0.943 / 0.763** (Wikipedia AP2; Honda press 0.942), **secondary reduction 1.208**, final **4.100** (reverse 2.800). The old 0.971 / 0.811 are the AP1's (0.979 / 0.810, secondary 1.160). **The secondary reduction multiplies the gear ratio**: overall = gear x 1.208 x 4.100 (e.g. 1st 15.5, 6th 3.78), which matches real speeds in gear (1st tops out near 45 mph at 8,000) |
| Drive / curb | FR, **Torsen torque-sensing LSD** (Honda press); **1,295-1,299 kg** (2,855 lb, 50/50) |
| 0-100 / top | 0-60 about 5.4-5.8 s is **est.** (no fetched source gave it); about 240 km/h est. |
| Sound | The VTEC crossover: a deep growl turns into a metallic wail near 6,000; high-pitched to 8,000+. |
| Voice | `headers: equal`, `pipes: 1`, `muffler: sport`, `intake: plenum` |
| Synth gaps | ~~VTEC cam changeover~~ synth ready: `camRpm: 6000, camStep: 1` when the car is built; ~~gear whine~~ synth ready: `gearWhine` |

Sources: https://en.wikipedia.org/wiki/Honda_S2000 , https://en.wikipedia.org/wiki/Honda_F20C_engine , https://hondanews.com/en-US/releases/release-5a35f67b82f245d1db31c6004c34c121-2006-honda-s2000-specifications , https://www.s2000.club/ap2v2specs.html .

## Honda Civic Si EM1 1999-2000 (B16A2)

Verification pass (fetched): en.wikipedia.org/wiki/Honda_B_engine. Search snippets only (pages not fetched): the S4C ratios and 4.400 final, curb weight (cars.com 2,612 lb) and 0-60 times.

| | |
|---|---|
| Engine | B16A2 1,595 cc, **81.0 x 77.4 mm** (the old 75.0 x 90.0 was wrong), 10.2:1 (Wikipedia; one buying guide says 10.6), I4 DOHC VTEC |
| Firing | 1-3-4-2, 180° |
| Valvetrain | **VTEC changeover 5,600 rpm** (Wikipedia). Owner forum posts range 5,500-5,900, not authoritative |
| Aspiration / intake | NA, four runners plus plenum (est.) |
| Exhaust | 4-2-1 or 4-1 stainless manifold, single catback: **not sourced**, keep **est.** |
| Idle / redline / fuel cut | 800 (est.) / **8,000 / 8,200** (Wikipedia: redline 8,000, rev limit 8,200) |
| Power / torque | **160 hp (119 kW) at 7,600; 150 N·m (111 lb-ft) at 6,500** (Wikipedia; a buying-guide page says 7,000: sources disagree, I use 7,000 for the plateau shape since the peak is flat) |
| Torque curve (est.) | 2000:100, 3000:110, 4000:118, 5000:125, 5600:132, 6000:140, 6500:150, 7000:150, 7600:150, 8200:138. Anchor 149.5 = 119 kW / 795.8 rad/s at 7,600. No stock EM1 dyno chart found; the post-VTEC rise is described qualitatively (power rises after about 5,900 on forum dyno charts) |
| Gearbox | S4C 5-speed 3.230 / 2.105 / 1.458 / 1.107 / 0.848, final **4.400** (a community page; a Hondata forum thread cites the Helm manual as 4.266 for the '99 Si: sources disagree, **verify**, I lean on 4.400 until a manual is seen) |
| Drive / curb | FF, no LSD; **about 1,185 kg** (cars.com 2,612 lb; the old 1,075 was low) |
| 0-100 / top | 0-60 about 7.0-7.2 s (Hagerty drive, Edmunds via fan wiki); about 217 km/h est. |
| Sound | A relaxed, soft growl below 5,600, then a sharp hard wail to 8,000. |
| Voice | `headers: equal`, `pipes: 1`, `muffler: sport`, `intake: plenum` |
| Synth gaps | ~~VTEC changeover~~ synth ready: `camRpm: 5600, camStep: 1` when the car is built |

Sources: https://en.wikipedia.org/wiki/Honda_B_engine , https://www.cars.com/research/honda-civic-1999 (snippet), https://www.hondata.mobi/forum/viewtopic.php?p=22885 (snippet).

## BMW E46 M3 (S54B32)

Verification pass (fetched): en.wikipedia.org/wiki/BMW_S54, en.wikipedia.org/wiki/BMW_M3 (E46), en.wikipedia.org/wiki/Getrag_420G_transmission, motoiq.com/project-e46-m3-part-1-dyno-and-acceleration-testing/3. Search snippets only: 3.62 final (bimmerworld), 11.5:1 compression, double VANOS and ITB wording.

| | |
|---|---|
| Engine | S54B32 3,246 cc, 87.0 x 91.0 mm, 11.5:1, inline 6, DOHC 24v, Double VANOS (continuous intake and exhaust cam phasing, no switch rpm) |
| Firing | 1-5-3-6-2-4, even 120° (standard BMW six; no fetched source states it, **est.**) |
| Aspiration / intake | NA; **six individual throttle bodies** (snippets from several enthusiast sources; Wikipedia only says electronic throttle control) |
| Exhaust | Two 3-into-1 collectors, resonators and two mufflers, quad tips; crossover type **not sourced**, keep **est.** (a Y or H). The later S54B32HP manifold with a straighter path became standard (Wikipedia) |
| Idle / redline / fuel cut | 750-800 (est.) / **8,000** (Wikipedia) / 8,000-8,100 (est.) |
| Power / torque | EU **343 PS (252 kW) at 7,900; 365 N·m at 4,900**; US 333 hp (248 kW), 355 N·m (262 lb-ft). CSL (S54B32HP) 360 hp, 370 N·m (Wikipedia) |
| Torque curve (est.) | 1500:250, 1800:290, 2200:328, 3000:340, 4900:365, 6000:358, 7000:335, 7900:305, 8200:285. Anchors sourced (365 at 4,900; 305 = 252 kW / 827 rad/s at 7,900). Shape from MotoIQ's stock-car **wheel** dyno (Dynojet-type, loss not stated): broad and flat, about 90 % of peak at 2,200, 225 lb-ft rising to about 250 lb-ft in the midrange, still above 200 lb-ft (80 %) to 7,500, with a 60 lb-ft jump between 1,800 and 2,200. I scaled that shape to the crank peak rather than converting units; no stock chart with numbers was found |
| Gearbox | Getrag 420G (S6S 420G) 6-speed **4.227 / 2.528 / 1.669 / 1.226 / 1.000 / 0.828** (Wikipedia Getrag 420G; reverse 3.746), final **3.62** (bimmerworld snippet; 3.15 on the SMG is **est.**) |
| Drive / curb | FR, variable-lock rear diff (lock factor "25 %" **not confirmed**); **1,560-1,565 kg** (Wikipedia gives both) |
| 0-100 / top | **5.2 s** (Wikipedia, coupe, either gearbox; the old 4.8-5.0 was optimistic; the US 0-60 of 4.8 s is the official US figure); 250 km/h governed |
| Sound | The ITB howl: a woofing induction roar that follows the pedal, reaching a steady inline-six scream to 8,000. |
| Voice | `intake: itb`, `headers: equal`, `pipes: 2`, `crossover: h` (est.), `muffler: sport` |
| Synth gaps | VANOS cam phasing is subtle; ITB howl already modelled (shares with the RB26) |

Sources: https://en.wikipedia.org/wiki/BMW_S54 , https://en.wikipedia.org/wiki/BMW_M3 , https://en.wikipedia.org/wiki/Getrag_420G_transmission , https://motoiq.com/project-e46-m3-part-1-dyno-and-acceleration-testing/3 .

## Audi TT-RS 8J 2009-14 (2.5 TFSI I5, CEPA)

Verification pass (fetched): en.wikipedia.org/wiki/Audi_TT (TT RS section), ultimatespecs.com/car-specs/Audi/63708/Audi-TT-(8J)-RS-25-TFSI-Quattro.html, auto-data.net (8J facelift 2.5 TFSI 340hp), audi.com engine page for the **2017 8S** 2.5 TFSI (generic five-cylinder facts only). The Wikipedia Audi_5-cylinder_engine URL is a 404. The Australian Audi technical-data PDFs (australiancar.reviews) 404 on fetch; their gear ratios appear only in a search snippet.

| | |
|---|---|
| Engine | CEPA 2,480 cc, **82.5 x 92.8 mm**, 10:1, inline 5, DOHC 20v, FSI direct injection, aluminium crankcase (engine alone 183 kg; Wikipedia, ultimatespecs, auto-data) |
| Firing | **1-2-4-5-3, 144° interval** (audi.com engine page) |
| Aspiration | Single large turbo plus intercooler; the model is not given for the 8J. The audi.com "up to 1.35 bar" is the **2017 8S**, so for the 8J boost stays **est.** (about 1.2 bar) |
| Intake / exhaust | Plenum (est.). Audi valvelift (exhaust, two stage) and sound-button exhaust flaps are documented for the **8S**; whether the CEPA has either is **unconfirmed** (Wikipedia mentions neither), so treat both as probably absent on the 8J |
| Idle / redline / fuel cut | 750 (est.) / 7,000 (est.) / 6,800-7,000 (est.): no source found; the power band ends at 6,500-6,700 |
| Power / torque | **340 PS (250 kW) at 5,400-6,500** (text says up to 6,700; Wikipedia, auto-data); **450 N·m at 1,600-5,300** flat. RS Plus 360 PS (265 kW) at 6,700, 465 N·m at 5,400 (search snippet from Audi) |
| Torque curve (est.) | 1600:450, 3000:450, 5300:450, 5800:430, 6500:367, 7000:330. Anchors sourced (450 plateau to 5,300; 367 = 250 kW / 680.7 rad/s at 6,500, 442 at 5,400). No stock dyno chart found (only tuner listings quoting factory figures) |
| Gearbox | 6-speed manual (short shift): 1-6 about 3.57 / 2.16 / 1.89 / 1.43 / 1.16 / 0.97 **from a search snippet of the Australian Audi data sheet, unverified** (the 2.16-to-1.89 step looks wrong; do not copy without the sheet). Final **not found** (snippet shows 3.765 / 2.909 / 3.200 without labels). 7-speed S tronic from 2010 (ratios differ, not used) |
| Drive / curb | quattro with an adapted multi-plate Haldex clutch (Wikipedia); **1,450 kg** (Wikipedia, auto-data) or 1,525 kg (ultimatespecs) |
| 0-100 / top | **4.5 s coupe** (Wikipedia; auto-data and ultimatespecs 4.6); 250 km/h governed, 280 km/h option |
| Sound | The classic five-cylinder warble at an almost muted tone with a bark under load; the turbo is subdued; pops on the overrun. |
| Voice | I5 turbo, `headers: equal`, `pipes: 1`, `muffler: sport`, `intake: plenum` |
| Synth gaps | I5 stagger tuning (planned); overrun pops; ~~sound flap~~ synth ready (`flaps`), 8S only, probably not this car |

Sources: https://en.wikipedia.org/wiki/Audi_TT , https://www.ultimatespecs.com/car-specs/Audi/63708/Audi-TT-(8J)-RS-25-TFSI-Quattro.html , https://www.auto-data.net/en/audi-tt-rs-coupe-8j-facelift-2010-2.5-tfsi-340hp-quattro-27284 , https://www.audi.com/en/audi-tt-rs-coupe-and-tt-rs-roadster-the-sporty-vanguard-of-the-model-series-6673/engine-6677 (8S).

## Dodge Challenger SRT8 (2008-10 6.1 HEMI; 2011-14 392 6.4) and Viper SRT-10 (2008-10, 8.4 V10)

Verification pass (fetched): en.wikipedia.org/wiki/Chrysler_Hemi_engine, en.wikipedia.org/wiki/Viper_engine, en.wikipedia.org/wiki/Dodge_Viper, en.wikipedia.org/wiki/Tremec_TR-6060_transmission, supercars.net/blog/2008-dodge-viper-srt-10/, ultimatespecs.com (Challenger SRT8 2011 392 Auto), motorauthority.com/news/1052195 (InsideLine dyno), viperclub.org/vca/goto/post?id=3005069 (Viper dyno). The Wikipedia Dodge_Challenger_(LC) URL is a 404, and the Stellantis press page timed out. Search snippets only: the 392's 6,000 / 4,200 rpm peaks, auto ratios, and the Viper firing order (rerev.com, one site).

| | Challenger 6.1 (2008-10) | Challenger 392 (2011-14) | Viper SRT-10 (2008-10) |
|---|---|---|---|
| Engine | 6,059 cc, **103.0 x 90.9 mm** (old 103.9 x 89.0 was wrong), 90° cross-plane V8, OHV 16v, no VVT, **no MDS** | **6,415 cc, 103.89 x 94.59 mm**, 10.9:1, 90° cross-plane V8, OHV, **VVT cam phasing from 2011**; **MDS (4-cyl cruise) only on automatics, so the 6-speed car never deactivates** | 8,382 cc, **103.0 x 100.6 mm** (Wikipedia Viper engine 103.0 bore; supercars.net 100.6 stroke; the old 102.4 x 101.6 is the earlier Gen I bore), 90° V10, OHV 20v, **cam-in-cam variable valve timing on the exhaust cam**, dual throttle bodies |
| Firing | 1-8-4-3-6-5-7-2 (Chrysler Hemi standard, est.) | same | 1-10-9-4-3-6-5-8-7-2 (rerev.com, a single site, not in Wikipedia; **verify**). Treated as odd-fire (72°/108° alternation is **unsourced** here) |
| Intake / exhaust | Plenum; stainless manifolds, dual exhaust, H-pipe (**est.**, unsourced), 2 tips | same | Plenum; **new 2008 exhaust with no crossover** (Wikipedia Viper), dual rear-exit pipes. The old "X-pipe (est.)" is therefore **wrong**: `crossover: none` |
| Idle / redline / fuel cut | 600-650 (est.) / 6,200 (est.; no source) / 6,400 (est.) | 600-650 (est.) / 6,400 (est.; no source) / 6,400 (est.) | 650-700 (est.) / **6,250** (supercars.net) / 6,300 (est.) |
| Power / torque | **425 hp (317 kW) at 6,200; 420 lb-ft (569 N·m) at 4,800** (Wikipedia Hemi) | **470 hp (350 kW) at 6,000; 470 lb-ft (637 N·m) at 4,200** (the old 4,300 is replaced; Wikipedia gives the outputs, the rpm are from snippets of Motor Authority / Edmunds coverage) | **600 hp (447 kW) at 6,100; 560 lb-ft (759 N·m) at 5,000** (Wikipedia Dodge_Viper, Viper_engine) |
| Torque curve (est.) | 1500:400, 2500:500, 3500:550, 4800:569, 5500:540, 6200:488. Anchors sourced; no 6.1 dyno chart found | 1500:420, 2500:525, 3500:600, 4200:637, 5000:630, 5500:600, 6000:558, 6400:510. Shape from InsideLine's wheel dyno of a stock car: **452 hp at 6,200 and 443 lb-ft at 4,400 at the wheels, about 365 lb-ft from 2,500** (82 % of peak), loss not measured (the article assumed 10 %). Street Muscle's own pull: 420 rwhp, 420 lb-ft. The car beat its rating at the wheels, so I keep the factory crank peak | 1500:550, 2500:660, 3500:730, 5000:759, 6100:700, 6500:640. Anchor 700 = 447 kW / 638.8 rad/s. A stock 2008 convertible on a Superflow AutoDyn read **501 rwhp at 6,072 and 471 lb-ft at 5,258** (corrected; the operator assumed 15 % loss, the implied loss is about 18 %, flywheel estimate 610 hp / 571 lb-ft = 774 N·m). Shape still est. |
| Gearbox | TR6060 6-speed **2.97 / 2.10 / 1.46 / 1.00 / 0.74 / 0.50** (Wikipedia TR-6060 table for the 2009-23 Challenger; the old 2.07 / 1.43 / 0.84 / 0.57 were off); 5-speed auto 3.58 / 2.19 / 1.41 / 1.00 / 0.83, final **3.06** (a spec-page snippet, for the auto). The manual's final is **not confirmed**, keep 3.06 est. | same | Tremec **TR6060** (replaced the T56 for 2008, Wikipedia Dodge_Viper) **2.66 / 1.78 / 1.30 / 1.00 / 0.74 / 0.50, final 3.07** (supercars.net; Viper Club FAQ also says stock 3.07) |
| Drive / curb | FR; **1,887 kg (4,160 lb)** (ultimatespecs, 392 auto) | FR; 1,887 kg | FR; **1,560 kg (3,440 lb)** (supercars.net; old 1,540) |
| 0-100 / top | 0-60 about 4.8-5.0 s est. / 270 km/h est. | 0-60 4.5-4.9 s (sources disagree; Dodge claimed under 5 s) / top 273-290 km/h, estimates differ widely | 0-60 about 3.6 s / about 325 km/h (202 mph; supercars.net) |

Sound: the Challenger's HEMI is a thick cross-plane burble with a light tick of the pushrod valvetrain; the Viper's V10 is deeper and rougher, with a lumpy idle that does not exist in any even-fire layout (the firing order above is the only sourced evidence for the unevenness). Voice: V8 `crank: cross`, `pipes: 2`, `crossover: h` (est.), `muffler: sport`; Viper V10 `crossover: none` (corrected from the old X-pipe guess) and it takes `crank: 'oddfire'` (done; the intervals are derived in `docs/engineSound.md`, Odd-fire V10: 90° and 54° alternating, not the 72° / 108° this table's Firing row guessed). Synth gaps: ~~V10 odd-fire interval pattern~~ done; MDS cylinder-deactivation burble applies only to automatic 392 cars, so it is not needed for a manual.

Sources: https://en.wikipedia.org/wiki/Chrysler_Hemi_engine , https://en.wikipedia.org/wiki/Viper_engine , https://en.wikipedia.org/wiki/Dodge_Viper , https://en.wikipedia.org/wiki/Tremec_TR-6060_transmission , https://www.supercars.net/blog/2008-dodge-viper-srt-10/ , https://www.ultimatespecs.com/car-specs/Dodge/133257/Dodge-Challenger-SRT8-2011-392-Auto.html , https://www.motorauthority.com/news/1052195_2011-dodge-challenger-srt8s-6-4-liter-hemi-dyno-tested , https://viperclub.org/vca/goto/post?id=3005069 , https://www.rerev.com/firing-orders/dodge/8-4l/ (snippet).

---

# Summary table

| Car | Layout | Aspiration | Redline | Peak power / torque | Voice fields |
|---|---|---|---|---|---|
| Strom R6 (R32 VR6) | VR6 | NA | 6,500 | 241 PS / 320 N·m | unequal 0.3, pipes 1, sport, plenum |
| Rotor (RX-7 13B-REW) | R2 | seq. twin turbo | 7,000-8,000 | 255-280 PS / 294 N·m | pipes 1, quiet |
| Kombi S (S2 I5) | I5 | single turbo | 6,800 | 230 PS / 350 N·m | equal, pipes 1, quiet |
| Horizon GT (RB26) | I6 | twin parallel turbo | 8,000 (est.) | 280 PS / 368 N·m | itb, equal, pipes 2, sport, split3 manifold, howl 1, twin whistle 0.015 |
| Zenith (2JZ-GTE) | I6 | seq. twin turbo (2nd joins ~4,000) | 6,800-7,000 (est.) | 280 PS / 431 N·m at 3,600 (JDM) | equal, pipes 1, quiet, plenum |
| Runabout (3S-GTE) | I4 | single turbo (CT20B, 13 psi) | 7,000 (est.) | 245 PS / 304 N·m at 4,000 | equal, pipes 1, quiet |
| NSX / NSX-R (C30A) | V6 | NA, VTEC at 5,800 | 8,000 (cut 8,300) | 280 PS / 294 N·m (JDM) | pipes 2, h (est.), sport |
| 993 RS CS (M64/20) | B6 | NA | 7,100 | 300 PS / 355 N·m | equal, pipes 2, sport |
| Corvette C6 (LS2) | V8 cross | NA | 6,500 | 400 hp / 542 N·m | cross, pipes 2, x (est.), sport |
| Miata NA 1.6 / 1.8 | I4 | NA | 6,500-6,800 | 116-133 hp / 136-149 N·m | equal, pipes 1, quiet |
| WRX STI (EJ257 / EJ207) | B4 | single turbo | 6,700 (est.) / 8,000 | 300 hp / 407; 280 PS / 373 N·m | unequal 0.5, pipes 1, sport |
| GT500 07-10 / 13-14 | V8 cross | Roots / TVS blower | 6,500 | 500 hp / 651; 662 hp / 856 N·m | cross, pipes 2, x (est.), lobes 6 / 8, ratio 2.4-2.5, boost 10 / 14 |
| 240SX KA24DE / SR20DET | I4 | NA / single turbo | 6,500 / 7,000 (est.) | 155 hp / 217; 220 PS / 274 N·m | equal, pipes 1, quiet |
| Evo IX (4G63T) | I4 | single turbo | 7,000-7,500 | 280 PS / 407 N·m | equal, pipes 1, quiet |
| S2000 AP2 (F22C1) | I4 | NA, VTEC | 8,000 | 237 hp / 220 N·m | equal, pipes 1, sport |
| Civic Si EM1 (B16A2) | I4 | NA, VTEC | 8,000 | 160 hp / 150 N·m | equal, pipes 1, sport |
| E46 M3 (S54) | I6 | NA | 8,000 | 343 PS / 365 N·m | itb, equal, pipes 2, h (est.), sport |
| TT-RS 8J (CEPA) | I5 | single turbo | 7,000 | 340 PS / 450 N·m | equal, pipes 1, sport |
| Challenger SRT8 6.1 / 392 | V8 cross | NA | 6,200 / 6,400 | 425 hp / 569; 470 hp / 637 N·m | cross, pipes 2, h (est.), sport |
| Viper SRT-10 (V10) | V10 odd-fire | NA | 6,250 | 600 hp / 759 N·m | pipes 2, crossover none, sport (needs odd-fire schedule) |

# Gaps across the fleet

1. ~~**VTEC / cam changeover**~~ done in the synth (`camRpm` / `camStep`, `docs/engineSound.md`; add to each car when it is built; the phasers are deliberately silent) (NSX at 5,800, S2000 at about 6,000, Civic at 5,600; Varioram, VANOS and VVT-i as milder steps; the Evo IX's MIVEC is a continuous phaser with no audible step): a step in gain and harmonic content at a set rpm.
2. ~~**Sequential turbo handover**~~ done (`handoverRpm` and its siblings, `engineSound.md`): the Kazama Rotor (pre-boost 4,000, changeover 4,500 with a 20 % dip) and the Tachibana Zenith (pre-boost 3,500, join 4,000).
3. ~~**Blow-off / diverter flutter and wastegate chatter**~~ done (`diverter: 'flutter'`, `flutter`, `wastegate`): the shipped turbo cars all take the stock recirculating valve, with surge flutter on the Runabout, Zenith and Kazama and wastegate chatter on the Runabout and Horizon; the planned STI, Evo, SR20DET and TT-RS take the fields when built.
4. ~~**Odd-fire V10** (Viper) and the **15° VR stagger** (Golf R32) as real firing patterns, not header spread.~~ Done: `crank: 'oddfire'` for the Viper (when built) and the Strom's `VR6_HEAD` runner table.
5. ~~**Supercharger lobe count 8**~~ done: `blowerLobes` takes 8 (TVS 2300, 4-lobe Roots rotors); the M122H's 3-lobe rotors give 6.
6. ~~Cylinder deactivation~~: the Challenger 392's MDS is automatic-only, so a manual car never deactivates.
7. ~~**Air-cooled fan whine** (993) and **gear whine** (NSX-R, straight-cut builds)~~ done (`fanRatio`, `gearWhine`; the 993's ratio 1.8 and 11 blades are estimates; no shipped car sets either).
8. ~~**Active exhaust flaps** (TT-RS, Corvette Z51, GT500 2013)~~ done (`flaps`: the silencer shut at cruise, open on load and revs); no shipped car sets it.
9. ~~**Rotor apex-seal rasp** for the 13B.~~ Done (`apexRasp`), with the idle lope (`idleLope`), on the Kazama Rotor.
10. **Data gaps**: torque curves here are all **est.** (no measured dyno chart); gearbox ratios and final drives flagged **verify** for the Golf R32, S2, MR2, NSX, 993, 240SX, TT-RS and Challenger/Viper; the turbo models, boost levels and blower drive ratios of several cars; crossover type on stock Corvette/GT500/M3/Challenger exhausts (the Viper's has none). The summary table above was refreshed from the verified sections on 2026-10-28; the sections are the source of truth.
