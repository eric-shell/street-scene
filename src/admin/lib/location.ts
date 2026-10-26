/**
 * The one place a visitor's location is turned into display text. IP geolocation is only as good as the
 * visitor's egress address (carriers, CGNAT and VPNs routinely report a city hundreds of miles off), so a
 * hand-entered `location_override` always wins and anything IP-derived is flagged `approximate` for the UI to
 * say so. Never concatenate city and country at a call site.
 */
interface GeoFields {
  city: string | null;
  region: string | null;
  country: string | null;
  location_override: string | null;
}

export interface ResolvedLocation {
  /** Display string, or null when nothing is known. */
  label: string | null;
  /** The label came from IP geolocation and may be badly wrong. */
  approximate: boolean;
}

export function resolveLocation(v: GeoFields | null | undefined): ResolvedLocation {
  if (!v) return { label: null, approximate: false };
  const override = v.location_override?.trim();
  if (override) return { label: override, approximate: false };
  // Region is a subdivision code (`CA`), so it only reads well next to a city.
  const parts = [v.city, v.city ? v.region : null, v.country].filter(Boolean);
  return { label: parts.length > 0 ? parts.join(', ') : null, approximate: true };
}
