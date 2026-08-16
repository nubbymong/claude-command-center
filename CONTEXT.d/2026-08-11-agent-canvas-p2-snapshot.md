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

Roles come from the bridge's own implicit-role table, not from axe -- see the
adversarial section below for why that is deliberate. aria-query was dropped from
the plan: it is a data table, not a resolver.

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

### `canvas_snapshot`, and the hop that did not exist

The snapshot is produced where the page is: inside the canvas iframe, in the
renderer. The MCP tool runs in main. Nothing in the app had a main -> renderer
REQUEST before this -- every one of the ~40 main -> renderer paths is a one-way
push -- so this establishes one, narrowly: `CANVAS_SNAPSHOT_REQUEST` out,
`CANVAS_SNAPSHOT_RESULT` back, correlated by request id, with a hard timeout, a
concurrency cap, and no ability to ask for anything except a snapshot.

The renderer half is armed once at boot rather than by the canvas pane, so a
request that arrives with nothing mounted answers "open the Canvas pane" instead
of going quiet -- the same lesson the cloud-agent listeners taught. The pane
publishes its live frame while mounted; a request for a different canvas or a
version that is not the one on screen is refused rather than silently answered
with the wrong page.

Session binding follows the #188 precedent exactly (codex_review): the session
comes from the TRANSPORT and the model-supplied id is advertised, ignored, and
overruled. A canvas is per-session and a snapshot is page content, so honouring
a model-supplied session id would hand a prompt-injected session a read of
another session's canvas. A `canvasId` that does not belong to the bound session
is refused, not followed.

Two things treat the payload as hostile, because it is assembled by the page:

- `canvas-snapshot-sanitize.ts` bounds every string, coerces every number, caps
  nodes/depth/children/issues/styles, and strips control characters so page text
  cannot forge a line in the wire format. It runs in the renderer (bounding what
  crosses IPC) and again in main. A cyclic tree -- structured clone carries
  cycles happily, and the serializer would recurse forever on one -- terminates
  at the depth cap and is reported as truncated.
- `untrusted-envelope.ts` wraps the body per section 5.4 and DEFANGS the markers
  inside it. Without that, a page containing the closing tag would end the
  envelope early and everything after it would read as operator instruction.

The tool ships behind a `canvas` toggle in the same four renderer places as the
other built-in tools. The onboarding recap's tool count is now derived from the
gate list instead of a hard-coded "of 3".

### The adversarial pass, and what it says about the tests

Five independent attackers over two rounds (ADR-009). Two findings are worth
recording beyond their fixes, because both were invisible to a green suite.

**axe never ran.** The analysis chunk was bundled as an IIFE and consumed with a
dynamic import(), so the loader threw on every snapshot: eleven advertised rules
silently never evaluated. Nothing failed, because the degradation path was the
ONLY path and the "graceful degradation" test asserted it happily. A test that
cannot fail is worse than no test; the guard now evaluates the served string as a
module and was verified fail-first against the old format.

**Fixing that lit up code that had never executed.** With axe genuinely loading,
`axe.commons.aria.getRole` — which only works between axe.setup() and teardown —
threw on every call, was swallowed to null, and emptied the role on every node.
The semantic tree degraded to a box list. Invisible again, because every snapshot
test passed `analysis: false`. The resolver is gone: an undocumented internal
that works only inside a run is not worth the fragility when the table always
works.

The rest clustered on one root cause: **treating a marker as a literal instead of
banning a pattern.** The envelope defang matched exact lowercase text, so case
and whitespace variants passed — and the sanitiser's own newline-to-space rewrite
MANUFACTURED the whitespace variant. Round two beat the pattern version too, with
`<//untrusted-content>` and homoglyphs that are pixel-identical and match no
ASCII pattern. The answer was to stop guessing spellings and escape every `<`.
The same shape appeared in the wire format, where a plain CSS `font-family` with
fullwidth brackets forged `[sr-only]` — the token that tells the agent to stop
reporting a node.

Verdict recorded on #256 as **FINDINGS**, not PASS: everything found is fixed
with a guard, but the round-2 fixes have not themselves been independently
attacked, and round 2 is the reason that distinction matters.

### Standing limitations

- The 10-seeded-defect acceptance run needs real layout and real paint, so it
  belongs on the fixture page in a browser, not in jsdom. The unit suite pins the
  logic on top of geometry; geometry itself is stubbed.
- CI does not run Playwright, so an E2E acceptance spec would not be executed by
  the PR gate. That measurement is tracked with the fixture page work.
- The analysis chunk lives as a ~600 KB string in the main-process bundle. It is
  only parsed in the content frame, and only when analysis is requested.
- Transport session-binding is a URL parameter, inherited from the codex_review
  precedent. An attacker argued the original justification transfers less well to
  a snapshot, which is runtime state existing in no file. Capture still requires
  the victim's Canvas pane to be open on that canvas and version. The binding
  mechanism is a repo-wide follow-up, not a P2 change.
