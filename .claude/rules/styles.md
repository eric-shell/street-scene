---
paths:
  - "src/ui/styles/**"
---
# Stylesheet (SCSS, compiled by Vite through sass-embedded)

- `main.scss` is the whole stylesheet: the design notes, then one `@use` per partial in cascade order. Later rules win ties of specificity, so a new partial goes where its rules should win (the order interleaves folders on purpose: toast after the HUD, the music player after the garage). Only partials listed there emit CSS.
- One partial per screen or component, in the folder of the screen it styles (`menu/`, `hud/`, `garage/`, `map/`, `screens/`, `panels/`, `splash/`, `transitions/`, `rail/`, `base/`), opening with a `/* ... */` comment that says what it styles and which TS module builds that DOM. Partial names must be unique across folders (`@use` namespaces by file name).
- `abstracts/` emits no CSS: `_palette.scss` (the Monokai Pro colors, same names and values as `ui/palette.ts`; keep both in step; `palette.alpha(orange, 0.35)`, `palette.rgb(cyan)`, `@include palette.tint(hue, red)`, `palette.$modes`) and `_media.scss` (`@include media.narrow / phone / wide / short / very-short / compact-hud / touch / reduced-motion`). Use them instead of literal triplets or media queries; a one-off threshold one layout needs may stay literal.
- Runtime values stay custom properties (`--accent`, `--mode`, `--hue`, `--cut`, `--rail-*`): JS and the cascade change them. Sass variables, maps and loops are for compile-time tables only (the chamfered list, race type and tab hues). Inside a custom property Sass only evaluates `#{...}`.
- Modern Sass only: `@use`/`@forward` (never `@import`), `sass:` modules (`color.change`, `list.append`, `map.get`), `@if` blocks (the `if()` function is deprecated). Quote palette names in maps and lists: `orange`, `red`, `green` are colors to Sass. The PostToolUse hook compiles the tree after every `.scss` edit and fails on any warning.
- The rest of the house style is the header of `main.scss`: chamfer, rule and accent hairline; transform and opacity motion that reduced motion turns off; tabular figures; 4.5:1 contrast for secondary text.
- A refactor that should not change the look must not change the output: `npx vite build` before and after and compare `dist/assets/*.css`. Check a visual change with `/dev` when it matters. The SCSS hook already compiles every edit; run the one e2e spec for a screen (`splash` for menu and splash) only when a style change could break that flow, such as hiding or blocking a control.
