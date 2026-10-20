/**
 * Downtown: the default fabric (about 80% of the city). Claims every block
 * face no other module took, one area per block, so later content can vary
 * per block (style, height profile, signage density). Building placement
 * itself stays in blocks.ts; the build adds nothing yet.
 */
import type { DistrictModule } from './types';
import { emptyBuild } from './types';

export const downtownModule: DistrictModule = {
  kind: 'downtown',
  phase: 'graph',
  plan(ctx) {
    for (const f of ctx.faces()) {
      if (f.outer || ctx.claims.face.has(f.id)) continue;
      ctx.addArea({ kind: 'downtown', variant: 'block', polygon: f.ring, path: [], nodes: [], edges: [], faces: [f.id], params: { area: f.area } });
    }
  },
  build() {
    return emptyBuild();
  },
};
