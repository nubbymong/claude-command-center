// The conductor tools a Codex session's MCP connection may be offered (WP2
// PR 4: P4.1 the canvas tools, P4.2 the vision and in-app browser tools),
// each with the saved switch that offers it, as conductor-mcp-server.ts createServer
// registers them for a Codex source. PURE data, so the launch builder can
// read it without loading the MCP server. A test holds it to what a Codex
// connection really lists (tests/unit/main/conductor-mcp-provider-binding.test.ts).

/** The saved settings that decide which conductor tools a connection is
 *  offered (Settings, General, Built-in Tools): a key that is absent is ON. */
export interface ConductorToolSwitches {
  conductorToolsEnabled?: boolean
  conductorTools?: { vision?: boolean; codexReview?: boolean; claudeReview?: boolean; hostTransfer?: boolean; canvas?: boolean }
}

type SwitchKey = keyof NonNullable<ConductorToolSwitches['conductorTools']>

const switchOn = (s: ConductorToolSwitches, k: SwitchKey): boolean =>
  s.conductorToolsEnabled !== false && s.conductorTools?.[k] !== false

/** The Agent Canvas tools (canvas-mcp-tool.ts registerCanvasTools). */
export const CANVAS_TOOL_NAMES: readonly string[] = [
  'canvas_snapshot', 'canvas_render', 'canvas_review', 'canvas_resolve',
  'canvas_verdict', 'canvas_version_verdict', 'canvas_pick', 'canvas_complete',
]

/** The Conductor vision tools (conductor-mcp-server.ts, the vision group):
 *  they drive the agent's own browser. P4.2. */
export const VISION_TOOL_NAMES: readonly string[] = [
  'vision_status', 'vision_navigate', 'vision_back', 'vision_forward', 'vision_reload',
  'vision_screenshot', 'vision_click', 'vision_type', 'vision_scroll', 'vision_eval',
  'vision_url', 'vision_title', 'vision_text', 'vision_html', 'vision_wait',
  'vision_tabs', 'vision_tab', 'vision_setViewport',
]

export interface CodexConductorTool {
  name: string
  /** Offered under these switches (claude_review also needs a Claude review
   *  to be ready, which the server asks per connection). */
  offered: (s: ConductorToolSwitches) => boolean
}

export const CODEX_CONDUCTOR_TOOLS: ReadonlyArray<CodexConductorTool> = [
  { name: 'fetch_host_screenshot', offered: (s) => switchOn(s, 'hostTransfer') },
  { name: 'claude_review', offered: (s) => switchOn(s, 'claudeReview') },
  ...CANVAS_TOOL_NAMES.map((name): CodexConductorTool => ({ name, offered: (s) => switchOn(s, 'canvas') })),
  // P4.2 (row 52): the vision tools under their switch, and the push to the
  // user's in-app browser under the built-in tools alone (it is neither a
  // vision nor a canvas tool).
  ...VISION_TOOL_NAMES.map((name): CodexConductorTool => ({ name, offered: (s) => switchOn(s, 'vision') })),
  { name: 'open_in_app_browser', offered: (s) => s.conductorToolsEnabled !== false },
]
