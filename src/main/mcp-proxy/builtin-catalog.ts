/**
 * Conductor Proxy — built-in tool catalog (T9, #102).
 *
 * SINGLE SOURCE OF TRUTH for the Conductor built-in tools (browser vision +
 * host file transfer). Previously these were ~19 inline `server.tool(...)` calls
 * in conductor-mcp-server.ts, always advertised directly — a parallel set that
 * bloated the tool context regardless of the proxy.
 *
 * Each entry pairs a JSON Schema (converted to Zod for direct registration via
 * the T4 converter, and used verbatim by describe_tool in search mode) with a
 * `run` handler. conductor-mcp-server drives the catalog two ways:
 *   - builtinExposure 'passthrough' (default): register directly — byte-for-byte
 *     the same tools/behavior as before.
 *   - builtinExposure 'search': hand the catalog to the proxy facade as local
 *     tools, so they are discoverable via search_tools and invoked via call_tool
 *     (namespaced conductor__<name>) instead of bloating the advertised list.
 *
 * codex_review is intentionally NOT in this catalog — it is a single tool with
 * its own per-session ACL and stays registered directly (see conductor-mcp-server).
 */

import * as path from 'path'
import type { VisionCommand } from '../vision-manager'

/** Minimal MCP tool result shape the handlers return. */
export interface McpContentResult {
  content: Array<Record<string, unknown>>
  isError?: boolean
}

/** Operations the built-in handlers need, injected per client connection so
 *  vision routing stays bound to that connection's session (boundSessionId). */
export interface BuiltinCtx {
  withVision: (cmd: VisionCommand) => Promise<McpContentResult>
  getVisionManager: () => { executeCommand: (cmd: VisionCommand) => Promise<any> } | null
  imageFileToMcpContent: (filename: string) => McpContentResult
  resultToMcpContent: (result: any) => McpContentResult
  visionUnavailable: () => McpContentResult
  boundSessionId: string | null
}

export type BuiltinGroup = 'vision' | 'hostTransfer'

export interface BuiltinTool {
  name: string
  group: BuiltinGroup
  description: string
  /** JSON Schema for the tool input (object schema; empty properties = no args). */
  jsonSchema: Record<string, unknown>
  run: (args: Record<string, unknown>, ctx: BuiltinCtx) => Promise<McpContentResult> | McpContentResult
}

/** Build an object JSON Schema. */
function obj(
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> {
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties }
}
const str = (description: string) => ({ type: 'string', description })
const num = (description: string) => ({ type: 'number', description })

/** The catalog. Handlers mirror the original inline registrations exactly. */
export function builtinCatalog(): BuiltinTool[] {
  return [
    // ── Host file access ──
    {
      name: 'fetch_host_screenshot',
      group: 'hostTransfer',
      description:
        'Fetch an image file from the Conductor host\'s screenshots directory and return it as inline image content. The Conductor app saves clipboard pastes, snap captures, and storyboard frames here so they can be viewed by Claude regardless of session type (local or SSH). Use the filename the user references (e.g. "clipboard-1234.jpg" or "screenshot-2026-04-08-...jpg").',
      jsonSchema: obj(
        { filename: str('Bare filename (no path separators) of an image in the Conductor screenshots directory') },
        ['filename'],
      ),
      run: (args, ctx) => ctx.imageFileToMcpContent(String(args.filename ?? '')),
    },

    // ── Vision ──
    {
      name: 'vision_status',
      group: 'vision',
      description: 'Check browser connection status',
      jsonSchema: obj(),
      run: async (_args, ctx) => {
        const vm = ctx.getVisionManager()
        if (!vm) return ctx.resultToMcpContent({ ok: true, data: { connected: false, browser: null } })
        return ctx.resultToMcpContent(
          await vm.executeCommand({ command: 'status', args: [], sessionId: ctx.boundSessionId ?? undefined }),
        )
      },
    },
    {
      name: 'vision_screenshot',
      group: 'vision',
      description:
        'Capture a screenshot of the current browser page and return it as inline image content. No need to call Read afterwards — the image is included in the response.',
      jsonSchema: obj(),
      run: async (_args, ctx) => {
        const vm = ctx.getVisionManager()
        if (!vm) return ctx.visionUnavailable()
        const result = await vm.executeCommand({ command: 'screenshot', args: [], sessionId: ctx.boundSessionId ?? undefined })
        if (!result.ok || !result.path) return ctx.resultToMcpContent(result)
        return ctx.imageFileToMcpContent(path.basename(result.path))
      },
    },
    {
      name: 'vision_navigate',
      group: 'vision',
      description: 'Navigate the browser to a URL',
      jsonSchema: obj({ url: str('URL to navigate to') }, ['url']),
      run: (args, ctx) => ctx.withVision({ command: 'navigate', args: [String(args.url)] }),
    },
    {
      name: 'vision_click',
      group: 'vision',
      description: 'Click an element by CSS selector or x,y coordinates',
      jsonSchema: obj({ target: str('CSS selector or "x,y" coordinates') }, ['target']),
      run: (args, ctx) => ctx.withVision({ command: 'click', args: [String(args.target)] }),
    },
    {
      name: 'vision_type',
      group: 'vision',
      description: 'Type text into an element',
      jsonSchema: obj(
        { selector: str('CSS selector of the input element'), text: str('Text to type') },
        ['selector', 'text'],
      ),
      run: (args, ctx) => ctx.withVision({ command: 'type', args: [String(args.selector), String(args.text)] }),
    },
    {
      name: 'vision_eval',
      group: 'vision',
      description: 'Execute JavaScript in the browser and return the result',
      jsonSchema: obj({ expression: str('JavaScript expression to evaluate') }, ['expression']),
      run: (args, ctx) => ctx.withVision({ command: 'eval', args: [String(args.expression)] }),
    },
    {
      name: 'vision_wait',
      group: 'vision',
      description: 'Wait for a CSS selector to appear on the page',
      jsonSchema: obj({
        selector: str('CSS selector to wait for'),
        timeout: num('Timeout in milliseconds (default 5000)'),
      }, ['selector']),
      run: (args, ctx) => {
        const a = [String(args.selector)]
        if (args.timeout) a.push(String(args.timeout))
        return ctx.withVision({ command: 'wait', args: a })
      },
    },
    {
      name: 'vision_html',
      group: 'vision',
      description: 'Get the innerHTML of an element',
      jsonSchema: obj({ selector: str('CSS selector (default: body)') }),
      run: (args, ctx) => ctx.withVision({ command: 'html', args: args.selector ? [String(args.selector)] : [] }),
    },
    {
      name: 'vision_text',
      group: 'vision',
      description: 'Get the textContent of an element',
      jsonSchema: obj({ selector: str('CSS selector (default: body)') }),
      run: (args, ctx) => ctx.withVision({ command: 'text', args: args.selector ? [String(args.selector)] : [] }),
    },
    {
      name: 'vision_title',
      group: 'vision',
      description: 'Get the page title',
      jsonSchema: obj(),
      run: (_args, ctx) => ctx.withVision({ command: 'title', args: [] }),
    },
    {
      name: 'vision_url',
      group: 'vision',
      description: 'Get the current page URL',
      jsonSchema: obj(),
      run: (_args, ctx) => ctx.withVision({ command: 'url', args: [] }),
    },
    {
      name: 'vision_tabs',
      group: 'vision',
      description: 'List all open browser tabs',
      jsonSchema: obj(),
      run: (_args, ctx) => ctx.withVision({ command: 'tabs', args: [] }),
    },
    {
      name: 'vision_tab',
      group: 'vision',
      description: 'Switch to a browser tab by index',
      jsonSchema: obj({ index: num('Tab index (0-based)') }, ['index']),
      run: (args, ctx) => ctx.withVision({ command: 'tab', args: [String(args.index)] }),
    },
    {
      name: 'vision_back',
      group: 'vision',
      description: 'Navigate back in browser history',
      jsonSchema: obj(),
      run: (_args, ctx) => ctx.withVision({ command: 'back', args: [] }),
    },
    {
      name: 'vision_forward',
      group: 'vision',
      description: 'Navigate forward in browser history',
      jsonSchema: obj(),
      run: (_args, ctx) => ctx.withVision({ command: 'forward', args: [] }),
    },
    {
      name: 'vision_reload',
      group: 'vision',
      description: 'Reload the current page',
      jsonSchema: obj(),
      run: (_args, ctx) => ctx.withVision({ command: 'reload', args: [] }),
    },
    {
      name: 'vision_scroll',
      group: 'vision',
      description: 'Scroll the page',
      jsonSchema: obj({
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (default: down)' },
        pixels: num('Pixels to scroll (default: 400)'),
      }),
      run: (args, ctx) => {
        const a: string[] = []
        if (args.direction) a.push(String(args.direction))
        if (args.pixels) a.push(String(args.pixels))
        return ctx.withVision({ command: 'scroll', args: a })
      },
    },
    {
      name: 'vision_setViewport',
      group: 'vision',
      description:
        'Set the browser viewport size (and optional deviceScaleFactor) for THIS session. The default headless viewport is ~800x600, which trips responsive layouts and clips wide content -- set e.g. 1440x900 to render at desktop size.',
      jsonSchema: obj({
        width: num('Viewport width in CSS pixels'),
        height: num('Viewport height in CSS pixels'),
        deviceScaleFactor: num('Device pixel ratio (default 1)'),
      }, ['width', 'height']),
      run: (args, ctx) => {
        const a = [String(args.width), String(args.height)]
        if (args.deviceScaleFactor !== undefined) a.push(String(args.deviceScaleFactor))
        return ctx.withVision({ command: 'setViewport', args: a })
      },
    },
  ]
}
