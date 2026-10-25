/**
 * Applies db/schema.sql to the Neon database in `DATABASE_URL` (read from `.env.local` when it is not in the
 * environment): `npm run db:init`. Idempotent (`create table if not exists`), so it is safe to run again.
 */
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

try {
  process.loadEnvFile('.env.local');
} catch {
  // No .env.local: the environment has to carry DATABASE_URL.
}
const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!url) throw new Error('DATABASE_URL is not set (.env.local or the environment)');
const sql = neon(url);
// The driver runs one statement per query; the schema's comments go, its statements run in order.
const statements = readFileSync('db/schema.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
for (const s of statements) await sql.query(s);
console.log(`db/schema.sql applied (${statements.length} statement${statements.length === 1 ? '' : 's'}).`);
