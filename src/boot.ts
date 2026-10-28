/**
 * The page's entry: the stylesheet and the boot splash, then the game. main.ts and its graph (three.js, the sim,
 * the city, every screen) is most of a megabyte that has to download and run, then waits for a signed-in player's
 * save (account.ts, up to 3 s) and builds the renderer before it could show anything, all over a black page. This
 * module needs only the splash, so the title flashes in while all of that happens behind it; main.ts picks the
 * splash up through `bootSplash()` and lands it on the menu as before.
 */
import './ui/styles/main.scss';
import { startBootSplash } from './ui/splash/splash';

// Deep links go straight to their screen behind main.ts's loading card, never the splash. Any of these skips it
// here; main.ts puts the splash up itself for one it does not take as a deep link (a ?race= that names no mode).
const params = new URLSearchParams(location.search);
const deepLink = ['race', 'garage', 'drone', 'freeroam', ...(import.meta.env.DEV ? ['perf'] : [])].some((p) => params.has(p));
if (!deepLink) startBootSplash();

void import('./main');
