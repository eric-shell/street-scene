/**
 * The page's entry: the stylesheet and the boot splash, then the game. main.ts and its graph (three.js, the sim,
 * the city, every screen) is most of a megabyte that has to download and run, then waits for a signed-in player's
 * save (account.ts, up to 3 s) and builds the renderer and the menu city before it could show anything. This
 * module needs only the splash, so the title flashes in first; main.ts picks the splash up through `bootSplash()`
 * and lands it on the menu as before.
 *
 * The game's boot holds the main thread for seconds (the renderer, the city, its shaders), which would stall most
 * of the flash-in's animations. So the game downloads beside the intro (vite.config.ts preloads its chunks) but only
 * runs once the flash-in has played; the splash then holds on the title until the menu is ready, its street still
 * moving (drawn from a worker, splashFx.ts) and its rule filling as the game reports its boot steps. The
 * menu arrives no later for it: the intro no longer waits behind the game's boot. Deep links have no splash and
 * start the game at once. The music player starts here too (a small module and its catalog), so the opening track
 * plays with the splash instead of waiting for the game's bundle.
 */
import './ui/styles/main.scss';
// Only the account starts now (a small graph): a signed-in player's save downloads during the intro instead of after it.
import './account/account';
import { startBootSplash } from './ui/splash/splash';
import { bootMusic } from './audio/musicPlayer';

// The opening track before anything else: it downloads and tries to start under the splash's flash-in, and a
// click or key press during the intro unlocks it (main.ts picks up the same player).
bootMusic();

// Deep links go straight to their screen behind main.ts's loading card, never the splash. Any of these skips it
// here; main.ts puts the splash up itself for one it does not take as a deep link (a ?race= that names no mode).
const params = new URLSearchParams(location.search);
const deepLink = ['race', 'garage', 'drone', 'freeroam', ...(import.meta.env.DEV ? ['perf'] : [])].some((p) => params.has(p));
const splash = deepLink ? null : startBootSplash();

void (splash?.played ?? Promise.resolve()).then(() => import('./main'));
