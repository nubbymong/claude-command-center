## 2026-08-11 -- Agent Canvas P2: the semantic snapshot the bridge produces

P1 gave the canvas a bridge that could report role/name/box per element. P2 turns
that into the `SemanticSnapshot` of spec section 4: the tree an agent reviews a
rendered page from, with measurements and findings attached. This entry covers
the capture side; the `canvas_snapshot` MCP tool and per-version persistence
follow.

### The bridge is now bundled

The bridge stopped being hand-written page JS. It composes dom-accessibility-api
(accessible names, by the accname algorithm) and axe-core (rules), so it has to
be built before it can be served as one classic script.

`scripts/vite-plugin-canvas-bridge.mjs` resolves two virtual modules to esbuild
bundles, and is registered in both `electron.vite.config.ts` and
`vitest.config.ts` -- so the string the tests drive is the string ccc-ux://
serves. Nothing is generated into the tree: there is no committed bundle for a
reviewer to have to diff.

The bridge moved to TypeScript under `src/main/canvas/bridge/` and is type-checked
by its own `tsconfig.bridge.json` (DOM lib, no Node types); the main-process
project excludes that directory. Sharing `src/shared/canvas.ts` means the tree
the bridge emits and the type the main process consumes cannot drift.

### Two bundles, not one

axe-core is ~600 KB and the bridge is injected into EVERY document the canvas
serves. So the rule engine is a second bundle at `/__ccc__/canvas-analysis.js`,
pulled in by a dynamic `import()` on the first snapshot that asks for analysis --
not a `<script>` planted in the page, because the bridge does not mutate the page
it reports on (D8). A blocked or slow chunk degrades to measurement-only with
`analysisError` set, and both the load and the run are bounded by timeouts.

axe also supplies the role resolver (`axe.commons.aria.getRole`, feature-detected,
falling back to the bridge's own table). aria-query was dropped: it is a data
table, not a resolver, and axe already carries a real HTML-AAM implementation.

### What the measurement pass claims, and what it does not

The findings that exist only in the render, which source review structurally
cannot reach: text clipped by its own box, hit targets under the WCAG 2.2
minimum, in-flow content boxes overlapping, and contrast.

Contrast is split deliberately. axe owns flat backgrounds when it is running.
The measurement pass owns GRADIENTS -- axe reports `color-contrast: incomplete`
the moment a background-image is involved, so every gradient surface silently
goes unchecked; here the gradient's own stops are the backdrop and the worst stop
decides. Where the background is a photo or an asset, no claim is made at all:
that needs the rendered pixels, and guessing there is how a tool earns a
reputation for false positives.

Both HARD requirements from the P0 run-2 post-mortem are in: form-state semantics
(type/checked/disabled/value/aria-invalid/effective opacity) and an sr-only
heuristic that suppresses size and contrast findings on deliberately hidden
content. Field values are redacted for password/hidden inputs and secret-looking
field names -- the snapshot goes to the agent verbatim.

### Token economy

Styles ride only on scoped nodes (section 4.1), and inherited values that a child
does not change are dropped -- what a reviewer needs is where a value CHANGES.
Measured on a 20-card jsdom fixture (121 nodes):

    unscoped        6,597 chars  (~1,885 tokens)
    scoped, 1 card    666 chars  (~190 tokens)   = 10.1% of unscoped
    unscoped as JSON 33,279 chars (~9,508 tokens) -- the text form is 20% of it

That clears the section 10 P2 bar (scoped under 15% of unscoped).

### Standing limitations

- The 10-seeded-defect acceptance run needs real layout and real paint, so it
  belongs on the fixture page in a browser, not in jsdom. The unit suite pins the
  logic on top of geometry; geometry itself is stubbed.
- CI does not run Playwright, so an E2E acceptance spec would not be executed by
  the PR gate. That measurement is tracked with the fixture page work.
- The analysis chunk lives as a ~600 KB string in the main-process bundle. It is
  only parsed in the content frame, and only when analysis is requested.
