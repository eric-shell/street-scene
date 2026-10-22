/**
 * meshoptimizer's simplifier for the Blender scripts (scripts/blender/meshopt.py). Blender has
 * no binding for it worth depending on (the PyPI wrapper is an unofficial pre-release that stops
 * at Python 3.11; Blender 5 runs 3.13), while the npm package the asset pipeline already uses
 * for Meshopt compression carries the same simplifier as WASM. So Blender writes the mesh to a
 * binary, runs this with plain `node`, and reads the result back:
 *
 *   node --experimental-strip-types scripts/meshoptSimplify.ts <request.json>
 *
 * `simplifyWithUpdate` collapses to the target and moves the surviving vertices (and their
 * attributes) to where they best fit the removed surface, which matters at the 8k a car body is
 * cut to. Attribute seams (a vertex split by material, crease or UV) are inferred from split
 * vertices sharing a position and kept, collapsing only along themselves.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';
import type { SimplifierFlags } from 'meshoptimizer';

/** What meshopt.py writes next to the mesh binary. */
interface Request {
  /** Mesh binary: positions f32 [vertices * 3], attributes f32 [vertices * stride], indices u32 [indices]. */
  input: string;
  /** Result binary: count u32, error f32, indices u32 [count], positions f32 [vertices * 3], attributes f32 [vertices * stride]. */
  output: string;
  vertices: number;
  /** Index count of the input (3 per triangle). */
  indices: number;
  /** Floats per vertex in the attribute block. */
  stride: number;
  /** One weight per attribute float; floats past the last weight ride along unweighted. */
  weights: number[];
  /** Index count to stop at (3 per triangle). */
  target: number;
  /** Relative error to stop at (1 is the mesh's whole extent); large means the target alone decides. */
  error: number;
  flags?: SimplifierFlags[];
  /** Move the kept vertices to fit (simplifyWithUpdate) rather than keep them where they were. */
  update: boolean;
}

const req = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Request;
const bin = readFileSync(req.input);
// Copies, not views: a Buffer's byte offset need not be 4-aligned.
const slice = (from: number, bytes: number): ArrayBuffer => bin.buffer.slice(bin.byteOffset + from, bin.byteOffset + from + bytes) as ArrayBuffer;
const posBytes = req.vertices * 3 * 4;
const attrBytes = req.vertices * req.stride * 4;
const positions = new Float32Array(slice(0, posBytes));
const attributes = new Float32Array(slice(posBytes, attrBytes));
const indices = new Uint32Array(slice(posBytes + attrBytes, req.indices * 4));

await MeshoptSimplifier.ready;
const args = [indices, positions, 3, attributes, req.stride, req.weights, null, req.target, req.error, req.flags ?? []] as const;
let count: number;
let error: number;
if (req.update) [count, error] = MeshoptSimplifier.simplifyWithUpdate(...args);
else {
  let kept: Uint32Array;
  [kept, error] = MeshoptSimplifier.simplifyWithAttributes(...args);
  indices.set(kept);
  count = kept.length;
}

const out = Buffer.alloc(8 + count * 4 + posBytes + attrBytes);
out.writeUInt32LE(count, 0);
out.writeFloatLE(error, 4);
Buffer.from(indices.buffer, 0, count * 4).copy(out, 8);
Buffer.from(positions.buffer).copy(out, 8 + count * 4);
Buffer.from(attributes.buffer).copy(out, 8 + count * 4 + posBytes);
writeFileSync(req.output, out);
