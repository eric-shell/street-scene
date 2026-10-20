declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;
declare const __BUILD_DATE__: string;

/** Build version shown in the menu, e.g. "v0.2.0 · 71a1c9c · 2026-10-20". */
export const BUILD_VERSION = `v${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'} · ${typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev'} · ${typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : ''}`;
