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

import type { CanvasSnapshotOptions, CanvasSnapshotResult, CanvasState, SemanticSnapshot } from '../shared/canvas'
import { serializeSnapshot } from '../shared/canvas-snapshot-serialize'
import { wrapUntrustedContent } from '../shared/untrusted-envelope'

/** More than this and the agent should be scoping, not reading everything. */
const MAX_SCOPE_IDS = 50
const MAX_SCOPE_ID_LENGTH = 128

export interface CanvasToolDeps {
  getCanvasState: (sessionId: string) => CanvasState | null
  requestSnapshot: (args: {
    sessionId: string
    canvasId: string
    versionId: string
    options: CanvasSnapshotOptions
  }) => Promise<CanvasSnapshotResult>
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
    .filter((id) => id.length <= MAX_SCOPE_ID_LENGTH && UX_ID_SHAPE.test(id))
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
function captureNotes(result: CanvasSnapshotResult, scope: string[] | undefined): string[] {
  const notes: string[] = []
  if (scope) notes.push(`scoped to ${scope.join(', ')}`)

  if (result.unmatchedScope?.length && scope) {
    // Intersection, not the page's list: a page can claim anything, but it
    // cannot add an id the agent never asked for.
    const requested = new Set(scope)
    const missed = result.unmatchedScope.filter((id) => requested.has(id))
    if (missed.length > 0) notes.push(`${missed.length} of the requested ids matched no element: ${missed.join(', ')}`)
  }

  if (result.truncated) notes.push('the page exceeded the snapshot node limit; this tree is partial')

  if (result.analysisError) {
    // The measurement pass covers flat contrast precisely WHEN axe is absent
    // (snapshot.ts: flatContrast = analysis === null), so the note must not
    // claim the opposite.
    notes.push(
      `the axe rule pass did not run (${result.analysisError}); measurements and contrast still apply, but missing-name and ARIA rules were not checked`,
    )
  }
  return notes
}

export async function runCanvasSnapshot(
  rawArgs: RawArgs,
  sessionId: string,
  deps: CanvasToolDeps,
): Promise<{ text: string; isError: boolean }> {
  const state = deps.getCanvasState(sessionId)
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

  const requestedVersion = typeof rawArgs.versionId === 'string' && rawArgs.versionId.length > 0 ? rawArgs.versionId : null
  const versionId = requestedVersion ?? state.activeVersionId
  if (!state.versions.some((v) => v.id === versionId)) {
    return { text: `This canvas has no version ${versionId}.`, isError: true }
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
    return { text: `Could not capture the canvas: ${err instanceof Error ? err.message : String(err)}`, isError: true }
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
  const body = serializeSnapshot(snapshot, { format })

  return {
    text: wrapUntrustedContent(body, {
      source: 'agent-canvas/snapshot',
      notes: captureNotes(result, scope),
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
    'Read the CURRENTLY RENDERED Agent Canvas page as a compact semantic tree: role, accessible name, box, form state, and measured findings (clipped text, targets below the WCAG minimum, overlapping content, contrast). This is what the page actually looks like once laid out, which its source cannot tell you. Prefer a scoped call: pass the data-ux-id values you care about, and only those nodes carry styles. Requires the Canvas pane to be open on this session.',
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
}
