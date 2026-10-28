/**
 * The gestures the people shaders share (the stands, the idlers, the walkers), so groups of people read as
 * different people doing different things rather than one sway at different phases. Everything is a pure
 * function of the people clock, the person's phase and style and the bits they wear: no CPU per frame, no new
 * attributes. The shaders pick a variant per person from values already on the instance (the style `iData.y`
 * cut into bands, the wear bits) and a phase that a group shares (`iData.x` = the plan's group phase plus a small
 * jitter, so friends clap, bob and take turns talking together while groups stay out of step with each other).
 *
 * `GESTURES_GLSL` holds the arm poses (raise, out, elbow, rad: the rig's `PersonArm`, see person.ts) and two
 * timing helpers; `talkCodes` is the CPU half of the talking pairs: which voice of its group a person is and
 * which side the nearest groupmate stands on, packed into a few bits of the instance data.
 *
 * The arm poses are approximations the rig allows: it has no wrist and no forearm turn, so crossed arms are the
 * upper arms angled in and the forearms folded across the front, a hand on the hip is the elbow out and the
 * hand a little forward. Render only.
 */

/** GLSL: arm poses as vec3(raise, out, elbow), `gPulse` and `gSpeak`. Pure, no uniforms or attributes, so the impostor bake can include it. */
export const GESTURES_GLSL = /* glsl */ `
const vec3 G_CROSS_L = vec3(0.35, -0.38, 1.95);
const vec3 G_CROSS_R = vec3(0.45, -0.38, 2.0);
const vec3 G_POCKET = vec3(-0.12, 0.13, 0.15);
const vec3 G_HIPS = vec3(0.0, 0.78, 0.85);
const vec3 G_RAIL = vec3(0.75, 0.12, 1.4);
const vec3 G_SIP = vec3(0.7, 0.05, 2.2);
const vec3 G_WATCH = vec3(1.2, -0.15, 1.9);
const vec3 G_STRETCH = vec3(2.6, 0.25, 0.3);
const vec3 G_POINT = vec3(1.35, 0.06, 0.08);

/** A pulse of dur s every period s (0..1, rising and falling over rise s); ph (rad) shifts it by up to a period. */
float gPulse(float t, float period, float ph, float dur, float rise) {
  float u = mod(t + ph * period / 6.2832, period);
  return smoothstep(0.0, rise, u) * (1.0 - smoothstep(dur - rise, dur, u));
}

/** 1 while this voice (role 1 or 2) of a talking group has the floor: the group shares a 7 s cycle in 3.5 s halves, voice 1 first. */
float gSpeak(float t, float ph, int role) {
  float s = smoothstep(-0.25, 0.25, sin(t * 0.8976 + ph));
  return role == 1 ? s : 1.0 - s;
}
`;

/** A person in a group, for `talkCodes`. */
export interface GroupMember {
  /** Whatever the group's members share (the plan's group phase, a cell's id). */
  key: number;
  x: number;
  z: number;
  /** Facing (three.js yaw, rad): forward is (sin, cos), left (cos, -sin). */
  yaw: number;
}

/**
 * The talking pairs, per member in the order given: 0 when alone in their group, else the voice (1 or 2,
 * alternating through the group's members in order) plus 4 when the nearest groupmate stands on their left. The
 * shaders alternate a gesturing hand between the voices and turn the head toward that side.
 */
export function talkCodes(members: readonly GroupMember[]): Uint8Array {
  const out = new Uint8Array(members.length);
  const groups = new Map<number, number[]>();
  members.forEach((m, i) => {
    const g = groups.get(m.key);
    if (g) g.push(i);
    else groups.set(m.key, [i]);
  });
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.forEach((i, k) => {
      const m = members[i];
      let best = Infinity;
      let side = 0;
      for (const j of g) {
        if (j === i) continue;
        const dx = members[j].x - m.x;
        const dz = members[j].z - m.z;
        const d = dx * dx + dz * dz;
        if (d < best) {
          best = d;
          side = dx * Math.cos(m.yaw) - dz * Math.sin(m.yaw) > 0 ? 4 : 0;
        }
      }
      out[i] = 1 + (k & 1) + side;
    });
  }
  return out;
}
