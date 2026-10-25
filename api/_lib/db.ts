/**
 * The Neon client, one per warm function instance. The HTTP driver (`neon()`) runs each query as one fetch
 * with no pool to hold open, which suits short serverless calls and lets the free tier's compute scale to
 * zero between games. The Vercel ↔ Neon integration sets `DATABASE_URL` (and `POSTGRES_URL`); either works.
 */
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let cached: NeonQueryFunction<false, false> | null = null;

export function sql(): NeonQueryFunction<false, false> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  cached = neon(url);
  return cached;
}
