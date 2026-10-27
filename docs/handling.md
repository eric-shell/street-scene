# Handling: tires, wheelspin and the drift

How a car grips, spins its wheels, drifts and gears in `src/sim/car.ts`, the numbers behind it in `src/sim/drivingParams.json`, and the sources they were set from. The aim is realistic mechanics with an arcade delivery, in the spirit of Forza Horizon's Standard steering: the physics does the work, a few aids keep it fun.

## Simcade

The physics is simcade: realistic foundations with an arcade feel. The foundations are real: the tire model (one grip curve over the normalized slip vector, the friction circle), load transfer, a top speed the drag sets, real gearing (each car's donor gearbox and an engine geared to its wheels), brake bias, and the differential's behaviour. Wherever realism would make the game less fun or less readable, an arcade aid sits on top of them, and it is named as one.

The rule for tuning: start from the real behaviour and measure it (`/tune`). Only where it does not deliver the intended feel, add an arcade term: one clearly labelled number in `drivingParams.json` (its `_` comment says it is an arcade term), validated in `tuning.ts`, neutral when off. Never fake the foundation: no grip that hides a balance problem, no force that moves the drag top speed, no gearing that is not a gearbox.

Today's arcade terms:

- **Anti spin aid** (`drift.maxSlipDeg`, `assistTorque`): past 70 degrees of body slip a torque turns the nose back toward the direction of travel: a last catch when the car is going round, never what holds a drift's angle.
- **Yaw damping** (`drift.yawDamping`, `yawDampingLowSpeed`, `yawDampingSlide`): Standard steering's stability layer while the car grips, fading to a fifth of itself as the body slides from the tires' peak slip angle (12°) to the full slide (25°), so a drift's angle is the tires' and the driver's; stronger at a crawl so a car cannot pirouette.
- **Steering help** (`steering.counterSteerAllowance`, `highSpeedDeg`, `fadeSpeed`): extra lock into a slide so full lock always reaches the direction of travel, and less lock at speed in place of a front slip angle assist.
- **Brakes** (`brakes.assistDecel`, `tires.minLateralShare`): a deceleration on top of the tires that uses no cornering grip, and an ABS that never locks and always leaves some steering.
- **Clutch tricks** (`traction.launchBoost`, `clutchKickSpeed`, `drift.clutchKickTime`): a clutch dump adds the flywheel's torque; a throttle stab after a lift while steering breaks the driven wheels loose. The handbrake drops the clutch on a car that drives the rear, as Forza does.
- **Launch control** (`launch.*`): the two-step cuts only on the grid; off the line its rpm is the launch clutch's slip rpm (`engine.launchRpm` the floor), so no launch meets the cut or drops the revs it was held at. A line lock (gas with the brake or the antilag button, standing) revs the engine free to 85% of the redline and lets the clutch bite from there, the front brakes holding the car; `lineLockRearShare` sends an AWD car's drive to the rear for it (a drift mode's trick), so every car does a rear wheel burnout. The antilag button held on from a line lock into the launch stays a launch.
- **Nitrous** (`nitrous.*`): a push along the car on top of extra engine torque, in three stages, refilled by style (drifts, near misses, slipstreams, wrecks). The push carries on past the limiter, so nitrous never dies on it. Two arcade terms ride on it, both neutral at 0: style past a full tank banks overdrive (`overdriveCap` stages, burning alongside the tank at `overdrivePower` times the stage's power), and a crash into a wall, barrier, rail or another racer costs up to `crashLoss` stages between `crashMinImpact` and `crashFullImpact` m/s of normal impact, overdrive first. Measured over AI races on four seeds, a rival loses at most 0.3 of a stage a race to crashes.
- **Gearing torque bonus** (`setup.gearing.torqueBonus`, written to `gearbox.torqueBonus`): plus 6% of engine torque on Short gearing to minus 6% on Long, fading out between 140 and 200 km/h (Gearing).
- **Forgiving limits** (`tires.loadCap`, `tires.slideGrip` and `slideGripLong`, `suspension.airLevel`, `collision.resetPassThrough`): grip that stops growing under a hard landing, sliding grip at the arcade end of dry tarmac, a body that levels out in the air, and a car that passes through the others for a moment after a reset.

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
- **Handbrake**: a rear lock. On a car that drives the rear the clutch comes out with it (as Forza does), the engine revs free with the throttle, and on release the clutch drops on it: the flywheel (`engine.inertia`, geared to each driven axle by its share) and the stopped wheels meet at the speed that keeps their angular momentum (`dumpClutch`), so the rear lights up the instant the lever goes down and the engine keeps most of its revs. Before, the revs fell to the stopped wheels in a tick and the flywheel's energy vanished: the rear took 0.2 s to spin and the drift lost speed. The locked tires' force opposes their slide, so with steering the fronts turn the car in and the rear cannot stop it: the handbrake turn is the physics, not a yaw kick.
- **Clutch kick**: a short lift then a stab while steering hard adds `clutchKickSpeed` of tread speed to the driven wheels (the flywheel's energy dumped into them) and keeps the clutch's extra torque for `clutchKickTime`.
- **Counter steer** gets `counterSteerAllowance` of extra lock per radian of body slip, so full lock always reaches the direction of travel (Forza's drift suspension and steering angle kits, and its Standard steering's quicker counter steer).
- **Aids that stay**: past `maxSlipDeg` of body slip an `assistTorque` turns the nose back toward the direction of travel (going forward, fading in from walking pace, so a car sliding slowly sideways after a spin is never whipped round); `yawDamping` holds while the car grips and mostly lets go in a slide (`yawDampingSlide`); `yawDampingLowSpeed` stops pirouettes at a crawl. The angle is the driver's: full throttle with too little counter steer spins the car, as it would.
- **Reverse** engages only at a true standstill (the whole car under 0.8 m/s, brake held 0.3 s, no handbrake). It used to look at forward speed alone, so a car sliding sideways under the handbrake and brake would select reverse and the brake, which is the throttle in reverse, drove it off backwards: the "reverse swivel".
- **The automatic** shifts on the car's speed over the ground, not the wheels' (spinning wheels would upshift a drift) nor its forward component (a sideways drift would drop into first). In a powered slide (wheelspin, throttle down) it holds its gear, as a drifter does: a downshift's clutch would hook the spinning rear back up and end the drift.

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

### Second pass: more grip, a stickier slide

Players still found the cars icy and floaty and the drifts hard to link. Raising grip alone (both axles 15%) made the RWD coupe's held drift die early (1.87 to 1.18 s over 15°): the rear's sliding force grew with it and second gear could no longer keep it spinning. What shipped keeps the drift's spin and gives the slide more bite:

- `gripFront` / `gripRear` 15% up on every car, each car's split kept (hatch 1.82 / 1.62, coupe 1.84 / 1.55, wagon 1.79 / 1.63).
- `slideGrip` 0.53 to 0.58: a slide keeps more sideways grip (with the grip rise, 26% more sideways force sliding), so it arcs and scrubs speed instead of floating.
- `slideGripLong` 0.7 to 0.6: the spinning rear's lengthways force stays where it was in newtons, so the throttle still holds a drift; it also lets a line lock break a mild car's rear loose.
- `yawInertiaScale` 0.85 to 0.75 (wagon 0.95 to 0.85): a quicker swing from one drift into the next.
- The Tune tab's ends moved with it: Rear brake balance -0.22 / -0.11 (was -0.18 / -0.09; grippier rears took the bias without stopping longer) and Locked differential 0.75 (was 0.6).

Tried and dropped: `fullSlideDeg` 30 to 32 (a slower fall past the peak) shortened held drifts (coupe 1.88 to 1.25 s) and with `slideGrip` 0.6 the flick into the next drift no longer swung through; `yawDamping` 2600 or 4000 moved nothing that mattered.

Measured headless with `drift.ts`'s closed loop (a driver holding 30° of slip; G is a lift and a flick of the wheel from a held drift, then power) and stock setups, before → after:

| | Hatch (AWD) | Coupe (RWD) | Wagon (AWD) |
|---|---|---|---|
| Peak lateral, ramp steer at 100 km/h (E) | 1.45 → 1.69 g | 1.40 → 1.63 g | 1.44 → 1.68 g |
| Garage grip stat | 1.51 → 1.74 g | 1.49 → 1.71 g | 1.50 → 1.73 g |
| Body slip at 0.6 g, 80 km/h | 2.1 → 1.7° | 2.3 → 1.8° | 2.1 → 1.6° |
| Held drift from a handbrake entry, time over 15° of 2 s (F) | 0.73 → 0.98 s | 1.87 → 1.92 s | 0.70 → 0.68 s |
| Speed through it, from 72 km/h | 85 → 77 km/h | 82 → 78 km/h | 90 → 88 km/h |
| Flick into the next drift: to 15° the other way, held (G) | never → never | 0.63 s, 1.60 s → 0.50 s, 1.73 s | never → never |
| Lift at the limit, 100 km/h, steer 0.75: slip before → worst | 6 → 8° both | 20 → 22° → 22 → 31° | 7 → 8° both |
| 0 to 100 (garage) | 6.35 → 6.30 s | 5.32 → 5.18 s | 6.02 → 6.00 s |

The coupe lets go more on a lift at the limit (a lift-off drift entry, caught as before); the AWD cars still drift on the handbrake but their front drive pulls a held drift straight within a second, as before (the AWD drift aids below are still for later).

### What we left for later

- **Load sensitivity and roll stiffness**: grip that grows less than the load, so lateral load transfer costs the axle that takes more of it, which is how Forza's anti-roll bars and springs tune the balance. Here the balance is set by grip and rounding per axle instead.
- **A steering assist on the front slip angle** (Standard steering's input layer): full lock asking for the front tires' peak slip on top of the path's own angle, so a keyboard's full lock at speed is always the most grip and turns in on the brakes. The speed fade (`steering.maxDeg`, `highSpeedDeg`, `fadeSpeed`) approximates it now.
- **A stability aid on yaw rate error** (STM-like, an option): damping only the rotation the steering did not ask for, instead of `yawDamping`'s damping of all of it.
- **AWD drift aids**: a clutch kick that breaks the rear loose more than the front, and a centre differential that can send more to the rear.
- **The differential between the wheels of an axle** (each axle is locked now, the drift setup; another pass is adding it).

## Gearing

The Gear Ratio slider (Short 1 to Long 5) used to scale the final drive alone, and players could barely feel it. Every stock car topped out against the drag well under its limiter, so Long added nothing without nitrous; an automatic keeps the revs in the same band at any final drive, so 0 to 100 moved about 3% either way, by where the shifts fell; and the coupe's 0.72 overdrive fifth left its top speed at 73% of the redline, so shorter gears made it faster.

**Stock gearing.** Each car has its donor's ratios (the R32's six speed, the FD3S's first four gears and its Type RZ final drive, Audi's 01E), with the final drive (and the coupe's fifth, 0.88) set so the top gear runs into its limiter at about the car's slipstream top speed: 1.1 times the drag top speed, which then comes at 92% of the redline, on each engine's power peak or plateau. That point is deliberate:

- The drag top speed is at its most there (on the hatch it moves under 1% anywhere from 1.05 to 1.2 times; the coupe gains 3.4% from a fifth that reaches its power plateau).
- A slipstream (30% less drag) runs the stock car up to just under its limiter, so the tow's whole gain is kept.
- Nitrous runs into the limiter partway through a full tank, but its push carries on past it, so the nitrous top speed falls only about 1% (the coupe 5%, from 343 to 327 km/h: its overdrive had left 319 km/h of room).
- The slider then moves the limiter across the range players notice: Short to 0.92 of the drag top speed (a lower top speed, on the limiter), Long to 1.3 (room for nitrous to keep pulling).

Tried and dropped: the limiter at 1.16 with a 1.25 short end (the old hatch and wagon point) made the hatch's position 2 faster at the top than stock (its power rises to the redline) and broke the wagon's 0 to 60 order.

**The slider** (`setup.gearing`). `finalDriveMul` 1.2 / 1.1 / 1 / 0.92 / 0.85 moves the top gear and its limiter. `firstGearMul` (1 throughout) holds first gear where it is and the gears between blend evenly, closer on Short and wider on Long, so no position adds a shift before 100 km/h and the garage's 0 to 60 moves one way along the slider. Real gearing alone moves a corner exit by 3% at most, so `torqueBonus` is the arcade term (Simcade): plus 6 / 3 / 0 / minus 3 / 6% of engine torque, full up to `gearbox.torqueBonusFadeStart` (39 m/s, 140 km/h) and faded out by `torqueBonusFadeEnd` (56 m/s, 200 km/h) on a smoothstep, so it shapes corner exits and never the drag top speed. Measured headless (flat world, stock setups otherwise; nitrous is a full tank held from 8 s of full throttle; the exit is braked from 130 to 60 km/h, then floored):

| Position 1 / 3 / 5 | Hatch | Coupe | Wagon |
|---|---|---|---|
| Top speed, km/h (the garage's) | 203 / 224 / 219 | 211 / 234 / 233 | 206 / 227 / 225 |
| On nitrous, km/h | 299 / 307 / 319 | 319 / 327 / 338 | 294 / 304 / 317 |
| 200 to 280 on nitrous, s | 9.0 / 7.1 / 5.2 | 6.8 / 5.1 / 4.1 | 9.6 / 7.5 / 5.4 |
| 0 to 100, s | 5.97 / 6.35 / 6.77 | 5.02 / 5.32 / 5.67 | 5.65 / 6.02 / 6.42 |
| Corner exit 60 to 140, s | 8.85 / 9.45 / 10.25 | 6.80 / 7.43 / 8.23 | 8.23 / 8.88 / 9.60 |

Long's drag top speed stays within 2.5% of stock: a taller top gear meets the drag at lower revs, so a slipstream alone takes it no faster than stock (the foundation, kept). AI races on today's city routes never pass 185 km/h, so there Short is about 0.4% quicker and Long 0.7% slower; Long pays off on long straights and nitrous runs.

## Numbers

| Parameter | Value | Why |
|---|---|---|
| `tires.peakSlipRatio` | 0.12 | Michelin: peak grip at 5 to 15% slip; Magic Formula dry tarmac peaks near 0.18. |
| `tires.peakSlipDeg` / `fullSlideDeg` | 12 / 25 | Unchanged lateral curve: the peak and the slide past it. |
| `tires.roundingFront` / `roundingRear` | 0.5 / 1 | The rise to the peak: 1.5 and 2 times the straight line's stiffness at small slip. The steeper rear makes the cars understeer slightly below the limit (Grip and drift). |
| `tires.gripFront` / `gripRear` | base 1.82 / 1.54; hatch 1.82 / 1.62, coupe 1.84 / 1.55, wagon 1.79 / 1.63 | The second pass: 15% over 1.58 / 1.34 (hatch 1.58 / 1.41, coupe 1.6 / 1.35, wagon 1.56 / 1.42), which had moved grip rearward from 1.62 / 1.28. The rear still peaks lower and lets go first at the limit. |
| `tires.slideGrip` | 0.58 | Sideways sliding grip, was 0.53: a slide bites more and floats less (arcade: slides still grow and want catching). |
| `tires.slideGripLong` | 0.6 | Lengthways sliding grip, was 0.7. Dry tarmac keeps 75 to 90% of peak when sliding; this is under it, an arcade number: it holds the spinning rear's force in newtons where it was before the grip rise, so a stock car's second gear torque still spins its rear in a drift and a line lock breaks any car loose. |
| `yawInertiaScale` | 0.75 (wagon 0.85) | Was 0.85 (0.95): the swing from one drift into the next. |
| `launch.lineLockRearShare` | 1 | Arcade: an AWD car's line lock is a rear wheel burnout. |
| `engine.inertia` | 0.15 | Flywheel, crank and clutch (kg m²), reflected through the gearing squared (first gear: about 30 kg m² at the wheels). In first the stock rear reaches the limiter in about 0.65 s and hooks back up in under 0.5 s; 0.2 made both a third slower. |
| `traction.wheelInertia` | 1.2 | Wheel, tire, hub, disc and half shaft (kg m²). |
| `brakes.handbrakeTorque` | 6000 | Above the rear tires' resistance (about 3100 Nm on base tuning), so it locks at once. |
| `traction.clutchKickSpeed` | 6 | Tread speed a kick adds (m/s). |
| `traction.tcSlipTarget` / `tcMinDrive` | 0.94 / 0.2 | Traction control's drive cap inside the peak, and the drive it always leaves. |
| `steering.counterSteerAllowance` | 1 | Full lock reaches the direction of travel at any slip angle. |
| `drift.maxSlipDeg` / `assistTorque` | 70 / 22750 | The anti spin aid, a last catch (was 55, which held every drift's angle there). |
| `drift.yawDampingSlide` | 0.2 | Share of `yawDamping` left in a full slide. 1 is the old always-on damping; with 0.2 a driver who leads the swing with counter steer links and holds drifts as before (`drift.ts` G, coupe: to 15° the other way in 0.50 s, held 1.75 of 2 s, worst 33°), while ordinary cornering, lifts at the grip limit and the step steer are unchanged. A car already 17° into a power slide that is lifted with the wheel held now spins (it was caught at 37°); caught with counter steer it stops at 43°. |
| `nitrous.force` / `torqueMul` | 5500 N / 1.35 | Was 3600 / 1.25. The push along the car is what tells at speed, where the engine's torque no longer can: stage 1 at 160 km/h now adds about 3 m/s² on a stock hatch (was 1.8), and 100 to 200 km/h on a full tank takes 4.2 s (was 6.2). |
| `nitrous.stagePower` | 1 / 1.15 / 1.3 | Was 1 / 1.1 / 1.2: the upper stages kick harder. |
| `nitrous.capacity` | 3.6 s per stage | Was 3.2. A stage is worth about 60 km/h from 100 (was 35). |
| `gearbox.ratios` / `finalDrive` | hatch 3.36 / 2.09 / 1.47 / 1.10 / 0.87 / 0.73 × 4.4; coupe 3.483 / 2.015 / 1.391 / 1.000 / 0.88 × 4.3; wagon 3.5 / 1.88 / 1.32 / 1.034 / 0.857 / 0.73 × 4.375 | Was the generic 3.25 / 2.15 / 1.6 / 1.25 / 1.02 / 0.85 × 3.6 (hatch) and × 3.62 (wagon), coupe 3.48 / 2.02 / 1.39 / 1.0 / 0.72 × 4.3. Donor spacing, the top gear's limiter at the slipstream top speed (Gearing). |
| `setup.gearing.finalDriveMul` / `firstGearMul` | 1.2 / 1.1 / 1 / 0.92 / 0.85; 1 throughout | The top gear's limiter at 0.92 to 1.3 times the drag top speed; first gear held, the gears between blended evenly. |
| `setup.gearing.torqueBonus` | +0.06 / +0.03 / 0 / -0.03 / -0.06 | The arcade term: with the real gearing, corner exits come out 6 to 9% quicker on Short and 8 to 11% slower on Long; it is gone between `gearbox.torqueBonusFadeStart` and `torqueBonusFadeEnd` (39 and 56 m/s). |

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

Gearing pass (spec listings and owners' forums, not factory sheets; the R32's fourth gear is not in its listing):

- RX-7 FD3S five speed, 3.483 / 2.015 / 1.391 / 1.000, final drive 4.100 (Type R) and 4.300 (Type RZ): https://carfromjapan.com/specifications/mazda/rx7/5813aa222afaa2c4b286b001 and https://carfromjapan.com/specifications/mazda/rx-7/5813aa2b2afaa2c4b286b005
- Golf R32 six speed, 3.36 / 2.09 / 1.47 / 0.87 / 0.73: https://www.supercars.net/blog/2006-volkswagen-golf-r32
- Audi 01E six speed, 3.5 / 1.88 / 1.32 / 1.034 / 0.857 on a 4.11 final drive (S4, S6): https://www.gt40s.com/threads/batch-of-audi-01e-6-speeds.31761; the S2 and RS2's 0.730 sixth: https://www.audiworld.com/forums/performance-tuning-10/anyway-change-gear-ratio-1967261/; the allroad's 4.375 final drive: https://12v.org/urs/charlie_smith/01E/ind5.html
