/**
 * Node preload for the headless perf scripts (`tsx --import ./scripts/perf/register.mjs`):
 * registers loader.mjs so the render modules, which Vite normally bundles, import in plain Node.
 */
import { register } from 'node:module';
register(new URL('./loader.mjs', import.meta.url));
