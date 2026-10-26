/**
 * A user agent condensed to something scannable (`Safari 17.5 · iPhone`); callers keep the raw string in a
 * `title`, so nothing is lost. Deliberately simple: Edge and the other Chromium brands all claim Chrome, so the
 * specific brands are tested first.
 */
export function formatUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser =
    match(ua, /Edg\/(\d+)/, 'Edge') ??
    match(ua, /OPR\/(\d+)/, 'Opera') ??
    match(ua, /Firefox\/(\d+)/, 'Firefox') ??
    // Safari reports its real version in `Version/`, not the WebKit build.
    (/Safari/.test(ua) && !/Chrome|Chromium/.test(ua) ? (match(ua, /Version\/([\d.]+)/, 'Safari') ?? 'Safari') : null) ??
    match(ua, /Chrome\/(\d+)/, 'Chrome');
  const platform = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? androidDevice(ua)
        : /Macintosh|Mac OS X/.test(ua)
          ? 'macOS'
          : /Windows NT/.test(ua)
            ? 'Windows'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;
  const parts = [browser, platform].filter(Boolean);
  // Bots and anything unrecognised: a trimmed raw string rather than nothing.
  if (parts.length === 0) return ua.length > 48 ? ua.slice(0, 45) + '…' : ua;
  return parts.join(' · ');
}

function match(ua: string, re: RegExp, label: string): string | null {
  const m = ua.match(re);
  return m ? `${label} ${m[1]}` : null;
}

function androidDevice(ua: string): string {
  // `Android 14; Pixel 8)` → `Pixel 8`, falling back to the bare OS.
  const model = ua.match(/Android [\d.]+; ([^;)]+)\)/);
  const trimmed = model?.[1].replace(/\s+Build\/.*$/, '').trim();
  return trimmed && trimmed !== 'K' ? trimmed : 'Android';
}
