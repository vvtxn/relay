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
│   ├── input.ts                # Keyboard input handling
│   └── primitives/             # Drawing primitives
│       ├── color.ts            # Color parsing and ANSI conversion
│       ├── draw-box.ts         # Box/border rendering with styles
│       ├── format-text.ts      # Text styling (bold, italic, colors)
│       ├── parse-markdown.ts   # Markdown-to-segments parser
│       └── wrap-text.ts        # Text wrapping utilities
├── render/                     # JSX rendering layer
│   ├── renderer.ts             # Custom renderer with Yoga layout and reconciliation
│   ├── components.tsx          # Box, Text, TextInput, Spinner, ScrollArea, Markdown
│   ├── index.ts                # Public render API re-exports
│   ├── jsx-runtime.ts          # Custom JSX runtime
│   ├── jsx-dev-runtime.ts      # JSX dev runtime
│   ├── hooks/                  # React-like hooks
│   │   ├── index.ts            # Re-exports all hooks
│   │   ├── signals.ts          # useSignal, useSignalEffect, hook lifecycle
│   │   ├── text-input.ts       # useTextInput hook (with vim mode support)
│   │   ├── text-utils.ts       # Shared text editing utilities (TextState)
│   │   ├── scroll-area.ts      # useScrollArea hook
│   │   ├── command-palette.ts  # useCommandPalette hook
│   │   └── approval.ts         # useApprovalPrompt hook (tool approval decisions)
│   ├── elements/               # Element handlers for rendering
│   │   ├── index.ts            # Element registry (registerElement, getElement)
│   │   ├── box.ts              # Box element renderer + layout
│   │   ├── text.ts             # Text element renderer + layout
│   │   ├── text-input.ts       # TextInput element renderer + layout
│   │   ├── spinner.ts          # Spinner element renderer + layout
│   │   └── scroll-area.ts      # ScrollArea element renderer + layout
│   ├── components/
│   │   ├── command-palette.tsx  # CommandPalette component
│   │   ├── approval-prompt.tsx  # ApprovalPrompt component (tool approval overlay)
│   │   └── welcome-screen.tsx  # WelcomeScreen component
│   └── types/
│       └── index.ts            # TypeScript type definitions, ElementRegistry, props
├── playground/                 # Example apps
│   ├── agent.tsx               # Agent UI demo
│   ├── approval.tsx            # Approval prompt demo
│   ├── command-palette.tsx     # Command palette demo
│   ├── layout.tsx              # Flexbox layout demo
│   ├── markdown.tsx            # Markdown rendering demo
│   ├── scroll-area.tsx         # Scroll area demo
│   ├── spinner.tsx             # Spinner demo
│   ├── text-input.tsx          # Text input demo
│   ├── text-styling.tsx        # Text styling demo
│   └── welcome.tsx             # Welcome screen demo
├── tests/
│   ├── input-parsing.test.ts   # Input parsing tests
│   ├── jsx-runtime.test.ts     # JSX runtime tests
│   ├── text-input-cursor.test.ts # Text input cursor tests
│   ├── text-utils.test.ts      # Text utility tests
│   └── wrap-text.test.ts       # Text wrapping tests
└── theme.ts                    # Centralized color theme (hex colors for all UI elements)
```

## Key Concepts

### Rendering Pipeline

1. **VNode Creation**: JSX compiles to custom `jsx()` calls returning VNodes
2. **Instance Tree**: `Renderer.mountInstance()` converts VNodes to Instance objects with Yoga nodes
3. **Reconciliation**: `Renderer` reconciles old and new instance trees (key-based + positional matching)
4. **Layout Calculation**: Yoga calculates positions using flexbox algorithm
5. **Element Rendering**: Element handlers convert instances to Position arrays
6. **Terminal Output**: `Terminal.render()` writes positions to a double-buffered character grid
7. **Differential Flush**: Only changed cells are written to stdout

### Core Classes

#### `Terminal` (core/terminal.ts)

- Double-buffered rendering for flicker-free updates
- Manages character grid with styles per cell
- Tracks cursor state to avoid redundant escape sequences
- Methods: `render(positions)`, `dispose()`, `showCursor()`, `hideCursor()`

#### `Renderer` (render/renderer.ts)

- Bridges VNodes to terminal output
- Creates Yoga layout tree from component tree
- Reconciles instance trees for efficient updates (key-based and positional)
- Uses `@preact/signals-core` `effect()` for reactive re-rendering
- Methods: `render(createVNode)`, `unmount()`

### Signals Integration

The framework uses `@preact/signals-core` for reactivity:

- `useSignal(initialValue)` - Creates a persistent signal (cached by component/hook index)
- `useSignalEffect(fn)` - Runs effect when signals change, with cleanup support
- Signals trigger automatic re-renders when `.value` changes
- Hook lifecycle managed via `resetHooks()`, `nextComponent()`, `cleanupEffects()`

### Layout System (Yoga)

Supports flexbox properties on `<Box>`:

- `flex`, `flexDirection` (row/column/row-reverse/column-reverse)
- `justifyContent` (flex-start/center/flex-end/space-between/space-around/space-evenly)
- `alignItems` (flex-start/center/flex-end/stretch/baseline)
- `flexWrap` (wrap/wrap-reverse/nowrap)
- `gap`, `padding`
- `width`, `height`
- `border` (single/double/round/bold/dash/block), `borderColor`, `borderLabel`, `borderLabelColor`
- `bgColor`
- `position` (relative/absolute), `top`, `left`, `right`, `bottom`

### Styling

Text styling via `<Text>` props:

- `color` - Basic colors (red, blue, etc.), bright variants, or hex codes (#ff0000)
- `bgColor` - Background color
- `bold`, `italic`, `underline`, `strikethrough`
- `width`, `height`, `flex` - Layout constraints

## Components

All exported from `render/components.tsx`:

- **`Box`** - Flexbox container with border, padding, and positioning support
- **`Text`** - Styled text with color, bold, italic, underline, strikethrough
- **`TextInput`** - Text input field with cursor, placeholder, and vim mode support
- **`Spinner`** - Animated spinner (default 80ms interval, 10 frames)
- **`ScrollArea`** - Scrollable container (extends BoxProps) with `autoScroll`, `scrollbar`, and `scrollStep`
- **`Markdown`** - Renders markdown content as styled Text lines via `parseMarkdown()`
- **`WelcomeScreen`** - Welcome screen with version display, re-exported from `components/welcome-screen.tsx`
- **`CommandPalette`** - Re-exported from `components/command-palette.tsx`
- **`ApprovalPrompt`** - Modal tool-approval overlay (y allow / a always / n deny), re-exported from
  `components/approval-prompt.tsx`

## Hooks

All exported from `render/hooks/index.ts`:

- **`useSignal(initialValue)`** - Persistent signal, cached per component/hook index
- **`useSignalEffect(fn)`** - Reactive effect with cleanup support
- **`useTextInput(options)`** - Text input state management with optional vim mode (`VimMode: "NORMAL" | "INSERT"`)
- **`useScrollArea(options)`** - Scroll state management with keyboard input and auto-scroll
- **`useCommandPalette(options)`** - Command palette state (items, filtering, selection)
- **`useApprovalPrompt()`** - Tool approval state; `ask(request)` returns a Promise resolving with the decision ("allow"
  | "always" | "deny"), `cancel()` denies any pending request. Register before other global key handlers so Esc denies a
  pending prompt instead of triggering cancel.

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
- Hooks use global index tracking (reset per render cycle via `resetHooks()`)
- Use `toAnsi(colorName)` from `@/tui/core/primitives/color.ts` for color conversion
- All coordinates are integer character positions
- Text editing logic is centralized in `hooks/text-utils.ts` (exports `TextState` and operations like `insertChar`,
  `deleteBackward`, `moveCursor`, etc.)

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `deno task fmt` — auto-format all code
2. `deno task lint` — check for lint errors
3. `deno task check` — strict type-check of every entrypoint
4. `deno task test` — run the test suite

If any command fails, fix the issues and re-run until all pass cleanly.

## Naming Conventions

- **Element type strings**: camelCase (e.g., `"textInput"`, `"scrollArea"`)
- **ElementType constants**: UPPER_SNAKE_CASE (e.g., `ElementType.TEXT_INPUT`, `ElementType.SCROLL_AREA`)
- **File names**: kebab-case (e.g., `text-input.ts`, `draw-box.ts`)
- **Functions/variables**: camelCase (e.g., `BoxLayout`, `getElement`)
- **Types/Interfaces**: PascalCase (e.g., `TextInputProps`, `ElementHandler`, `BoxInstance`)
- **JSX intrinsic elements**: camelCase (e.g., `<textInput />`, `<scrollArea />`) - internal use only
- **Component wrappers**: PascalCase (e.g., `<TextInput />`, `<ScrollArea />`) - what users import
- **Element handler exports**: `*Element` for render, `*Layout` for layout (e.g., `BoxElement`, `BoxLayout`)
