// The conductor tools a Codex session's MCP connection may be offered (WP2
// PR 4, P4.1; P4.2 adds the vision and in-app browser tools), each with the
// saved switch that offers it, as conductor-mcp-server.ts createServer
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
]
