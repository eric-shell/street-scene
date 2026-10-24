# Handling: tires, wheelspin and the drift

How a car grips, spins its wheels and drifts in `src/sim/car.ts`, the numbers behind it in `src/sim/drivingParams.json`, and the sources they were set from. The aim is realistic mechanics with an arcade delivery, in the spirit of Forza Horizon's Standard steering: the physics does the work, a few aids keep it fun.

## The tire

Every wheel's road velocity is taken in its own frame (`wl` along the wheel, `wt` across it). Two slips come out of it:

- **Slip angle** `alpha = atan2(wt, max(|wl|, 2.5))`, normalized as `sy = |alpha| / peakSlipDeg`.
- **Slip ratio** `kappa = (treadSpeed - wl) / max(|wl|, 2.5)`, normalized as `sx = kappa / peakSlipRatio`. The 2.5 m/s floor is numerical conditioning (`SLIP_REF_SPEED`), not tuning.

The force is one grip curve over the length of the slip vector `rho = sqrt(sx² + sy²)`, pointed against it: `|F| = gripAt(rho) · mu · load`, `Fx = |F| · sx / rho`, `Fy = -|F| · sy / rho`. `gripAt` rises to 1 at `rho = 1` as `rho · (1 + k · (1 - rho))`, with `k` the axle's rounding (`roundingFront`, `roundingRear`): a straight line at 0, at 1 twice as steep at zero slip and flat into the peak, the Magic Formula's shape. Past the peak it falls to the sliding grip at `rho = fullSlideDeg / peakSlipDeg` and stays there. The rounding only shapes the grip below the peak (ordinary driving); the peak and everything past it (slides, drifts, spinning and locked wheels) are the same at any rounding. Below the peak a drive or brake force now takes a little sideways force too (`Fy = mu · load · sy · (1 + k · (1 - rho))`), as a real tire does before it saturates. The sliding grip is `slideGrip` for a sideways slide and `slideGripLong` for a lengthways one (a spinning or locked wheel going straight), blended by the direction of the slip. This is the normalization Forza's telemetry exposes (`TireSlipRatio`, `TireSlipAngle`, `TireCombinedSlip`, each "0 means full grip, beyond 1 means loss of grip") and Beckman's combined grip model: the friction circle falls out of it, since a tire that spins (large `sx`) points its force forward and has less of it left sideways. A tire at its lateral peak keeps about half its cornering force once it spins 15% faster than the road, which is Michelin's figure.

The foot brake stays arcade: an ABS that never locks, taking from the sideways force by the friction circle but never below `minLateralShare`, plus `assistDecel` on top of the tires. The assist acts along the car's path and fades as it goes sideways, so braking in a slide slows the slide instead of turning it into a pure sideways one.

## The axles

Each axle is a rigid pair of wheels (a locked differential, the drift setup) with its own tread speed (`wheelSpeedFront`, `wheelSpeedRear`), inertia `2 · wheelInertia` plus, while the clutch is out, the engine's `inertia` times the gearing squared. `updateAxles` runs every substep:

1. From both tires: the rolling speed where neither slips, the pair's grip, and `cap`, the forward force it holds at its current sideways slip (the slip vector at the peak slip ratio).
2. **Holding**: slip ratio under the peak and drive torque under `cap · R`. The tires transmit the torque exactly, split by grip, at a slip ratio in proportion to the capacity used; the tread speed moves there as fast as the torques in play could take it and never past it. Quasi static, so it is stable at any speed, gear and tick rate (an explicit slip ratio integration is not, at a crawl in a high gear).
3. **Spinning or locked**: the axle integrates `I · dω = T - R · Fx(kappa)` against what the sliding tires give back. In a drift the rear's `cap` is a fraction of its grip, so a stock car's drive torque spins it; the tread settles where the sliding force balances the torque, or runs to the limiter when nothing does. In gear the engine turns with the driven wheels (`rpm` comes from their speed), which is what takes it to the limiter.
4. The foot brake pulls spinning wheels back to road speed, never under it. The handbrake pulls the rear axle to zero at `handbrakeTorque`, above what the tires hold back, so it locks in about a tenth of a second.

The engine's inertia matters: in first gear the drivetrain's reflected inertia is many times the wheels', so the rear spins up and hooks back up over about half a second; in higher gears it is quicker. Traction control caps the drive at `tcSlipTarget` of the force that keeps the slip vector inside the peak (`tcMinDrive` of the grip always allowed, so it can pull out of a slide), which costs no cornering grip and never spins, and cuts the throttle past `tcMaxSlipDeg` of body slip. AI opponents always drive with it.

The garage's Differential slider (`drivetrain.diffOpen` / `diffLock`, both 0 on the stock axle above) changes two things on the driven axles only. **Open**: an open differential gives both wheels the same torque, so once the drive passes twice what the lighter wheel holds, that wheel breaks loose and the axle transmits only twice its sliding force (`slideGripLong`); `diffOpen` blends there from the stock axle. The heavier wheel keeps its cornering grip, so the car stays steady while drive fades as a corner or a kerb lifts the inside wheel, and a powered slide dies because the rear can no longer be kept spinning. **Locked**: while the axle holds, each wheel also carries the force a rigid axle makes in a turn (the inside wheel driven past its road speed, the outside held under it), up to `diffLock` of the axle's capacity by the slip ratio difference over the peak. The pair resists the rotation (push on turn in, a steadier and harder drive out), and it counts against each wheel's capacity, so the axle stops holding once drive plus pair passes it; spinning, the axle is the stock rigid one and holds a slide the same way.

## The drift

- **Throttle sets the angle.** Power spins the rear; the spinning tire's force points forward and its sideways share collapses, so the rear steps out and the thrust along the car keeps the speed up. Lift and the tires pull the wheels back, the sideways grip returns and the car straightens. With counter steer held short of full lock the car settles at an angle; full lock points the fronts along the direction of travel and straightens it at any throttle. The drift is an unstable equilibrium (Hindiyeh, Stanford 2013: rear tires saturated, front near saturation, drive force with lateral authority through the coupling), which is why it needs the driver, and why the aid below exists.
- **Handbrake**: a rear lock. On a car that drives the rear the clutch comes out with it (as Forza does), the engine revs free with the throttle and lets go onto the locked axle on release, the flywheel's slip adding torque (`launchBoost`) and the wheels lighting up. The locked tires' force opposes their slide, so with steering the fronts turn the car in and the rear cannot stop it: the handbrake turn is the physics, not a yaw kick.
- **Clutch kick**: a short lift then a stab while steering hard adds `clutchKickSpeed` of tread speed to the driven wheels (the flywheel's energy dumped into them) and keeps the clutch's extra torque for `clutchKickTime`.
- **Counter steer** gets `counterSteerAllowance` of extra lock per radian of body slip, so full lock always reaches the direction of travel (Forza's drift suspension and steering angle kits, and its Standard steering's quicker counter steer).
- **Aids that stay**: past `maxSlipDeg` of body slip an `assistTorque` turns the nose back toward the direction of travel (going forward, fading in from walking pace, so a car sliding slowly sideways after a spin is never whipped round); `yawDamping` is always on; `yawDampingLowSpeed` stops pirouettes at a crawl.
- **Reverse** engages only at a true standstill (the whole car under 0.8 m/s, brake held 0.3 s, no handbrake). It used to look at forward speed alone, so a car sliding sideways under the handbrake and brake would select reverse and the brake, which is the throttle in reverse, drove it off backwards: the "reverse swivel".
- **The automatic** shifts on the car's speed over the ground, not the wheels' (spinning wheels would upshift a drift) nor its forward component (a sideways drift would drop into first).

## Grip and drift

Ordinary cornering felt icy: the car took over a second to answer the wheel, sat 4 to 7 degrees sideways at 0.6 g, and above about 100 km/h kept rotating on its own. This section is what Forza Horizon does about grip and drift, what the cause here was, and what changed.

### What Forza Horizon does

Playground has not published Horizon's tire model; Horizon and Motorsport share the ForzaTech physics, "watered down for arcade playability" in Horizon (Jalopnik). What is public:

- **One tire model, two setups.** Horizon does not switch physics for drifting. A drift tune is a setup on the same model: traction and stability control off, the differential fully locked on acceleration and deceleration, brake balance to the front, drift compound tires, a rear that is free to spin (drifted.com). A stock car with the aids on grips. The grip and drift behaviour come from the same curve: below the peak for grip, past the rear's peak (held there with throttle) for drift.
- **Normalized slip.** Forza's telemetry gives each tire's slip angle, slip ratio and combined slip normalized so 1 is the peak and above 1 is sliding (Data Out documentation). Our model has used the same normalization since the wheel speed pass.
- **Standard steering is a stability layer.** A developer quote passed around the Forza forums: Normal steering has an input layer and a vehicle dynamics layer that "influences the yaw inertia of the car to help maintain control during rapid lock-to-lock steering", less agile but more stable; Simulation turns both off. Players find slides easier to catch with it. Stability control (STM) brakes single wheels or cuts power when the car slides, which is why drifters turn it off.
- **Grip from the tire, not the aids.** FH5's handling pass was "more accurately modelling tyre grip" for "much better sensitivity to inputs", grip per corner from its own suspension load, and a reworked ABS (racinggames.gg, from Playground's previews).
- **The curve's shape.** Street tires peak at higher slip angles with a broad peak and a gradual fall past it, which is what makes them easy to drift; slicks peak sharper and drop off harder (MotoIQ). The Magic Formula's lateral shape factor (C about 1.3, against 1.9 lengthways) is what gives the lateral curve its rounded, broad top: steep at small slip, flat near the peak, most of the force kept past it.
- **Balance below the limit.** A car whose front axle has more cornering stiffness per unit load than its rear has a negative understeer gradient: past a critical speed it is unstable and keeps rotating, and only damping holds it (Wikipedia, *Understeer and oversteer*; Gillespie's understeer gradient `K = Wf/Cf - Wr/Cr`). Road cars are tuned to understeer slightly in the linear range and let the rear go only near the limit or when provoked (lift, trail brake, power). Forza's ARB, spring and differential tuning works through load transfer and tire load sensitivity (the forum consensus that more differential deceleration lock calms lift-off oversteer; Wikipedia, *Tire load sensitivity*).

### The cause here

Every car is 50/50, and the tire rose in a straight line to its peak at 12 degrees for both axles, so cornering stiffness was proportional to grip: gripFront 1.62 against gripRear 1.28 to 1.38 made every car oversteer in the linear range. Critical speeds came out at 96 km/h (coupe), 114 (hatch), 126 (wagon); above them only `yawDamping` kept the car from rotating away, so yaw rate took 2.8 to 3.2 s to settle at 130 km/h and a lift at the limit spun it. The straight line to a late peak also meant big slip angles in ordinary corners: 4 degrees of body slip at 0.6 g at 80 km/h, 10 to 12 at the limit.

### What we applied

- **A rounded rise per axle** (`roundingFront` 0.5, `roundingRear` 1): cornering stiffness at small slip 1.5 times the old line at the front and twice it at the rear, flat into the same peak. The rear, steeper than the front, makes the car slightly understeer below the limit (about 0.8 degrees per g on the hatch) while its lower peak still lets go first at the limit: the slide starts near the real limit, on a flat top, so it builds progressively. The peak (12 degrees), the fall past it (to 0.53 by 25 degrees), the slip normalization and everything the drifts use are unchanged.
- **A narrower grip split**, average kept (the garage's handling stat moves by 0.01 g): front 0.04 lower, rear 0.05 to 0.06 higher on every car. The coupe keeps the widest split (1.6 / 1.35), the RWD character; the wagon the narrowest.
- **Tried and dropped:** an earlier peak (8 degrees with the slip ratio scaled to match) was as tight in steady state but put the front tires past their peak at full lock, so a full-lock trail-brake entry no longer turned the coupe (22 to 7 degrees) and handbrake and clutch-kick rotations got weaker; more `yawDamping` (4000) calmed high speed a little and damped the coupe's power slides (56 to 36 degrees); a shorter steering fade did not help; `slideGrip` 0.6 and 0.66 changed little either way.

Measured headless (flat world, stock builds), before → after:

| | Hatch (AWD) | Coupe (RWD) | Wagon (AWD) |
|---|---|---|---|
| Step steer to 0.6 g at 80 km/h, yaw rate to 90% | 1.08 → 0.23 s | 1.40 → 0.28 s | 1.08 → 0.28 s |
| Same at 130 km/h | 2.93 → 0.27 s | 3.15 → 0.40 s | 2.78 → 0.30 s |
| Body slip at 0.6 g, 80 / 130 km/h (before, the 130 km/h step kept rotating on to 0.7 to 0.9 g) | 3.7 / 5.5 → 1.6 / 2.4° | 3.9 / 6.3 → 1.7 / 2.4° | 3.6 / 5.1 → 1.6 / 2.3° |
| Lift at 95% of the limit, 80 km/h: body slip before → worst after the lift | 7.5 → 7.5° (yaw rate +29%) → 6 → 6° | 20 → 57° (spun) → 7 → 7° | 8 → 11° → 6 → 6° |
| Same at 130 km/h | 20 → 53° (spun) → 8 → 11° | 12 → 50° (spun) → 20 → 56°: on the throttle at 95% of the limit the RWD coupe is already in a power slide | 20 → 52° (spun) → 8 → 10° |
| Keyboard full lock held at 110 km/h, body slip | 18° → 11° | 36° → 23° | 21° → 12° |
| Full lock caught with counter steer after 0.25 s, 120 km/h: worst slip, time back under 4° | 23°, 1.5 s → 13°, 0.8 s | 30°, 1.7 s → 20°, 1.0 s | 23°, 1.6 s → 13°, 0.8 s |
| Handbrake flick held on the throttle: worst slip, time over 15° | 33°, 0.95 s → 33°, 0.95 s | 32°, 2.9 s → 32°, 2.9 s | 28°, 0.8 s → 28°, 0.8 s |
| Clutch kick at 70 km/h, wheel turned: worst slip, time over 15° | 17°, 0.35 s → 7° | 62°, 2.4 s → 62°, 2.3 s | 20°, 0.67 s → 9° |
| Trail-brake entry from 120 km/h, full lock, then power | 10° → 6° | 22°, 1.6 s → 22°, 1.2 s | 10° → 6° |
| Floor it mid corner at 45 km/h | 7° → 6° | 61°, 1.7 s → 56°, 1.4 s | 7° → 5° |
| Peak lateral grip, ramp steer at 100 km/h | 1.48 → 1.46 g | 1.36 → 1.41 g | 1.48 → 1.45 g |

The coupe drifts as it did: handbrake, clutch kick, a trail-brake entry and power all rotate it. The AWD cars still drift on the handbrake as before, but a clutch kick or a braked entry rotates them less (those were 10 to 20 degree flicks that never held, and now the rear stays planted), which suits a Haldex hatch and a Torsen wagon. AI races (six seeds, circuit and sprint, hard, all three cars) all finish, about 1.5% quicker, with fewer wall hits (49 against 64).

### What we left for later

- **Load sensitivity and roll stiffness**: grip that grows less than the load, so lateral load transfer costs the axle that takes more of it, which is how Forza's anti-roll bars and springs tune the balance. Here the balance is set by grip and rounding per axle instead.
- **A steering assist on the front slip angle** (Standard steering's input layer): full lock asking for the front tires' peak slip on top of the path's own angle, so a keyboard's full lock at speed is always the most grip and turns in on the brakes. The speed fade (`steering.maxDeg`, `highSpeedDeg`, `fadeSpeed`) approximates it now.
- **A stability aid on yaw rate error** (STM-like, an option): damping only the rotation the steering did not ask for, instead of `yawDamping`'s damping of all of it.
- **AWD drift aids**: a clutch kick that breaks the rear loose more than the front, and a centre differential that can send more to the rear.
- **The differential between the wheels of an axle** (each axle is locked now, the drift setup; another pass is adding it).

## Numbers

| Parameter | Value | Why |
|---|---|---|
| `tires.peakSlipRatio` | 0.12 | Michelin: peak grip at 5 to 15% slip; Magic Formula dry tarmac peaks near 0.18. |
| `tires.peakSlipDeg` / `fullSlideDeg` | 12 / 25 | Unchanged lateral curve: the peak and the slide past it. |
| `tires.roundingFront` / `roundingRear` | 0.5 / 1 | The rise to the peak: 1.5 and 2 times the straight line's stiffness at small slip. The steeper rear makes the cars understeer slightly below the limit (Grip and drift). |
| `tires.gripFront` / `gripRear` | base 1.58 / 1.34; hatch 1.58 / 1.41, coupe 1.6 / 1.35, wagon 1.56 / 1.42 | Was 1.62 / 1.28 (hatch 1.62 / 1.36, coupe 1.64 / 1.3, wagon 1.6 / 1.38): the rear still peaks lower and lets go first at the limit, the average is the same. |
| `tires.slideGrip` | 0.53 | Unchanged sideways sliding grip (arcade: slides grow and want catching). |
| `tires.slideGripLong` | 0.7 | Lengthways sliding grip. Dry tarmac keeps 75 to 90% of peak when sliding; 0.7 is the arcade end of that, low enough that a stock car's second gear torque spins its rear in a drift, high enough for burnouts to still go. |
| `engine.inertia` | 0.15 | Flywheel, crank and clutch (kg m²), reflected through the gearing squared (first gear: about 30 kg m² at the wheels). In first the stock rear reaches the limiter in about 0.65 s and hooks back up in under 0.5 s; 0.2 made both a third slower. |
| `traction.wheelInertia` | 1.2 | Wheel, tire, hub, disc and half shaft (kg m²). |
| `brakes.handbrakeTorque` | 6000 | Above the rear tires' resistance (about 3100 Nm on base tuning), so it locks at once. |
| `traction.clutchKickSpeed` | 6 | Tread speed a kick adds (m/s). |
| `traction.tcSlipTarget` / `tcMinDrive` | 0.94 / 0.2 | Traction control's drive cap inside the peak, and the drive it always leaves. |
| `steering.counterSteerAllowance` | 1 | Full lock reaches the direction of travel at any slip angle. |
| `drift.maxSlipDeg` / `assistTorque` | 55 / 22750 | The anti spin aid. |
| `nitrous.force` / `torqueMul` | 5500 N / 1.35 | Was 3600 / 1.25. The push along the car is what tells at speed, where the engine's torque no longer can: stage 1 at 160 km/h now adds about 3 m/s² on a stock hatch (was 1.8), and 100 to 200 km/h on a full tank takes 4.2 s (was 6.2). |
| `nitrous.stagePower` | 1 / 1.15 / 1.3 | Was 1 / 1.1 / 1.2: the upper stages kick harder. |
| `nitrous.capacity` | 3.6 s per stage | Was 3.2. A stage is worth about 60 km/h from 100 (was 35). |

## Measuring

Headless, against the real sim: `npx tsx .claude/skills/tune/drift.ts [carId]` prints a trace every 0.1 s of four scenarios (a handbrake flick held on the throttle, handbrake plus brake at speed, flooring it mid corner, a launch): speed, slip angle, yaw rate, rpm, gear, rear spin, tread speed against road speed. `npx tsx .claude/skills/tune/measure.ts` has the stats (0 to 100, top speed) on the stock setup and for each Tune tab slider position. The grip numbers in Grip and drift come from the same flat world driven open loop: a slow ramp of the wheel at a held speed (peak lateral g), a step of the wheel to 0.6 g (yaw rate rise and settle, body slip), a lift at 95% of the limit, keyboard full lock (the wheel ramping at 3.2/s) held for 1.5 s, the same caught by a counter steering driver who reacts after 0.25 s, and the drift entries above. Any change here alters every replay, ghost and best time.

## Sources

- Forza Motorsport Data Out documentation (per wheel `TireSlipRatio`, `TireSlipAngle`, `TireCombinedSlip` normalized to the peak, `WheelRotationSpeed`), support.forza.net.
- FH4 / FH5 wheel setup and tuning pages: Normal (Standard) steering "influences the yaw inertia of the car" and damps it, Simulation turns that off; TCS cuts power and brakes the spinning wheel; STM brakes wheels at the onset of oversteer. Assist text: brakes and handbrake together lock all four wheels.
- Forza Motorsport 2023: eight contact points per tire at 360 Hz (Chris Esaki); FM5's Calspan tire testing.
- Michelin, *The Tyre: Grip*: peak at 5 to 15% slip, µ falls to the locked value within 0.2 s of lock up, ABS holds 10 to 20% slip where the tire keeps about half its transverse capacity.
- MathWorks Magic Formula coefficients (dry B 10, C 1.9, D 1, E 0.97): peak µ at κ ≈ 0.18, 0.92 of peak at κ = 1; wet peaks at 0.09 and keeps 0.78.
- Beckman, *The Physics of Racing* part 25: combined grip from a slip vector normalized per axis.
- Hindiyeh, *Dynamics and Control of Drifting in Automobiles*, Stanford 2013: drift as an unstable equilibrium with rear wheelspin and the drive force's lateral authority.
- Drift tune conventions in FH5 (drifted.com, racinggames.gg): rear differential 100% locked, brake balance to the front, gear so the drift gear sits just under the limiter.

Grip and drift pass:

- Forza Motorsport Data Out documentation: https://support.forza.net/hc/en-us/articles/21742934024211-Forza-Motorsport-Data-Out-Documentation
- Normal against Simulation steering, the developer quote on yaw inertia and lock-to-lock stability: https://forums.forza.net/t/normal-steering-or-simulation/23830 and https://forums.forza.net/t/steering-normal-or-simulation/98148
- FH5's handling changes (tire grip, grip per corner from the suspension, ABS): https://racinggames.gg/article/forza-horizon-5-major-handling-upgrades-revealed
- Horizon and Motorsport on the same ForzaTech physics: https://jalopnik.com/forza-horizon-5-will-handle-better-have-a-more-engagin-1847526912
- FH5 drift tune and assists (TCS and STM off, locked differential, drift tires, front brake balance): https://drifted.com/forza-horizon-5-drift-tune and https://racinggames.gg/article/taking-the-wheel-which-driving-assists-to-turn-off-in-forza-horizon-6
- Differential deceleration lock against lift-off oversteer (community consensus, disputed in places): https://forums.forza.net/t/lift-off-oversteer/75495 and https://forums.forza.net/t/differential/29318
- Forza Motorsport's 2023 tire model (eight contact points at 360 Hz): https://www.gtplanet.net/forza-motorsport-new-tire-model-20210528/
- Street tires against slicks, the broad peak and the gradual fall past it: https://motoiq.com/driver-development-car-control/2/
- Magic Formula lateral and longitudinal shape factors (C 1.3 and 1.9): https://help.juliahub.com/dyad/dev/stdlib/MultibodyComponents/components/PacejkaSlippingWheel.html and https://en.wikipedia.org/wiki/Hans_B._Pacejka
- Understeer gradient and the oversteering car's critical speed: https://en.wikipedia.org/wiki/Understeer_and_oversteer (Gillespie, *Fundamentals of Vehicle Dynamics*, for `K = Wf/Cf - Wr/Cr` and `v_crit = sqrt(g L / -K)`)
- Tire load sensitivity: https://en.wikipedia.org/wiki/Tire_load_sensitivity
