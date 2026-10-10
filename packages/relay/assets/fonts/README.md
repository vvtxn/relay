# Relay font assets

Single source of truth for the Relay typeface, shared by the web client and the terminal UI.

| File                       | Consumer                                         |
| -------------------------- | ------------------------------------------------ |
| `relay-mono-regular.woff2` | Web: `@font-face` weight 400 normal              |
| `relay-mono-bold.woff2`    | Web: `@font-face` weight 700 normal              |
| `relay-mono-italic.woff2`  | Web: `@font-face` weight 400 italic              |
| `relay-mono-regular.ttf`   | Terminal: `relay fonts install`                  |
| `relay-mono-bold.ttf`      | Terminal: `relay fonts install`                  |
| `relay-mono-italic.ttf`    | Terminal: `relay fonts install`                  |
| `OFL.txt`                  | License for the bundled font (must ship with it) |

Current font: **JetBrains Mono** (OFL-1.1, <https://www.jetbrains.com/lp/mono/>). It covers box-drawing (U+2500–257F),
block elements (U+2580–259F), and the UI bullets `• ◦ ▪ ● ❯`, but **not** Braille patterns (U+2800–28FF, the spinner
frames) — terminals fall back per glyph there. Verify coverage when swapping.

## Swapping the font

1. Replace the six files above, keeping the same names (they are referenced by `packages/web/src/styles.css`,
   `packages/relay/core/fonts.ts`, and `scripts/build.ts`).
2. Replace `OFL.txt` with the new license file, keeping the name.
3. Update the `font` object in `packages/relay/core/fonts.ts`: `family`, `cssStack`, `homepage`, `license`, and the face
   lists if the available weights differ.
4. Update the `@font-face` family name in `packages/web/src/styles.css` to match `font.family`.
5. Update the table and "Current font" line in this README.
