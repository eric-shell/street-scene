# Handling: tires, wheelspin and the drift

How a car grips, spins its wheels and drifts in `src/sim/car.ts`, the numbers behind it in `src/sim/drivingParams.json`, and the sources they were set from. The aim is realistic mechanics with an arcade delivery, in the spirit of Forza Horizon's Standard steering: the physics does the work, a few aids keep it fun.

## The tire

Every wheel's road velocity is taken in its own frame (`wl` along the wheel, `wt` across it). Two slips come out of it:

- **Slip angle** `alpha = atan2(wt, max(|wl|, 2.5))`, normalized as `sy = |alpha| / peakSlipDeg`.
- **Slip ratio** `kappa = (treadSpeed - wl) / max(|wl|, 2.5)`, normalized as `sx = kappa / peakSlipRatio`. The 2.5 m/s floor is numerical conditioning (`SLIP_REF_SPEED`), not tuning.

The force is one grip curve over the length of the slip vector `rho = sqrt(sx² + sy²)`, pointed against it: `|F| = gripAt(rho) · mu · load`, `Fx = |F| · sx / rho`, `Fy = -|F| · sy / rho`. `gripAt` rises linearly to 1 at `rho = 1`, then falls to the sliding grip at `rho = fullSlideDeg / peakSlipDeg` and stays there. The sliding grip is `slideGrip` for a sideways slide and `slideGripLong` for a lengthways one (a spinning or locked wheel going straight), blended by the direction of the slip. This is the normalization Forza's telemetry exposes (`TireSlipRatio`, `TireSlipAngle`, `TireCombinedSlip`, each "0 means full grip, beyond 1 means loss of grip") and Beckman's combined grip model: the friction circle falls out of it, since a tire that spins (large `sx`) points its force forward and has less of it left sideways. A tire at its lateral peak keeps about half its cornering force once it spins 15% faster than the road, which is Michelin's figure.

The foot brake stays arcade: an ABS that never locks, taking from the sideways force by the friction circle but never below `minLateralShare`, plus `assistDecel` on top of the tires. The assist acts along the car's path and fades as it goes sideways, so braking in a slide slows the slide instead of turning it into a pure sideways one.

## The axles

Each axle is a rigid pair of wheels (a locked differential, the drift setup) with its own tread speed (`wheelSpeedFront`, `wheelSpeedRear`), inertia `2 · wheelInertia` plus, while the clutch is out, the engine's `inertia` times the gearing squared. `updateAxles` runs every substep:

1. From both tires: the rolling speed where neither slips, the pair's grip, and `cap`, the forward force it holds at its current sideways slip (the slip vector at the peak slip ratio).
2. **Holding**: slip ratio under the peak and drive torque under `cap · R`. The tires transmit the torque exactly, split by grip, at a slip ratio in proportion to the capacity used; the tread speed moves there as fast as the torques in play could take it and never past it. Quasi static, so it is stable at any speed, gear and tick rate (an explicit slip ratio integration is not, at a crawl in a high gear).
3. **Spinning or locked**: the axle integrates `I · dω = T - R · Fx(kappa)` against what the sliding tires give back. In a drift the rear's `cap` is a fraction of its grip, so a stock car's drive torque spins it; the tread settles where the sliding force balances the torque, or runs to the limiter when nothing does. In gear the engine turns with the driven wheels (`rpm` comes from their speed), which is what takes it to the limiter.
4. The foot brake pulls spinning wheels back to road speed, never under it. The handbrake pulls the rear axle to zero at `handbrakeTorque`, above what the tires hold back, so it locks in about a tenth of a second.

The engine's inertia matters: in first gear the drivetrain's reflected inertia is many times the wheels', so the rear spins up and hooks back up over about half a second; in higher gears it is quicker. Traction control caps the drive at `tcSlipTarget` of the force that keeps the slip vector inside the peak (`tcMinDrive` of the grip always allowed, so it can pull out of a slide), which costs no cornering grip and never spins, and cuts the throttle past `tcMaxSlipDeg` of body slip. AI opponents always drive with it.

## The drift

- **Throttle sets the angle.** Power spins the rear; the spinning tire's force points forward and its sideways share collapses, so the rear steps out and the thrust along the car keeps the speed up. Lift and the tires pull the wheels back, the sideways grip returns and the car straightens. With counter steer held short of full lock the car settles at an angle; full lock points the fronts along the direction of travel and straightens it at any throttle. The drift is an unstable equilibrium (Hindiyeh, Stanford 2013: rear tires saturated, front near saturation, drive force with lateral authority through the coupling), which is why it needs the driver, and why the aid below exists.
- **Handbrake**: a rear lock. On a car that drives the rear the clutch comes out with it (as Forza does), the engine revs free with the throttle and lets go onto the locked axle on release, the flywheel's slip adding torque (`launchBoost`) and the wheels lighting up. The locked tires' force opposes their slide, so with steering the fronts turn the car in and the rear cannot stop it: the handbrake turn is the physics, not a yaw kick.
- **Clutch kick**: a short lift then a stab while steering hard adds `clutchKickSpeed` of tread speed to the driven wheels (the flywheel's energy dumped into them) and keeps the clutch's extra torque for `clutchKickTime`.
- **Counter steer** gets `counterSteerAllowance` of extra lock per radian of body slip, so full lock always reaches the direction of travel (Forza's drift suspension and steering angle kits, and its Standard steering's quicker counter steer).
- **Aids that stay**: past `maxSlipDeg` of body slip an `assistTorque` turns the nose back toward the direction of travel (going forward, fading in from walking pace, so a car sliding slowly sideways after a spin is never whipped round); `yawDamping` is always on; `yawDampingLowSpeed` stops pirouettes at a crawl.
- **Reverse** engages only at a true standstill (the whole car under 0.8 m/s, brake held 0.3 s, no handbrake). It used to look at forward speed alone, so a car sliding sideways under the handbrake and brake would select reverse and the brake, which is the throttle in reverse, drove it off backwards: the "reverse swivel".
- **The automatic** shifts on the car's speed over the ground, not the wheels' (spinning wheels would upshift a drift) nor its forward component (a sideways drift would drop into first).

## Numbers

| Parameter | Value | Why |
|---|---|---|
| `tires.peakSlipRatio` | 0.12 | Michelin: peak grip at 5 to 15% slip; Magic Formula dry tarmac peaks near 0.18. |
| `tires.peakSlipDeg` / `fullSlideDeg` | 12 / 25 | Unchanged lateral curve: the car corners as before. |
| `tires.slideGrip` | 0.53 | Unchanged sideways sliding grip (arcade: slides grow and want catching). |
| `tires.slideGripLong` | 0.7 | Lengthways sliding grip. Dry tarmac keeps 75 to 90% of peak when sliding; 0.7 is the arcade end of that, low enough that a stock car's second gear torque spins its rear in a drift, high enough for burnouts to still go. |
| `engine.inertia` | 0.15 | Flywheel, crank and clutch (kg m²), reflected through the gearing squared (first gear: about 30 kg m² at the wheels). In first the stock rear reaches the limiter in about 0.65 s and hooks back up in under 0.5 s; 0.2 made both a third slower. |
| `traction.wheelInertia` | 1.2 | Wheel, tire, hub, disc and half shaft (kg m²). |
| `brakes.handbrakeTorque` | 6000 | Above the rear tires' resistance (about 3100 Nm on the Proto Compact), so it locks at once. |
| `traction.clutchKickSpeed` | 6 | Tread speed a kick adds (m/s). |
| `traction.tcSlipTarget` / `tcMinDrive` | 0.94 / 0.2 | Traction control's drive cap inside the peak, and the drive it always leaves. |
| `steering.counterSteerAllowance` | 1 | Full lock reaches the direction of travel at any slip angle. |
| `drift.maxSlipDeg` / `assistTorque` | 55 / 22750 | The anti spin aid. |

## Measuring

Headless, against the real sim: `npx tsx .claude/skills/tune/drift.ts [carId]` prints a trace every 0.1 s of four scenarios (a handbrake flick held on the throttle, handbrake plus brake at speed, flooring it mid corner, a launch): speed, slip angle, yaw rate, rpm, gear, rear spin, tread speed against road speed. `npx tsx .claude/skills/tune/measure.ts` has the stats (0 to 100, top speed) that upgrades must keep improving. Any change here alters every replay, ghost and best time.

## Sources

- Forza Motorsport Data Out documentation (per wheel `TireSlipRatio`, `TireSlipAngle`, `TireCombinedSlip` normalized to the peak, `WheelRotationSpeed`), support.forza.net.
- FH4 / FH5 wheel setup and tuning pages: Normal (Standard) steering "influences the yaw inertia of the car" and damps it, Simulation turns that off; TCS cuts power and brakes the spinning wheel; STM brakes wheels at the onset of oversteer. Assist text: brakes and handbrake together lock all four wheels.
- Forza Motorsport 2023: eight contact points per tire at 360 Hz (Chris Esaki); FM5's Calspan tire testing.
- Michelin, *The Tyre: Grip*: peak at 5 to 15% slip, µ falls to the locked value within 0.2 s of lock up, ABS holds 10 to 20% slip where the tire keeps about half its transverse capacity.
- MathWorks Magic Formula coefficients (dry B 10, C 1.9, D 1, E 0.97): peak µ at κ ≈ 0.18, 0.92 of peak at κ = 1; wet peaks at 0.09 and keeps 0.78.
- Beckman, *The Physics of Racing* part 25: combined grip from a slip vector normalized per axis.
- Hindiyeh, *Dynamics and Control of Drifting in Automobiles*, Stanford 2013: drift as an unstable equilibrium with rear wheelspin and the drive force's lateral authority.
- Drift tune conventions in FH5 (drifted.com, racinggames.gg): rear differential 100% locked, brake balance to the front, gear so the drift gear sits just under the limiter.
