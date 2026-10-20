// Dev helper: writes an SVG top-down map of a seed's city and routes.
// usage: npx tsx scripts/debugCitySvg.ts <seed> <out.svg>
import { writeFileSync } from 'node:fs';
import { createCity, createWorld } from '../src/city/world';
import { seedFromString } from '../src/sim/prng';

const seed = seedFromString(process.argv[2] ?? '20261019');
const out = process.argv[3] ?? 'city.svg';
const city = createCity(seed);
const circuit = createWorld(seed, 'circuit', city);
const sprint = createWorld(seed, 'sprint', city);
const { minX, maxX, minZ, maxZ } = city.graph.bounds;
const pad = 80;
const parts: string[] = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${minZ - pad} ${maxX - minX + 2 * pad} ${maxZ - minZ + 2 * pad}" width="1400" height="1400" style="background:#111">`);
for (const b of city.blocks.buildings) {
  const deg = (-b.yaw * 180) / Math.PI;
  parts.push(`<rect x="${-b.w / 2}" y="${-b.d / 2}" width="${b.w}" height="${b.d}" fill="hsl(230,30%,${15 + Math.min(40, b.h / 3)}%)" transform="translate(${b.x} ${b.z}) rotate(${deg})"/>`);
}
for (const e of city.graph.edges) {
  const a = city.graph.nodes[e.a];
  const b = city.graph.nodes[e.b];
  const color = e.kind === 'channel' ? '#245' : e.kind === 'ramp' ? '#357' : '#333';
  parts.push(`<line x1="${a.x}" y1="${a.z}" x2="${b.x}" y2="${b.z}" stroke="${color}" stroke-width="${e.width}"/>`);
}
for (const w of circuit.walls) {
  parts.push(`<line x1="${w.ax}" y1="${w.az}" x2="${w.bx}" y2="${w.bz}" stroke="${w.kind === 'barrier' ? '#f80' : '#8af'}" stroke-width="1.2"/>`);
}
const poly = (pts: { x: number; z: number }[], color: string) =>
  parts.push(`<polyline points="${pts.map((p) => `${p.x},${p.z}`).join(' ')}" fill="none" stroke="${color}" stroke-width="3" opacity="0.8"/>`);
poly(circuit.route.points, '#f0f');
poly(sprint.route.points, '#0f0');
for (const g of circuit.route.grid) parts.push(`<circle cx="${g.x}" cy="${g.z}" r="2" fill="#ff0"/>`);
for (const l of city.blocks.streetlights) parts.push(`<circle cx="${l.x}" cy="${l.z}" r="0.8" fill="#fd8"/>`);
for (const s of city.blocks.signs) parts.push(`<circle cx="${s.x}" cy="${s.z}" r="3" fill="#0ff"/>`);
parts.push('</svg>');
writeFileSync(out, parts.join('\n'));
console.log(`circuit ${circuit.route.length.toFixed(0)} m, sprint ${sprint.route.length.toFixed(0)} m, buildings ${city.blocks.buildings.length}, walls ${circuit.walls.length}`);
