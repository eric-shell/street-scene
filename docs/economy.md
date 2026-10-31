# Points and parts (the economy)

Races pay points; points buy garage parts and the body features (fog lights, shaved side markers, a shaved hatch ...). Everything else in the garage (paint, calipers, wheel trims, stance, tires, tint, underglow, pops and bangs, the setup sliders) is free from the first race, and so is stock: a car's own wheel, its stock body pieces, no spoiler. The sim never reads any of this: a part is visual only, so buying one never changes how a car drives, and a replay or ghost is untouched by what anyone owns.

`FEATURES.economy` (`src/shared/features.ts`, on by default; `?features=-economy` turns it off on one device) is the switch. Off, every part is free, unlocked and owned, the garage shows no prices or counter, and nothing is spent or recorded: the game plays as it did before.

## The pieces

| Module | Store key | What it holds | Merge across devices |
|---|---|---|---|
| `src/shared/points.ts` | `points.v1` | `{ total, spent, best }`: lifetime earned, lifetime spent, best run | max of each field |
| `src/shared/stats.ts` | `stats.v1` | races finished (all and per mode), wins, podiums, best finish, race time (s), distance (m), drift score, best run, points lost to crashes, free roam drives | max of each counter, min of the (set) best finish |
| `src/shared/economy.ts` | none | the price and unlock table (`ECONOMY`), `priceOf`, `unlockRaces`, `isUnlocked`; `Buyable`, `featureId`, `featurePrice`, `featureRacesToUnlock` | |
| `src/shared/purchases.ts` | `purchases.v1` | `{ [carId]: id[] }`: part ids and `feature.<name>` ids | union per car |

All three keys sync with an account (`src/account/cloudSave.ts`, `SYNCED`). A download is merged with this device's copy before it is written (`mergeLocalPoints`, which covers all three), so signing in on a second device never loses a run, a race or a purchase.

### The ledger

The balance is `total - spent`, never below 0 (`pointsBalance()`); `totalPoints()` is still lifetime earned. A ledger rather than a balance because both fields only grow, which is what lets two devices merge with a max and no server: a merged balance would have to guess which device spent what. Every race's points go through `addRunPoints` (main.ts's finish handler, live untuned runs only) and every purchase through `spendPoints`, which refuses when the balance is short. A save from before the economy has no `spent` and reads 0.

### Stats

Recorded at main.ts's finish handler for live races (never a replay), and not for a run the debug panels tuned, exactly as with points; free roam counts a drive when it starts (untuned). Wins, podiums and the best finish count only races with rivals: a drift run or a time trial alone is not a win. Distance is the route distance covered (`RaceCar.dist`, capped at the race's length). Crashes are kept as the points they cost (the callouts' crash line); there is no crash count in the tally to read. `racesForUnlocks()` is races finished. Counters merged by max can miss a race driven on each of two offline devices; that undercount is the price of never counting one twice.

Settings › Stats (`src/ui/screens/statsPage.ts`, the panel's first page) shows all of it with the ledger, parts owned and the next unlock tier.

## Prices and unlock tiers

A race pays about three thousand points (a full nitrous stage is 1,000). The table puts the cheapest wheel at about two races of points and the dearest body kit at ten to fifteen. Inside a slot the price spreads with how much part there is, read off the catalog entry: `base x (1 + spread x tris / budget)`, the budget being the slot's `TRI_BUDGETS`, times 1.25 for a multi-piece wheel (a bolted lip and barrel), rounded to 50. A new part is priced the moment it is catalogued.

| Slot | Base (pts) | Spread | Range (pts) | Unlocks after |
|---|---|---|---|---|
| Wheels, one piece | 5,000 | 0.4 | 5,900 to 6,850 (58 wheels) | 1 race |
| Wheels, multi-piece | 5,000 x 1.25 | 0.4 | 7,350 to 8,650 (55 wheels) | 1 race |
| Mirrors | 3,000 | 0.3 | 3,000 to 3,900 | 1 race |
| Headlights | 3,000 | 0.3 | 3,000 to 3,900 | 1 race |
| Taillights | 3,000 | 0.3 | 3,000 to 3,900 | 1 race |
| Exhaust | 5,000 | 0.3 | 5,000 to 6,500 | 3 races |
| Canards | 5,500 | 0.3 | 5,500 to 7,150 | 3 races |
| Splitter | 6,000 | 0.3 | 6,000 to 7,800 | 3 races |
| Side skirts | 6,000 | 0.3 | 6,000 to 7,800 | 3 races |
| Rear bumper | 7,000 | 0.3 | 7,000 to 9,100 | 3 races |
| Front bumper | 8,000 | 0.3 | 8,000 to 10,400 | 3 races |
| Diffuser | 7,000 | 0.3 | 7,000 to 9,100 | 6 races |
| Fenders | 9,000 | 0.3 | 9,000 to 11,700 | 6 races |
| Roof | 9,000 | 0.3 | 9,000 to 11,700 | 6 races |
| Hood | 10,000 | 0.3 | 10,000 to 13,000 | 6 races |
| Spoiler | 11,000 | 0.3 | 11,000 to 14,300 | 6 races |
| Body kit | 32,000 | 0.4 | 32,000 to 44,800 | 10 races |

A few parts are priced by hand instead (`ECONOMY.parts`, by catalog id): the Wendt Strom's All Reds taillights are 30,000 points after 6 races, about a body kit, since the real lamps are a rare collector's piece. Its Ambers are 3,600, above the Ocean (3,400) whose mesh they share. Its City Golf taillights are 25,000 after 6 races, just under the All Reds.

### Body features

Every body feature (`BODY_FEATURES`: shaved hatch, shaved rubstrip, half cup handles, black grille, fog lights, shaved side markers) is bought per car like a part, at one price: `ECONOMY.features` is 15,000 points (about five races, above every bumper and fender part) after 6 races. The ledger id is `feature.<name>` in the same per-car list; `buyItem(carId, item)` buys a `Buyable` (a part via `partBuyable`, a feature via `featureBuyable`), and `buy` is its part form. Fog lights sit in the Front bumper section and shaved side markers in the Fenders section (`SLOT_FEATURES` in `garageTabs.ts`); the other features stay in the Unique features panels, all with the same tag as a part. The Wendt Strom's Euro mirrors were a feature until its mirrors became a part slot: saved builds and ledgers with `euroMirrors` read as its Euro mirrors part (`RETIRED_FEATURES` in `carBuild.ts`).

Three catalog parts became features (`RETIRED_PARTS` in `carBuild.ts`): the Euro and Cupra R fog bumpers are the plain bumper plus fog lights, and the shaved fenders are stock fenders plus shaved markers. A saved build or share code wearing an old id reads as the replacement and the feature on (`validateVisual`), and a ledger owning one owns both (`cleanPurchases`).

A car's own stock wheel is free on that car (it is stock), and so is choosing Stock or None in any slot. Balancing is one edit to `ECONOMY` in `src/shared/economy.ts`.

## Ownership is per car

A part bought for a car belongs to that model, for every build of it in the garage however many slots hold one, and to no other model: wheels fit every car, but a set is bought for one. `owns(carId, partId)` is the one question, `buy(carId, part)` checks the unlock and the balance, spends and records.

### Grandfathering

The first time the economy runs on a device with no `purchases.v1` saved (`startLedger`, at the garage's load), every part the garage's builds wear is recorded as owned for its car, so nobody loses what they had before parts cost points. A brand new player's random starter build is grandfathered the same way on the first load; later random builds (a reload before keeping one, the garage's New build) only draw wheels the car owns, so a reload is never a free wheel. An account saved before the economy (a garage but no purchases in the cloud) is grandfathered from its cloud garage as it downloads, so this device's ledger cannot strip it.

## Where ownership is enforced

`enforceOwnership(build)` strips the parts a build's car does not own back to stock (or none; a rear wheel back to following the front) and switches off the features it does not own, and returns what went (`WornPart`, a feature's `slot` is null).

- Import: a code pasted in the garage (`storage.ts importBuild`, a dialog lists what went: "You haven't unlocked these for the Wendt Strom R6 yet: ...") and a `?build=` link at boot (`main.ts`, the same wording in `garage/ownershipNotice.ts`).
- Load: `loadGarage` strips every slot quietly and saves the result. A cloud save lands in storage before the load (at boot, or a sign-in that reloads the page), so a stale or tampered save never equips what was not bought.
- Race start: `main.ts ownedVisual` strips a copy of the player's look for the race and free roam, defensively (visual only; racing is never blocked).
- The garage: a part or feature the car does not own is put on to preview while its buy dialog (or, when locked, a note of the races still to finish) is up, and comes off again unless it is bought, so a build only ever keeps owned parts and Save never has to refuse. Switching a build's model asks first when the new car does not own the wheels it wears ("Switching to X resets these parts to stock: ..."), then resets them.

## The garage

Each part pick shows what it costs this car instead of its triangle count: nothing (wheel tiles) or "Owned" (body lists) once owned, its price, or a lock with "N more races". Customize's header is a live points counter (the balance, tabular figures) that rolls down with an eased count and a red flash on a buy; the build's name moves to a quiet line over the tabs. The Builds header shows the balance too.
