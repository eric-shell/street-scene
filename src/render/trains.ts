/**
 * Trains on the elevated railway, both ways: render only, placed every frame
 * from the timetable (railTimetable.ts) as a pure function of the scene clock,
 * so the menu backdrop, a race and its replay all show the same trains.
 *
 * Four instanced meshes for every train on the line:
 *  - car bodies (stainless, lit windows with riders, doors, a neon stripe),
 *    tinted a little per train;
 *  - lights: white headlights and marker lights at the head, red tail and
 *    marker lights at the rear;
 *  - the light wash: the windows' glow falling through the open deck onto the
 *    street below, flickering as the car rocks (Medium and High);
 *  - sparks off the third rail shoes, more while braking into a station,
 *    each a little ballistic shower computed from when it flew off (Medium
 *    and High), so nothing has to be stepped or stored between frames.
 * Plus a positional rumble (audio/sfx.ts TrainRumble) as the nearest train
 * passes the camera, created on first approach once the page has had a user
 * gesture (browsers keep audio off until then).
 * No per frame allocations: every scratch object is created once.
 */
import * as THREE from 'three';
import { TrainRumble } from '../audio/sfx';
import type { Quality } from '../ui/settings';
import { GeoBuilder } from './geoBuilder';
import { CurvePoint, RailCurve, curvePoint, deckSlope, sampleCurve, trackFor, trackLateral } from './railCurve';
import { Band, CAR_SIDE, TRAIN_BANDS, makeTrainAtlas, makeWashTexture } from './railTextures';
import { Service, TRAIN, TripState, hash01, makeService, runAt, trackS, tripsAt } from './railTimetable';

/** Car body cross section (m, from the rail top) and detail per quality. */
const CAR = {
  halfWidth: 1.45,
  floor: 1.05,
  eave: 3.35,
  roof: 3.68,
  roofHalf: 0.95,
  /** Rail top above the deck (tie) top (m). */
  railTop: 0.16,
} as const;

const DETAIL: Record<Quality, { wash: boolean; sparks: number }> = {
  low: { wash: false, sparks: 0 },
  medium: { wash: true, sparks: 48 },
  high: { wash: true, sparks: 96 },
};

const SPARK = {
  /** Sparks: one chance per car per bucket (s); a shower lives `life` s with `count` sparks. */
  bucket: 1.1,
  life: 0.6,
  count: 9,
  /** Chance per bucket while braking, while cruising (none below minSpeed m/s). */
  braking: 0.55,
  cruising: 0.1,
  minSpeed: 3,
  gravity: 9.8,
} as const;

/** Head / tail light offsets on a car (x right, y up, z forward; m). */
const HEAD_LIGHTS: [number, number, number][] = [
  [-0.78, 1.38, 7.74],
  [0.78, 1.38, 7.74],
  [-1.08, 3.08, 7.74],
  [1.08, 3.08, 7.74],
];

export interface Trains {
  /** Both directions' timetables and tracks (debugging, tests). */
  readonly services: readonly { sv: Service; track: 0 | 1 }[];
  update(time: number): void;
  view(camera: THREE.Camera): void;
  dispose(): void;
}

function bandV(b: Band, t: number): number {
  return b.v0 + (b.v1 - b.v0) * t;
}

/** One car: body sides, ends, roof, underframe and two trucks, UV mapped into the train atlas. */
function carGeometry(): THREE.BufferGeometry {
  const g = new GeoBuilder(false);
  const L = CAR_SIDE.length / 2;
  const W = CAR.halfWidth;
  const quad = (p: number[][], n: [number, number, number], uv: number[][]) => {
    const ids = p.map((q, i) => g.vertex(q[0], q[1], q[2], n[0], n[1], n[2], uv[i][0], uv[i][1]));
    g.quadFacing(ids[0], ids[1], ids[2], ids[3], n[0], n[1], n[2]);
  };
  const side = TRAIN_BANDS.side;
  for (const sx of [-1, 1]) {
    const x = sx * W;
    quad(
      [
        [x, CAR.floor, -L],
        [x, CAR.floor, L],
        [x, CAR.eave, L],
        [x, CAR.eave, -L],
      ],
      [sx, 0, 0],
      [
        [sx > 0 ? 1 : 0, side.v0],
        [sx > 0 ? 0 : 1, side.v0],
        [sx > 0 ? 0 : 1, side.v1],
        [sx > 0 ? 1 : 0, side.v1],
      ],
    );
    // Roof shoulder.
    const roof = TRAIN_BANDS.roof;
    const nl = Math.hypot(CAR.roof - CAR.eave, W - CAR.roofHalf);
    quad(
      [
        [x, CAR.eave, -L],
        [x, CAR.eave, L],
        [sx * CAR.roofHalf, CAR.roof, L],
        [sx * CAR.roofHalf, CAR.roof, -L],
      ],
      [(sx * (CAR.roof - CAR.eave)) / nl, (W - CAR.roofHalf) / nl, 0],
      [
        [0, roof.v0],
        [1, roof.v0],
        [1, bandV(roof, 0.25)],
        [0, bandV(roof, 0.25)],
      ],
    );
  }
  const roof = TRAIN_BANDS.roof;
  quad(
    [
      [-CAR.roofHalf, CAR.roof, -L],
      [CAR.roofHalf, CAR.roof, -L],
      [CAR.roofHalf, CAR.roof, L],
      [-CAR.roofHalf, CAR.roof, L],
    ],
    [0, 1, 0],
    [
      [0, bandV(roof, 0.25)],
      [0, bandV(roof, 1)],
      [1, bandV(roof, 1)],
      [1, bandV(roof, 0.25)],
    ],
  );
  const end = TRAIN_BANDS.end;
  for (const sz of [-1, 1]) {
    const z = sz * L;
    quad(
      [
        [-W, CAR.floor, z],
        [W, CAR.floor, z],
        [W, CAR.eave, z],
        [-W, CAR.eave, z],
      ],
      [0, 0, sz],
      [
        [sz > 0 ? 0 : 0.25, end.v0],
        [sz > 0 ? 0.25 : 0, end.v0],
        [sz > 0 ? 0.25 : 0, end.v1],
        [sz > 0 ? 0 : 0.25, end.v1],
      ],
    );
    // Roof end cap (a trapezoid as a quad).
    quad(
      [
        [-W, CAR.eave, z],
        [W, CAR.eave, z],
        [CAR.roofHalf, CAR.roof, z],
        [-CAR.roofHalf, CAR.roof, z],
      ],
      [0, 0, sz],
      [
        [0, roof.v0],
        [0.1, roof.v0],
        [0.1, roof.v1],
        [0, roof.v1],
      ],
    );
  }
  // Underframe and trucks: dark boxes.
  const under = TRAIN_BANDS.under;
  const box = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) => {
    const faces: [number[][], [number, number, number]][] = [
      [[[cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz], [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz]], [0, 0, 1]],
      [[[cx + hx, cy - hy, cz - hz], [cx - hx, cy - hy, cz - hz], [cx - hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz - hz]], [0, 0, -1]],
      [[[cx + hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz + hz]], [1, 0, 0]],
      [[[cx - hx, cy - hy, cz - hz], [cx - hx, cy - hy, cz + hz], [cx - hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz - hz]], [-1, 0, 0]],
      [[[cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz + hz], [cx - hx, cy - hy, cz + hz]], [0, -1, 0]],
    ];
    for (const [p, n] of faces)
      quad(p, n, [
        [0, under.v0],
        [1, under.v0],
        [1, under.v1],
        [0, under.v1],
      ]);
  };
  box(0, 0.8, 0, 1.25, 0.25, L - 0.5);
  for (const tz of [-5.1, 5.1]) box(0, 0.42, tz, 1.15, 0.3, 1.3);
  return g.build();
}

export function createTrains(group: THREE.Group, curve: RailCurve, seed: number, quality: Quality, track: <T extends { dispose(): void }>(x: T) => T): Trains {
  const detail = DETAIL[quality];
  const stations = curve.stations.map((s) => s.s);
  const phase0 = hash01(seed, 11, 3) * TRAIN.headway;
  const services: { sv: Service; track: 0 | 1; salt: number }[] = ([1, -1] as const).map((dir, k) => ({
    sv: makeService(dir, curve.length, stations, phase0 + k * TRAIN.headway * 0.47),
    track: trackFor(curve, dir),
    salt: k * 977 + 13,
  }));
  const maxTrains = services.reduce((n, s) => n + Math.ceil(s.sv.run.duration / s.sv.headway) + 1, 0);
  const maxCars = maxTrains * TRAIN.cars;

  // ----- Meshes.
  const atlas = makeTrainAtlas();
  track(atlas.map);
  track(atlas.emissive);
  const bodyMat = track(
    new THREE.MeshStandardMaterial({ map: atlas.map, emissiveMap: atlas.emissive, emissive: 0xffffff, emissiveIntensity: 0.55, metalness: 0.55, roughness: 0.38, envMapIntensity: 1.1 }),
  );
  const bodies = new THREE.InstancedMesh(track(carGeometry()), bodyMat, maxCars);
  bodies.name = 'trainCars';
  bodies.frustumCulled = false;
  bodies.count = 0;
  bodies.setColorAt(0, new THREE.Color(1, 1, 1));
  group.add(bodies);

  const lightMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const lights = new THREE.InstancedMesh(track(new THREE.BoxGeometry(0.3, 0.2, 0.05)), lightMat, maxTrains * 8);
  lights.name = 'trainLights';
  lights.frustumCulled = false;
  lights.count = 0;
  lights.setColorAt(0, new THREE.Color(1, 1, 1));
  group.add(lights);

  let wash: THREE.InstancedMesh | null = null;
  if (detail.wash) {
    const tex = track(makeWashTexture());
    const geo = track(new THREE.PlaneGeometry(1, 1));
    geo.rotateX(-Math.PI / 2);
    const mat = track(
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    wash = new THREE.InstancedMesh(geo, mat, maxCars);
    wash.name = 'trainWash';
    wash.frustumCulled = false;
    wash.count = 0;
    wash.renderOrder = 1;
    wash.setColorAt(0, new THREE.Color(1, 1, 1));
    group.add(wash);
  }

  let sparks: THREE.InstancedMesh | null = null;
  if (detail.sparks > 0) {
    const mat = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(7, 3.2, 0.9) }));
    sparks = new THREE.InstancedMesh(track(new THREE.BoxGeometry(0.045, 0.045, 0.26)), mat, detail.sparks);
    sparks.name = 'trainSparks';
    sparks.frustumCulled = false;
    sparks.count = 0;
    sparks.setColorAt(0, new THREE.Color(1, 1, 1));
    group.add(sparks);
  }

  // ----- Scratch (allocated once).
  const trips: TripState[] = [];
  const P: CurvePoint = curvePoint();
  const Q: CurvePoint = curvePoint();
  const mCar = new THREE.Matrix4();
  const mTmp = new THREE.Matrix4();
  const vX = new THREE.Vector3();
  const vY = new THREE.Vector3();
  const vZ = new THREE.Vector3();
  const vPos = new THREE.Vector3();
  const vUp = new THREE.Vector3(0, 1, 0);
  const vScale = new THREE.Vector3();
  const qRot = new THREE.Quaternion();
  const col = new THREE.Color();
  const run = { s: 0, v: 0, a: 0 };
  /** World position and speed of every car this frame, for the rumble. */
  const carX = new Float64Array(maxCars);
  const carY = new Float64Array(maxCars);
  const carZ = new Float64Array(maxCars);
  const carV = new Float64Array(maxCars);
  let cars = 0;

  /** Pose of a car centered at track s on a track, facing `dir`: matrix into mCar, frame in vX/vY/vZ. */
  const carPose = (ts: number, tr: 0 | 1, dir: 1 | -1): void => {
    sampleCurve(curve, ts, P);
    const lat = trackLateral(curve, tr, ts);
    const dl = (trackLateral(curve, tr, ts + 1) - trackLateral(curve, tr, ts - 1)) / 2;
    const slope = deckSlope(curve, ts);
    vZ.set((P.tx + P.px * dl) * dir, slope * dir, (P.tz + P.pz * dl) * dir).normalize();
    vX.crossVectors(vUp, vZ).normalize();
    vY.crossVectors(vZ, vX);
    vPos.set(P.x + P.px * lat, P.y + CAR.railTop, P.z + P.pz * lat);
    mCar.makeBasis(vX, vY, vZ).setPosition(vPos);
  };

  let lastTime = -1;
  const update = (time: number): void => {
    if (time === lastTime) return;
    lastTime = time;
    let nb = 0;
    let nl = 0;
    let nw = 0;
    let ns = 0;
    cars = 0;
    const pitch = TRAIN.carLength + TRAIN.gap;
    for (const { sv, track: tr, salt } of services) {
      const n = tripsAt(sv, time, trips);
      for (let i = 0; i < n; i++) {
        const trip = trips[i];
        // Per train tint: stainless, a little warm or cool.
        const h = hash01(trip.trip, salt, 5);
        const tint = 0.86 + 0.18 * h;
        for (let c = 0; c < TRAIN.cars; c++) {
          const sc = trip.s - TRAIN.carLength / 2 - c * pitch;
          if (sc < -TRAIN.carLength || sc > sv.length + TRAIN.carLength) continue;
          const ts = trackS(sv, sc);
          if (ts < 0 || ts > curve.length) continue;
          carPose(ts, tr, sv.dir);
          if (nb < maxCars) {
            bodies.setMatrixAt(nb, mCar);
            col.setRGB(tint * (0.97 + 0.05 * h), tint, tint * (1.03 - 0.05 * h));
            bodies.setColorAt(nb, col);
            nb++;
          }
          if (cars < maxCars) {
            carX[cars] = vPos.x;
            carY[cars] = vPos.y + 2;
            carZ[cars] = vPos.z;
            carV[cars] = trip.v;
            cars++;
          }
          // Head lights on the lead car, tail lights on the last.
          if ((c === 0 || c === TRAIN.cars - 1) && nl + HEAD_LIGHTS.length <= maxTrains * 8) {
            const head = c === 0;
            for (let k = 0; k < HEAD_LIGHTS.length; k++) {
              const o = HEAD_LIGHTS[k];
              mTmp.makeTranslation(o[0], o[1], head ? o[2] : -o[2]);
              mTmp.premultiply(mCar);
              lights.setMatrixAt(nl, mTmp);
              if (head) col.setRGB(k < 2 ? 3 : 1.6, k < 2 ? 2.9 : 1.4, k < 2 ? 2.5 : 0.8);
              else col.setRGB(k < 2 ? 2.6 : 1.8, 0.1, 0.05);
              lights.setColorAt(nl, col);
              nl++;
            }
          }
          // Window light falling through the slats onto the street.
          if (wash && nw < maxCars) {
            const lat = trackLateral(curve, tr, ts);
            const flick = 0.82 + 0.18 * Math.sin(time * 23 + c * 1.7 + trip.trip * 3.1) * Math.sin(time * 7.3 + c);
            // Above the curb (0.15 m) so it shows on the sidewalk side as well as the street.
            vPos.set(P.x + P.px * lat, P.ground + 0.22, P.z + P.pz * lat);
            qRot.setFromAxisAngle(vUp, Math.atan2(P.tx, P.tz));
            vScale.set(7, 1, TRAIN.carLength * 1.05);
            mTmp.compose(vPos, qRot, vScale);
            wash.setMatrixAt(nw, mTmp);
            const k = 0.34 * flick;
            col.setRGB(k * 0.9, k * 0.95, k * 1.1);
            wash.setColorAt(nw, col);
            nw++;
          }
          // Third rail sparks: showers that started within the last life time.
          if (sparks && ns < detail.sparks) ns = sparkShowers(sv, tr, trip, c, salt, ns);
        }
      }
    }
    bodies.count = nb;
    lights.count = nl;
    bodies.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    lights.instanceMatrix.needsUpdate = true;
    if (lights.instanceColor) lights.instanceColor.needsUpdate = true;
    if (wash) {
      wash.count = nw;
      wash.instanceMatrix.needsUpdate = true;
      if (wash.instanceColor) wash.instanceColor.needsUpdate = true;
    }
    if (sparks) {
      sparks.count = ns;
      sparks.instanceMatrix.needsUpdate = true;
      if (sparks.instanceColor) sparks.instanceColor.needsUpdate = true;
    }
  };

  /** Add the sparks of one car's recent showers; returns the new spark count. */
  const sparkShowers = (sv: Service, tr: 0 | 1, trip: TripState, c: number, salt: number, ns: number): number => {
    const cap = detail.sparks;
    const b1 = Math.floor(trip.tau / SPARK.bucket);
    for (let b = b1 - 1; b <= b1 && ns < cap; b++) {
      if (b < 0) continue;
      const te = b * SPARK.bucket + hash01(trip.trip + salt, c, b * 2 + 1) * (SPARK.bucket - SPARK.life);
      const age = trip.tau - te;
      if (age < 0 || age >= SPARK.life) continue;
      runAt(sv.run, te, run);
      if (run.v < SPARK.minSpeed) continue;
      const chance = run.a < -0.1 ? SPARK.braking : SPARK.cruising;
      if (hash01(trip.trip + salt, c, b * 2) >= chance) continue;
      // Shoe on the third rail side (outside of the track), at one of the trucks.
      const pitch = TRAIN.carLength + TRAIN.gap;
      const truck = hash01(trip.trip, c, b) < 0.5 ? -5.1 : 5.1;
      const ts = trackS(sv, run.s - TRAIN.carLength / 2 - c * pitch + truck * sv.dir);
      sampleCurve(curve, ts, Q);
      const lat = trackLateral(curve, tr, ts);
      const out = lat < 0 ? -1 : 1;
      const sx = Q.x + Q.px * (lat + out * 1.25);
      const sz = Q.z + Q.pz * (lat + out * 1.25);
      const sy = Q.y + 0.3;
      const fade = 1 - age / SPARK.life;
      for (let k = 0; k < SPARK.count && ns < cap; k++) {
        const r1 = hash01(b * 31 + k, trip.trip + salt, c * 7 + 1);
        const r2 = hash01(b * 31 + k, trip.trip + salt, c * 7 + 2);
        const r3 = hash01(b * 31 + k, trip.trip + salt, c * 7 + 3);
        const fwd = sv.dir * run.v * 0.45 + (r1 - 0.5) * 3;
        const side = out * (0.8 + 2.4 * r2);
        const up = 0.6 + 2.6 * r3;
        const vx = Q.tx * fwd + Q.px * side;
        const vz = Q.tz * fwd + Q.pz * side;
        const vy = up - SPARK.gravity * age;
        vPos.set(sx + vx * age, sy + up * age - 0.5 * SPARK.gravity * age * age, sz + vz * age);
        vZ.set(vx, vy, vz).normalize();
        vX.crossVectors(vUp, vZ);
        if (vX.lengthSq() < 1e-6) vX.set(1, 0, 0);
        vX.normalize();
        vY.crossVectors(vZ, vX);
        mTmp.makeBasis(vX, vY, vZ).setPosition(vPos);
        sparks!.setMatrixAt(ns, mTmp);
        const f = fade * (0.6 + 0.4 * r1);
        col.setRGB(f, f * (0.7 + 0.3 * fade), f * fade);
        sparks!.setColorAt(ns, col);
        ns++;
      }
    }
    return ns;
  };

  // ----- Rumble: the nearest car's distance, speed and side.
  let rumble: TrainRumble | null = null;
  let rumbleTried = false;
  const camPos = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  const view = (camera: THREE.Camera): void => {
    if (!cars) {
      rumble?.update(0, 0, 0);
      return;
    }
    camera.getWorldPosition(camPos);
    let best = Infinity;
    let bi = 0;
    for (let i = 0; i < cars; i++) {
      const d = (carX[i] - camPos.x) ** 2 + (carY[i] - camPos.y) ** 2 + (carZ[i] - camPos.z) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    const dist = Math.sqrt(best);
    const proximity = dist > 170 ? 0 : 1 / (1 + (dist / 24) ** 2);
    if (!rumble && !rumbleTried && proximity > 0.03) {
      rumble = TrainRumble.create();
      rumbleTried = rumble !== null || !TrainRumble.blocked();
    }
    if (!rumble) return;
    camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const dx = carX[bi] - camPos.x;
    const dz = carZ[bi] - camPos.z;
    const l = Math.hypot(dx, dz) || 1;
    rumble.update(proximity, carV[bi], (dx * camRight.x + dz * camRight.z) / l);
  };

  return {
    services,
    update,
    view,
    dispose() {
      rumble?.dispose();
      rumble = null;
      group.remove(bodies, lights);
      if (wash) group.remove(wash);
      if (sparks) group.remove(sparks);
      bodies.dispose();
      lights.dispose();
      wash?.dispose();
      sparks?.dispose();
    },
  };
}
