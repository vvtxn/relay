# AGENTS.md - TUI Framework

A terminal UI framework using a custom JSX runtime, Yoga layout engine for flexbox positioning, and ANSI escape codes
for rendering.

## Architecture Overview

```
tui/
├── core/                       # Low-level terminal handling
│   ├── index.ts                # Re-exports Terminal
│   ├── ansi.ts                 # ANSI escape code constants (cursor, screen, mouse)
│   ├── terminal.ts             # Terminal buffer, rendering, cursor control
│   ├── terminal-palette.ts     # OSC 10/11/4 palette query, DA1 fence, reply parsing
│   ├── input.ts                # Keyboard + SGR mouse input handling (drops OSC/private-CSI replies)
│   └── primitives/             # Drawing primitives
│       ├── color.ts            # Color parsing, ANSI conversion, bg inheritance
│       ├── char-width.ts       # wcwidth (combining/wide) + ANSI-aware measurement
│       ├── fill.ts             # Box background fill positions
│       ├── format-text.ts      # Text styling (bold, italic, colors)
│       ├── mentions.ts         # @mention detection (source ranges)
│       ├── parse-markdown.ts   # Markdown-to-segments parser
│       └── wrap-text.ts        # ANSI/width-aware wrapping; editing wrap + cursor mapping
├── render/                     # JSX rendering layer
│   ├── renderer.ts             # Custom renderer with Yoga layout and reconciliation
│   ├── components.tsx          # Box, Text, TextInput, Spinner, ScrollArea, Markdown
│   ├── index.ts                # Public render API re-exports
│   ├── jsx-runtime.ts          # Custom JSX runtime
│   ├── jsx-dev-runtime.ts      # JSX dev runtime
│   ├── memo.ts                 # memo() — pure-component skip for the reconciler
│   ├── hooks/                  # React-like hooks
│   │   ├── index.ts            # Re-exports all hooks
│   │   ├── signals.ts          # useSignal, useSignalEffect, useLatest, hook lifecycle
│   │   ├── text-input.ts       # useTextInput hook (with vim mode support)
│   │   ├── text-utils.ts       # Shared text editing utilities (TextState)
│   │   ├── scroll-area.ts      # useScrollArea hook
│   │   └── command-palette.ts  # useCommandPalette hook
│   ├── elements/               # Element handlers for rendering
│   │   ├── index.ts            # Element registry (registerElement, getElement)
│   │   ├── box.ts              # Box element renderer + layout
│   │   ├── text.ts             # Text element renderer + layout
│   │   ├── text-input.ts       # TextInput element renderer + layout
│   │   ├── spinner.ts          # Spinner element renderer + layout
│   │   └── scroll-area.ts      # ScrollArea element renderer + layout
│   ├── components/
│   │   ├── command-palette.tsx  # CommandPalette component
│   │   └── welcome-screen.tsx  # WelcomeScreen component
│   └── types/
│       └── index.ts            # TypeScript type definitions, ElementRegistry, props
├── theme.ts                    # Active CLI palette (mutable copy of the shared tokens)
└── theme-derive.ts             # Builds a palette from the terminal's fg/bg + ANSI colors
```

## Key Concepts

### Rendering Pipeline

1. **VNode Creation**: JSX compiles to custom `jsx()` calls returning VNodes
2. **Instance Tree**: `Renderer.mountInstance()` converts VNodes to Instance objects with Yoga nodes
3. **Reconciliation**: `Renderer` reconciles old and new instance trees (key-based + positional matching)
4. **Layout Calculation**: Yoga calculates positions using flexbox algorithm
5. **Element Rendering**: Element handlers convert instances to Position arrays
6. **Terminal Output**: `Terminal.render()` writes positions to a double-buffered character grid
7. **Differential Flush**: Only changed cells are written to stdout, batched into contiguous runs (one cursor move per
   run, styles emitted only on change)

### Render-Cost Model

Every signal change re-runs the whole tree (one root effect; no per-component effects), so the framework keeps unchanged
work off the per-frame path with four layers — large sessions must stay cheap on every keystroke, spinner tick, and
streamed delta:

1. **`memo()` components** (`render/memo.ts`): pure presentational components wrapped in `memo()` are not re-invoked
   while their props are shallow-equal (by reference) to the last render; the renderer reuses the previous output VNode.
   Memoized components must not read signals or use hooks — a signal read inside them is tracked by the root effect, and
   skipping the invocation would drop the update.
2. **Yoga layout skip**: `reconcile` only re-applies an element's layout handlers when its own props (excluding
   `children`/`key`) changed — plus children-only changes for content-measured elements (`<Text>`), so they re-measure.
   `setMeasureFunc` does not dirty a node in yoga-layout 3.x, so the handlers that install a measure function call
   `markDirty()` themselves. Yoga setters are FFI calls and dominate large-tree commits otherwise.
3. **Yoga child-list skip**: `reconcileChildren` leaves the Yoga child list untouched when it is unchanged —
   `removeChild`/`insertChild` churn dirties nodes and forces a full re-layout of the subtree.
4. **Primitive caches**: `parseMarkdown` and the Markdown formatted-lines cache are content-keyed LRUs; `wrapText` is an
   LRU keyed by text (+one width per entry) since Yoga measure functions and element paints both wrap the same strings.
   Cached results must be treated as immutable.

Mounting a fresh subtree (first paint of a long session) remains O(content) — instance + Yoga node creation and the
first measure pass — and the ScrollArea culls painting to the viewport.

### Full-Bleed Backgrounds

The root is always laid out at the full terminal size, and the `Terminal` carries a **default cell style**
(`TerminalOptions.defaultBg`). Every cell — including those no component painted — is initialized with that style, so
the app background always fills the entire window. For hex colors the terminal itself is also themed via **OSC 11**
(restored on exit). Boxes with `bgColor` paint a full-rect fill — edge to edge across their computed bounds — and
re-apply their background after any full SGR reset in child text, so nested surfaces survive styled markdown/mentions.
`bgColor="default"` means transparent (inherits the parent). Borders are opt-in: `borderColor` draws a 1-cell outline
(occupying its own padding cell) and `borderRadius` swaps in quarter-circle corner glyphs. A border owns the outer ring
of cells, so a fill is **clipped to the outline's interior** and the ring shows `RenderContext.inheritedBg` — the
nearest painted ancestor's background — instead of the box's own surface: the fill can never bleed outside the outline,
which is what makes rounded corners safe (an arc cannot mask a partial-cell fill). `borderLabel` (with
`borderLabelColor`) embeds a label in the top edge (`╭─ LABEL ─────╮`), clipped to the cells between the corners. The
composer and the command palette modal are border-only rounded boxes (no fill, so there is nothing to bleed);
everywhere else, hierarchy comes from the background steps (`background` → `surface` → `surfaceElevated`) plus padding,
not outlines.

### Terminal Palette Theming

`theme.ts` exports the active palette as a mutable CLI-local copy of the shared tokens (`setTheme()` replaces it in
place). This is deliberate: the CLI applies the palette once at startup, before component modules load, because some
tokens are captured at module load and markdown caches parsed colors. `theme-derive.ts` is pure and browser-safe: it
turns the terminal's default foreground/background into neutral steps and uses the reported ANSI palette for semantic
accents, falling back to ANSI slot names when only fg/bg answered. `terminal-palette.ts` owns the escape-sequence I/O:
OSC 10/11/4 queries fenced by DA1, raw-mode stdin, BEL/ST reply parsing, and a bounded timeout. `input.ts` discards
late OSC replies and private CSI device reports so they can never become keystrokes.

### Pointer Input

Mouse reporting is always on (`?1002h` button-event + SGR `?1006h`, emitted by `Terminal`) so presses, releases, and
motion-while-dragging all arrive. `input.ts` decodes each report into `KeyEvent.mouse` (0-based cell coordinates,
button, `press`/`release`/`move`, modifiers) and keeps wheel reports on the existing `wheelup`/`wheeldown` keys so the
scroll handlers are unchanged. Dispatch order is: global key handlers (an open palette/overlay is modal) → the
renderer's pointer router → focus-registered key handlers.

`Renderer.hitTest()` walks the instance tree using the same computed Yoga rectangles the element handlers paint with,
shifts `scrollArea` descendants by their scroll offset, clips them to the viewport, and picks the deepest match from
the last-painted child. Any element accepts `onClick` (`BaseProps`), so a click on row text bubbles to the row's box;
only primary-button presses dispatch clicks (wheel/motion/release never activate `onClick`). A scroll area with
`scrollbar` also exposes its bar as a pointer target: a press on the thumb grabs it, a track click jumps and grabs, and
motion while grabbed drags it (the renderer snapshots the bar geometry at press time and calls
`onScrollOffsetChange`). `scrollbarMetrics()` in `elements/scroll-area.ts` is shared by the painter and hit test so the
interactive cells are exactly the painted ones. The mounted renderer registers its hit test with
`inputManager.setPointerHandler()`, and positioned overlays (`position="absolute"`) stop hit-testing from piercing
through to background siblings.

### Core Classes

#### `Terminal` (core/terminal.ts)

- Double-buffered rendering for flicker-free updates
- Manages character grid with styles per cell (default background + double-width continuation cells)
- Tracks cursor state to avoid redundant escape sequences
- Exposes a reactive `size` signal so renderers re-layout + repaint on resize
- Batches contiguous changed cells into runs when flushing (few cursor moves, styles only on change)
- Enables SGR mouse reporting (wheel, button clicks, and drag motion) and OSC 11 background theming; both restored on
  dispose
- Methods: `render(positions)`, `dispose()`, `drain()`, `showCursor()`, `hideCursor()`

#### `Renderer` (render/renderer.ts)

- Bridges VNodes to terminal output
- Creates Yoga layout tree from component tree
- Reconciles instance trees for efficient updates (key-based and positional)
- Uses `@preact/signals-core` `effect()` for reactive re-rendering
- Methods: `render(createVNode)`, `unmount()`

### Signals Integration

The framework uses `@preact/signals-core` for reactivity:

- `useSignal(initialValue)` - Creates a persistent signal (cached by component/hook index)
- `useSignalEffect(fn)` - Runs the body immediately at mount and re-runs it when signals read inside it change; the
  optional returned cleanup runs before each re-run and at unmount
- `useLatest(value)` - A signal holding the latest-render value; the live-ref escape hatch for effects and
  once-registered handlers
- Signals trigger automatic re-renders when `.value` changes
- Each function component owns a `HookStore` (`createHookStore`/`setCurrentStore` during invocation, disposed with its
  instance), and slots are positional indexes into that store

#### Effect Timing and Closure Liveness

- Effect bodies run **immediately at mount**, synchronously inside the render commit's flush — closer to a mid-commit
  layout effect than a post-commit one. A signal write during mount re-enters the same flush and converges before
  paint.
- Effects re-run only when signals **read inside the callback** change. Every render stores its callback and re-runs
  invoke the latest one, so effects never observe a stale first-render closure.
- **Props are not reactive.** An effect cannot see a prop change unless it reads the value through `useLatest` (a
  changed primitive re-runs the effect; an unchanged one is an `Object.is` no-op) or through a signal. `<Spinner>` is
  the reference example.
- Writes during render are allowed only when they converge: render writes a `useLatest` ref before paint reads it, so
  a paint-time read subscribes the root effect at the post-write version. Idempotent (`Object.is`-equal) writes end
  the cycle; never write a fresh identity that a mounted effect reads on every run.

#### Registering Input Handlers

Two idioms, pick by lifecycle:

- Signal-driven lifecycles (SSE subscribe/reconnect, timers) use `useSignalEffect`, whose cleanup owns teardown.
- Once-only input registrations use the explicit `getHookKey()` + `if (!hasCleanup(key))` + `setCleanup(key, cleanup)`
  block. The handler closure is intentionally frozen at registration; it must reach changing state through signals or
  a `useLatest` ref, and registration-time locals (e.g. the double-Esc timer state) persist by design.

### Layout System (Yoga)

Supports flexbox properties on `<Box>`:

- `flex`, `flexDirection` (row/column/row-reverse/column-reverse)
- `justifyContent` (flex-start/center/flex-end/space-between/space-around/space-evenly)
- `alignItems` (flex-start/center/flex-end/stretch/baseline)
- `flexWrap` (wrap/wrap-reverse/nowrap)
- `gap`, `padding`
- `width`, `height`
- `bgColor`
- `borderColor`, `borderRadius` (1-cell outline; the fill clips to its interior; rounded corner glyphs)
- `borderLabel`, `borderLabelColor` (label embedded in the top edge, `╭─ LABEL ─────╮`)
- `position` (relative/absolute), `top`, `left`, `right`, `bottom`

### Styling

Text styling via `<Text>` props:

- `color` - Basic colors (red, blue, etc.), bright variants, or hex codes (#ff0000)
- `bgColor` - Background color
- `bold`, `italic`, `underline`, `strikethrough`
- `width`, `height`, `flex` - Layout constraints

## Components

All exported from `render/components.tsx`:

- **`Box`** - Flexbox container with background, border (optional rounded corners and a top-edge label), padding,
  positioning support, and pointer handling via `onClick`
- **`Text`** - Styled text with color, bold, italic, underline, strikethrough
- **`TextInput`** - Text input field with cursor, placeholder, and vim mode support. Soft-wraps at word boundaries
  (spaces kept at line ends, cursor mapped by source offsets), auto-grows up to `maxLines` and scrolls internally past
  that; `height` pins a fixed viewport instead
- **`Spinner`** - Animated spinner (default 80ms interval, 10 frames)
- **`ScrollArea`** - Scrollable container (extends BoxProps; shares Box's per-edge padding resolution and the scrollbar
  gutter) with `autoScroll`, `scrollbar`, and `scrollStep`. The bar is interactive: clicking the track jumps, and
  dragging the thumb (or the grabbed track) scrolls; wheel/keys keep scrolling the focused area.
- **`Markdown`** - Renders markdown content as styled Text lines via `parseMarkdown()` (memoized: parse + format are
  cached per content string)
- **`memo(component)`** - Marks a pure presentational component so the renderer skips re-invocation while its props are
  shallow-equal (see Render-Cost Model)
- **`WelcomeScreen`** - Welcome screen with logo, subtitle, and hints, re-exported from `components/welcome-screen.tsx`
- **`CommandPalette`** - Re-exported from `components/command-palette.tsx`

## Hooks

All exported from `render/hooks/index.ts`:

- **`useSignal(initialValue)`** - Persistent signal, cached per component/hook index
- **`useSignalEffect(fn)`** - Reactive effect with cleanup support
- **`useLatest(value)`** - Signal holding the latest-render value (live ref for effects and once-registered handlers)
- **`useTextInput(options)`** - Text input state management with optional vim mode (`VimMode: "NORMAL" | "INSERT"`)
- **`useScrollArea(options)`** - Scroll state management with keyboard input and auto-scroll. The input handler is
  registered once but reads options through a live ref, so `focused`/`scrollStep` changes (e.g. focus moving to a
  modal) take effect while the ScrollArea stays mounted.
- **`useCommandPalette(options)`** - Command palette state (items, filtering, selection)

## Adding New Features

### New Component Property

1. Add prop to type in `render/types/index.ts`
2. Handle in the element's layout function (e.g., `BoxLayout` in `render/elements/box.ts`)
3. Handle in the element's render function (e.g., `BoxElement` in `render/elements/box.ts`)

### New Primitive

1. Create file in `core/primitives/`
2. Return `Position[]` array for terminal rendering
3. Use in element handlers

### New Element Type

1. Add props interface in `render/types/index.ts`
2. Add entry to `ElementRegistry` interface in `render/types/index.ts`
3. Add constant to `ElementType` object
4. Create element handler file in `render/elements/` (export both `*Element` render and `*Layout` functions)
5. Register in `render/elements/index.ts` via `registerElement()`
6. Add component wrapper in `render/components.tsx`
7. Add to JSX IntrinsicElements in `render/jsx-runtime.ts`

## Code Patterns

- Each element has two handlers: `*Layout` (applies Yoga properties) and `*Element` (renders to positions)
- Element handlers are pure functions: `(instance, context) => Position[]`
- Layout handlers are pure functions: `(instance) => void` (mutates Yoga node)
- Elements are registered via `registerElement(type, { render, layout, hasChildren })` in `render/elements/index.ts`
- Hooks are positional slots in the component's `HookStore` (`getHookKey()` / `useSignal()`); hook order must stay
  stable across renders of the same component instance
- Effects and once-registered input handlers reach changing values through signals or `useLatest(value)` (a live ref
  written every render); a captured first-render closure is invisible until the value actually changes
- Use `toAnsi(colorName)` from `#/tui/core/primitives/color.ts` for color conversion
- All coordinates are integer character positions
- Text editing logic is centralized in `hooks/text-utils.ts` (exports `TextState` and operations like `insertChar`,
  `deleteBackward`, `moveCursor`, etc.); each operation writes value + cursor in one `batch()` so the UI commits once
  per edit
- Text inputs wrap with `wrapTextForEditing` + `cursorPositionInWrappedText` (`core/primitives/wrap-text.ts`): the wrap
  preserves every source character and tracks spans, and the cursor is mapped from the same result the measurer and
  painter use
- Wrap long-lived presentational components in `memo()` (from `#/tui/render/components.tsx` or `#/tui/render/index.ts`)
  so idle frames skip re-invoking them; never wrap signal- or hook-driven components (see Render-Cost Model)

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `pnpm exec vp fmt` — auto-format all code
2. `pnpm check` — format, lint, and type-check (Oxfmt, Oxlint, tsgo via Vite+)

If any command fails, fix the issues and re-run until all pass cleanly.

## Naming Conventions

- **Element type strings**: camelCase (e.g., `"textInput"`, `"scrollArea"`)
- **ElementType constants**: UPPER_SNAKE_CASE (e.g., `ElementType.TEXT_INPUT`, `ElementType.SCROLL_AREA`)
- **File names**: kebab-case (e.g., `text-input.ts`, `fill.ts`)
- **Functions/variables**: camelCase (e.g., `BoxLayout`, `getElement`)
- **Types/Interfaces**: PascalCase (e.g., `TextInputProps`, `ElementHandler`, `BoxInstance`)
- **JSX intrinsic elements**: camelCase (e.g., `<textInput />`, `<scrollArea />`) - internal use only
- **Component wrappers**: PascalCase (e.g., `<TextInput />`, `<ScrollArea />`) - what users import
- **Element handler exports**: `*Element` for render, `*Layout` for layout (e.g., `BoxElement`, `BoxLayout`)
