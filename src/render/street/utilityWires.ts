/**
 * The wires between the power poles (city/props.ts 'utilityPole', each linked to the next of its run by `wireTo`):
 * three lines per span, from insulator to insulator along the crossarms (propGeometry.ts UTILITY_POLE), each hung
 * as a catenary (a parabola is close enough at these sags: SAG of the span's length at its middle). Render only and
 * overhead, nine metres up over the sidewalk where no car reaches, so they need no wall.
 *
 * One merged LineSegments for the whole city: an la seed has about 250 poles and 160 spans, so 480 wires of
 * SEGMENTS[quality] segments each, under 5k line segments, one draw call. It is not chunk culled (a single object,
 * frustum culled whole): at that size cutting it by cell would cost more in uploads than it saves on the GPU.
 *
 * When a pole is struck (props.ts setBroken) the wires of its spans lose their hold there: the broken end drops to
 * the pavement beside the stump and the wire droops from the standing pole down to it (both ends down: it lies in
 * the street). Only those spans are rewritten; a pole put back (the menu stage, a restart) hangs them again.
 */
import * as THREE from 'three';
import type { Prop } from '../../city/props';
import type { Quality } from '../../ui/settings';
import { UTILITY_POLE } from './propGeometry';

/** Segments per wire by quality, and the sag at mid span as a share of the span's length. */
const SEGMENTS: Record<Quality, number> = { low: 5, medium: 8, high: 12 };
const SAG = 0.028;
/** A wire whose pole is down lies this high (m) over the ground at the stump, and sags this much more (share of the span). */
const DOWN_Y = 0.15;
const DOWN_SAG = 0.06;
const WIRE_COLOR = 0x5c6068;

export interface UtilityWires {
  lines: THREE.LineSegments;
  /** A pole broken (or put back): rehang the spans at it. */
  setBroken(id: number, broken: boolean): void;
  dispose(): void;
}

export function buildUtilityWires(props: readonly Prop[], quality: Quality): UtilityWires | null {
  const spans: [number, number][] = [];
  for (const p of props) if (p.kind === 'utilityPole' && p.wireTo !== undefined) spans.push([p.id, p.wireTo]);
  if (!spans.length) return null;
  const seg = SEGMENTS[quality];
  const wires = UTILITY_POLE.wireZ.length;
  /** Floats per span: wires x segments x 2 vertices x 3. */
  const per = wires * seg * 6;
  const pos = new Float32Array(spans.length * per);
  const down = new Uint8Array(props.length);
  /** The spans touching each pole. */
  const spansOf = new Map<number, number[]>();
  spans.forEach(([a, b], i) => {
    for (const id of [a, b]) {
      const list = spansOf.get(id);
      if (list) list.push(i);
      else spansOf.set(id, [i]);
    }
  });
  const U = UTILITY_POLE;
  /** Attachment point of wire k on pole p (world), or where it lies once the pole is down. */
  const anchor = (p: Prop, k: number, out: THREE.Vector3): THREE.Vector3 => {
    const z = U.wireZ[k];
    // Local +Z of the pole's yaw is (sin, cos): the crossarm runs across the street.
    const x = p.x + Math.sin(p.yaw) * z;
    const zz = p.z + Math.cos(p.yaw) * z;
    return out.set(x, down[p.id] ? p.y + DOWN_Y : p.y + U.armY + U.wireLift, zz);
  };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const writeSpan = (i: number) => {
    const pa = props[spans[i][0]];
    const pb = props[spans[i][1]];
    const sag = down[pa.id] || down[pb.id] ? SAG + DOWN_SAG : SAG;
    let o = i * per;
    for (let k = 0; k < wires; k++) {
      anchor(pa, k, a);
      anchor(pb, k, b);
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      // Never below the ground it lies on (both ends down: it rests flat).
      const drop = down[pa.id] && down[pb.id] ? 0 : sag * len;
      for (let s = 0; s < seg; s++) {
        for (const t of [s / seg, (s + 1) / seg]) {
          pos[o++] = a.x + (b.x - a.x) * t;
          pos[o++] = a.y + (b.y - a.y) * t - drop * 4 * t * (1 - t);
          pos[o++] = a.z + (b.z - a.z) * t;
        }
      }
    }
  };
  for (let i = 0; i < spans.length; i++) writeSpan(i);
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(pos, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr);
  geo.computeBoundingSphere();
  const mat = new THREE.LineBasicMaterial({ color: WIRE_COLOR });
  const lines = new THREE.LineSegments(geo, mat);
  lines.name = 'utilityWires';
  return {
    lines,
    setBroken(id, broken) {
      const list = spansOf.get(id);
      if (!list || (down[id] === 1) === broken) return;
      down[id] = broken ? 1 : 0;
      for (const i of list) {
        writeSpan(i);
        attr.addUpdateRange(i * per, per);
      }
      attr.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
