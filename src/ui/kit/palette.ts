/**
 * Monokai Pro colors for everything the UI paints outside CSS: HUD canvases,
 * splash motion graphics, touch controls and the garage showroom lights.
 * Orange is the primary accent (active, selected, primary action), yellow the
 * secondary (values, highlights, records); red, green, cyan and purple keep
 * their meanings (danger, success, nitrous, ghost), except that the nitrous
 * bar's higher stages burn purple and red. The stylesheet carries the
 * same values (ui/styles/abstracts/_palette.scss, emitted as custom properties
 * by base/_tokens.scss); keep the two in step.
 */
export const PALETTE = {
  /** Darkest to lightest backgrounds. */
  bg0: '#19181a',
  bg1: '#221f22',
  bg2: '#2d2a2e',
  bg3: '#403e41',
  line: '#5b595c',
  dim: '#727072',
  muted: '#939293',
  soft: '#c1c0c0',
  text: '#fcfcfa',
  orange: '#fc9867',
  yellow: '#ffd866',
  red: '#ff6188',
  green: '#a9dc76',
  cyan: '#78dce8',
  purple: '#ab9df2',
  /** Three hues beyond Monokai Pro's six, so the garage's nine categories each wear their own. */
  blue: '#6ea4ff',
  pink: '#ff7ad9',
  violet: '#c27bff',
} as const;

export type PaletteColor = keyof typeof PALETTE;

/** The nitrous stages' colors, stage 1 first: cyan, then purple, then the hot pink red (hud/_nitro.scss lists the same). */
export const NITRO_STAGE_COLORS = ['cyan', 'purple', 'red'] as const satisfies readonly PaletteColor[];

/** `rgba()` string for a palette color at alpha a; build these once, not per frame. */
export function rgba(c: PaletteColor, a: number): string {
  const hex = PALETTE[c];
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
}

/** The "r,g,b" triple of a palette color, for alpha templates built per frame. */
export function rgb(c: PaletteColor): string {
  const hex = PALETTE[c];
  return `${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)}`;
}
