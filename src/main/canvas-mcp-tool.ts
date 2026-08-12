// `canvas_snapshot` — the agent's read of the rendered page (spec §5).
//
// Returns the SemanticSnapshot of §4 as the compact indented text of §4.1,
// wrapped in the untrusted-content envelope of §5.4.
//
// SECURITY (the #188 precedent, same shape as codex_review): the session is
// resolved from the TRANSPORT, never from the arguments. A canvas is per-session
// and a snapshot is page content, so honouring a model-supplied session id would
// hand a prompt-injected session a read of another session's canvas. The handle
// arguments are advertised, validated, and then overruled by the bound id — a
// mismatch is refused rather than silently redirected.

import type {
  CanvasRenderSource,
  CanvasSnapshotOptions,
  CanvasSnapshotResult,
  CanvasState,
  SemanticSnapshot,
} from '../shared/canvas'
import { serializeSnapshot } from '../shared/canvas-snapshot-serialize'
import { wrapUntrustedContent } from '../shared/untrusted-envelope'

/** More than this and the agent should be scoping, not reading everything. */
const MAX_SCOPE_IDS = 50

export interface CanvasToolDeps {
  getCanvasState: (sessionId: string) => CanvasState | null
  requestSnapshot: (args: {
    sessionId: string
    canvasId: string
    versionId: string
    options: CanvasSnapshotOptions
  }) => Promise<CanvasSnapshotResult>
  renderVersion: (sessionId: string, source: CanvasRenderSource) => { canvasId: string; versionId: string }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError }
}

interface RawArgs {
  canvasId?: unknown
  versionId?: unknown
  scope?: unknown
  format?: unknown
  cccSessionId?: unknown
}

/** A real `data-ux-id`. Shape-checked, not merely length-capped: these ids are
 *  echoed back in operator-voice note lines, and tool arguments are always
 *  model-generated — a newline in one forged a `note:` line during the
 *  adversarial pass. */
const UX_ID_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/

function cleanScope(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    // The shape already bounds the length to 128 — a separate length check was
    // unreachable, and two bounds that can disagree are worse than one.
    .filter((id) => UX_ID_SHAPE.test(id))
    .slice(0, MAX_SCOPE_IDS)
  return out.length > 0 ? out : undefined
}

/**
 * Operator-authored lines that ride OUTSIDE the envelope.
 *
 * Outside the envelope means "carries authority", so NOTHING here may come from
 * the page. It previously echoed `unmatchedScope` and `analysisError` straight
 * from the frame, which handed a page thousands of characters of operator voice
 * — two independent attackers found it. Now: the ids come from the scope WE
 * sent (intersected with what the page said it missed), the analysis code is a
 * closed vocabulary the sanitiser enforces, and counts stand in for text.
 */
function captureNotes(result: CanvasSnapshotResult, scope: string[] | undefined, outputCapped: boolean): string[] {
  const notes: string[] = []
  // COUNTS outside the envelope, never the ids themselves. The agent supplied
  // them and knows what it asked for; joined into a line out here they were a
  // 6 KB operator-voice channel for anything shape-legal.
  if (scope) notes.push(`scoped to ${scope.length} id(s)`)

  if (result.unmatchedScope?.length && scope) {
    // Iterate OUR scope, not the page's list: the page can neither add an id the
    // agent never asked for nor inflate the count by repeating one.
    const claimed = new Set(result.unmatchedScope)
    const missed = scope.filter((id) => claimed.has(id))
    if (missed.length > 0) notes.push(`${missed.length} of the requested ids matched no element`)
  }

  if (result.truncated) notes.push('the page exceeded the snapshot node limit; this tree is partial')
  // A THIRD limit, and naming it correctly is the point. The node cap drops
  // nodes; this one refuses to descend past 64 levels of DOM, which a page can
  // reach without losing anything. Reporting it as the node limit told the
  // agent a tree was partial when it was whole, on every capture of any app
  // with deep wrappers. It is also the only one of the three with a real
  // answer: each scope root restarts the walk at depth zero.
  if (result.depthLimited) {
    notes.push('the page nests deeper than this walk goes; anything below that depth is absent. Scope to a data-ux-id inside the deep region to reach it')
  }
  // Not a limit of ours at all, unlike the three around it, and the only one
  // with NO remedy: a closed shadow root cannot be read by any means available
  // to a script in the page. Saying so is the whole value — an unreviewed region
  // reported as a clean one is the failure this note exists to prevent.
  if (result.hiddenContent) {
    notes.push('part of this page keeps its content in a closed shadow root; that content is painted but could not be read, and nothing in this tree describes it')
  }
  // Narrower than the three above: one RULE stopped early, not the walk. Said
  // anyway, because the alternative is a node reporting "no overlap" in the
  // same words whether it looked at its neighbours or ran out of budget first.
  if (result.overlapLimited) {
    notes.push('the overlap check ran out of comparisons on a crowded part of this page; boxes there were not compared to each other. Scope to a data-ux-id in that region to check it')
  }
  // A DIFFERENT limit from the one above, and worth saying so: the node cap
  // drops nodes at capture, this one stops the write-out. Reporting both as
  // "the node limit" is how a 600-row list quietly became 500 rows under a note
  // that blamed the wrong thing.
  if (outputCapped) notes.push('this snapshot hit the output size limit and was cut short; scope the call to see the rest')

  if (result.analysisError) {
    // Accurate for both failure modes: the bridge recomputes contrast coverage
    // after a failed run, so the measurement pass claims flat contrast whenever
    // axe did not.
    notes.push(
      `the axe rule pass did not run (${result.analysisError}); measurements and contrast still apply, but missing-name and ARIA rules were not checked`,
    )
  }
  return notes
}

/** Operator-authored causes for a failed capture. The frame's own error text is
 *  never relayed — it is page-controlled and lands outside the envelope. */
function captureFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : ''
  if (/no Agent Canvas is open|does not match|showing/i.test(message)) {
    return 'the Agent Canvas is not open on the requested canvas and version. Ask the user to open it.'
  }
  if (/not loaded yet|in time/i.test(message)) return 'the canvas page did not finish loading in time. Try again in a moment.'
  if (/in flight/i.test(message)) return 'another capture is already running for this session. Try again in a moment.'
  if (/window is not available/i.test(message)) return 'the app window is not available.'
  return 'the canvas frame could not produce a snapshot.'
}

/**
 * Operator-authored causes for a refused render.
 *
 * The store's own messages are NOT relayed, for the same reason the frame's are
 * not: they are built from arguments the model supplied and from paths on this
 * machine ("distRoot does not exist" is harmless, `path.resolve` of a hostile
 * string is not), and this line lands outside the untrusted envelope where it
 * carries operator authority. Closed vocabulary, matched on shape.
 */
function renderFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : ''
  if (/version cap/i.test(message)) {
    return 'this canvas has reached its version limit. Start a new session to render again.'
  }
  if (/registered canvas UAT root/i.test(message)) {
    return 'that directory is not under a folder the user has allowed the canvas to serve. Ask the user to add it in the Canvas pane.'
  }
  if (/distRoot does not exist|not a directory/i.test(message)) return 'that build directory does not exist.'
  if (/document too large/i.test(message)) return 'that document is too large to render.'
  if (/requires html/i.test(message)) return 'a design render needs an html document.'
  if (/invalid entry/i.test(message)) return 'that entry file name is not a plain relative path.'
  return 'the canvas could not be rendered.'
}

interface RawRenderArgs {
  mode?: unknown
  html?: unknown
  distRoot?: unknown
  entry?: unknown
  buildLabel?: unknown
  cccSessionId?: unknown
}

/**
 * A build label is the ONE free-text field on this path, and it is echoed back
 * in an operator-voice confirmation line outside the envelope. Shape-checked
 * rather than length-capped for the reason `scope` was: a newline in a
 * model-supplied argument forged a note line during the adversarial pass.
 */
const BUILD_LABEL_SHAPE = /^[A-Za-z0-9 _.:@/+-]{1,64}$/

export async function runCanvasRender(
  rawArgs: RawRenderArgs,
  sessionId: string,
  deps: CanvasToolDeps,
): Promise<{ text: string; isError: boolean }> {
  const mode = rawArgs.mode
  if (mode !== 'design' && mode !== 'uat') {
    return { text: "Render needs a mode of 'design' (an html document) or 'uat' (a built directory).", isError: true }
  }

  let source: CanvasRenderSource
  if (mode === 'design') {
    // Shape first, and fail closed on it: the store's own check is `typeof
    // !== 'string'`, and an array of strings reaching a byte-length measure
    // ahead of a write is the kind of thing this layer exists to stop early.
    if (typeof rawArgs.html !== 'string' || rawArgs.html.length === 0) {
      return { text: 'A design render needs an html document in `html`.', isError: true }
    }
    source = { mode: 'design', html: rawArgs.html }
  } else {
    if (typeof rawArgs.distRoot !== 'string' || rawArgs.distRoot.length === 0) {
      return { text: 'A uat render needs the built directory in `distRoot`.', isError: true }
    }
    if (rawArgs.entry != null && typeof rawArgs.entry !== 'string') {
      return { text: 'That entry is not a file name.', isError: true }
    }
    // Refused here rather than trimmed: a label that does not fit the shape is
    // a label the model got wrong, and silently rewriting it would put words
    // the agent did not choose into an operator-voice line.
    if (rawArgs.buildLabel != null && (typeof rawArgs.buildLabel !== 'string' || !BUILD_LABEL_SHAPE.test(rawArgs.buildLabel))) {
      return { text: 'That build label is not a short plain label.', isError: true }
    }
    source = {
      mode: 'uat',
      distRoot: rawArgs.distRoot,
      ...(typeof rawArgs.entry === 'string' && rawArgs.entry.length > 0 ? { entry: rawArgs.entry } : {}),
      ...(typeof rawArgs.buildLabel === 'string' ? { buildLabel: rawArgs.buildLabel } : {}),
    }
  }

  let rendered: { canvasId: string; versionId: string }
  try {
    // The session comes from the TRANSPORT and nowhere else — the #188
    // precedent. A canvas is per-session, and a render is a WRITE: honouring a
    // model-supplied session id would let a prompt-injected session push a
    // document onto another session's canvas, where the user would read it as
    // their own agent's work.
    rendered = deps.renderVersion(sessionId, source)
  } catch (err) {
    return { text: `Could not render the canvas: ${renderFailureReason(err)}`, isError: true }
  }

  // Both ids are ours: one minted by the store, one a `v<n>` counter. Nothing
  // the model supplied is echoed back except a build label that passed the
  // shape above.
  return {
    text:
      `Rendered ${rendered.versionId} on canvas ${rendered.canvasId}. ` +
      'It is not on screen until the user opens the Canvas pane — hand back to them, then call canvas_snapshot to read what was actually laid out.',
    isError: false,
  }
}

export async function runCanvasSnapshot(
  rawArgs: RawArgs,
  sessionId: string,
  deps: CanvasToolDeps,
): Promise<{ text: string; isError: boolean }> {
  // Inside the guard, not outside it. Reading the store touches the filesystem,
  // and a throw here escaped this function entirely into the MCP SDK, which
  // relays the raw message — including a path — to the model, unwrapped and
  // outside the untrusted envelope. Everything else was already guarded; this
  // one call sat above the net.
  let state: CanvasState | null
  try {
    state = deps.getCanvasState(sessionId)
  } catch {
    return { text: 'Could not capture the canvas: this session’s canvas could not be read.', isError: true }
  }
  if (!state || !state.activeVersionId) {
    return {
      text: 'This session has no rendered canvas yet. Render one first, then ask the user to open the Canvas pane.',
      isError: true,
    }
  }

  // Advertised, checked, never trusted: a mismatch means the model is aiming at
  // a canvas that is not this session's. Written to fail CLOSED — anything
  // present that is not exactly this canvas's id is refused, including an array
  // or an object that would slip past a `typeof === 'string'` test.
  if (rawArgs.canvasId != null && rawArgs.canvasId !== state.canvasId) {
    return { text: 'That canvasId does not belong to this session.', isError: true }
  }

  // Fail closed on shape, the same way canvasId does. A non-string versionId
  // (array, object, number, boxed String) used to fall through to "use the
  // active version", silently answering a question the model did not ask.
  if (rawArgs.versionId != null && typeof rawArgs.versionId !== 'string') {
    return { text: 'That versionId is not a version id.', isError: true }
  }
  const requestedVersion = typeof rawArgs.versionId === 'string' && rawArgs.versionId.length > 0 ? rawArgs.versionId : null
  const versionId = requestedVersion ?? state.activeVersionId
  if (!state.versions.some((v) => v.id === versionId)) {
    // The id is NOT echoed. Tool arguments are model-generated, this string is
    // unwrapped operator voice, and `scope` had to be hardened for exactly this
    // reason — an unbounded echo here would have been the same hole.
    return {
      text: `This canvas has no such version. It has: ${state.versions.map((v) => v.id).join(', ')}.`,
      isError: true,
    }
  }

  const scope = cleanScope(rawArgs.scope)
  let result: CanvasSnapshotResult
  try {
    result = await deps.requestSnapshot({
      sessionId,
      canvasId: state.canvasId,
      versionId,
      options: { scope, analysis: true },
    })
  } catch (err) {
    // NEVER relay the frame's own words. The failure text travels page → bridge
    // → renderer → broker → here, so a hostile document authors it end to end —
    // and this path is not inside the untrusted envelope. An attacker used it to
    // emit a working envelope terminator plus forged operator notes. Only
    // operator-authored causes reach the agent.
    return { text: `Could not capture the canvas: ${captureFailureReason(err)}`, isError: true }
  }

  const snapshot: SemanticSnapshot = {
    versionId,
    // Stamped here, not in the content frame: neither the time nor the version
    // is the page's to assert.
    capturedAt: new Date().toISOString(),
    viewport: result.viewport,
    root: result.root,
  }
  const format = rawArgs.format === 'json' ? 'json' : 'text'
  const serialized = serializeSnapshot(snapshot, { format })

  return {
    text: wrapUntrustedContent(serialized.text, {
      source: 'agent-canvas/snapshot',
      notes: captureNotes(result, scope, serialized.truncated),
    }),
    isError: false,
  }
}

export function registerCanvasTools(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: any, // McpServer — lazy-typed in conductor-mcp-server.ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zMod: any, // the lazily-loaded zod module (same convention as registerCodexReviewTool)
  getBoundSessionId: () => string | null,
  deps: CanvasToolDeps,
): void {
  server.tool(
    'canvas_snapshot',
    'Read the CURRENTLY RENDERED Agent Canvas page as a compact semantic tree: role, accessible name, box, form state, and measured findings (clipped text, targets below the WCAG minimum, overlapping content, contrast). These are layout-time facts the page source cannot tell you. It is gathered by instrumentation running INSIDE the page, so it is the page\'s own report of itself rather than independent ground truth — a page that runs scripts can misreport, and a clean result means "nothing was reported", not "nothing is wrong". Prefer a scoped call: pass the data-ux-id values you care about, and only those nodes carry styles. Requires the Canvas pane to be open on this session.',
    {
      canvasId: zMod
        .string()
        .optional()
        .describe('Optional. The canvas this session owns; a foreign id is refused rather than followed.'),
      versionId: zMod.string().optional().describe("Optional. Defaults to the version on screen, e.g. 'v3'."),
      scope: zMod
        .array(zMod.string())
        .optional()
        .describe(
          'Optional data-ux-id values to scope to. Strongly preferred on dense pages: an unscoped snapshot is many times the size.',
        ),
      format: zMod
        .enum(['text', 'json'])
        .optional()
        .describe("Optional. 'text' (default) is the compact tree; 'json' is the raw snapshot and costs several times more."),
      cccSessionId: zMod
        .string()
        .optional()
        .describe('Ignored — the session is resolved from the MCP connection and cannot be set here. Leave unset.'),
    },
    async (rawArgs: RawArgs) => {
      const sessionId = getBoundSessionId()
      if (!sessionId) {
        return textResult(
          'Canvas unavailable: this MCP connection has no bound Conductor session. Restart the session from inside AI Code Conductor.',
          true,
        )
      }
      const result = await runCanvasSnapshot(rawArgs, sessionId, deps)
      return textResult(result.text, result.isError)
    },
  )

  server.tool(
    'canvas_render',
    'Put a page on this session\'s Agent Canvas so it can be laid out by a real browser engine and then read back with canvas_snapshot. Two modes. \'design\': you supply a complete HTML document and it is served from the canvas\'s own origin — use this to show a proposed screen. \'uat\': you supply the path of a directory the user has already allowed, and the built app in it is served — use this to review the real product. Every call creates a new version; nothing is overwritten. The canvas is per-session and this tool always renders to THIS session\'s canvas. Rendering does not put it on screen: hand back to the user so they can open the Canvas pane.',
    {
      mode: zMod.enum(['design', 'uat']).describe("'design' renders the html you supply; 'uat' serves a directory the user has allowed."),
      html: zMod
        .string()
        .optional()
        .describe('design mode only. A complete HTML document. Put a data-ux-id on anything you will want to ask about later.'),
      distRoot: zMod
        .string()
        .optional()
        .describe('uat mode only. Absolute path of the built directory. It must sit under a folder the user has allowed for this; anything else is refused.'),
      entry: zMod.string().optional().describe("uat mode only. Entry file relative to distRoot. Defaults to 'index.html'."),
      buildLabel: zMod.string().optional().describe('uat mode only. Optional short label for this build, shown to the user.'),
      cccSessionId: zMod
        .string()
        .optional()
        .describe('Ignored — the session is resolved from the MCP connection and cannot be set here. Leave unset.'),
    },
    async (rawArgs: RawRenderArgs) => {
      const sessionId = getBoundSessionId()
      if (!sessionId) {
        return textResult(
          'Canvas unavailable: this MCP connection has no bound Conductor session. Restart the session from inside AI Code Conductor.',
          true,
        )
      }
      const result = await runCanvasRender(rawArgs, sessionId, deps)
      return textResult(result.text, result.isError)
    },
  )
}
