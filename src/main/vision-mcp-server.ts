/**
 * Conductor MCP SSE Server — exposes Conductor tools to Claude Code via MCP protocol.
 *
 * Two tool categories:
 *   1. Vision (browser automation via CDP) — requires a connected VisionManager.
 *      Tools return "vision not connected" if the manager is unavailable.
 *   2. Host file access (screenshots, storyboards) — does not need vision.
 *      Used for cross-session image transfer (works for local AND SSH sessions).
 *
 * The server is started at app launch independent of vision config and stays
 * running for the app lifetime. Claude Code discovers it via mcpServers in
 * ~/.claude/settings.json. SSH sessions reach it via reverse tunnel.
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { logInfo, logError } from './debug-logger'
import { getResourcesDirectory } from './ipc/setup-handlers'
import type { VisionCommand, VisionResult } from './vision-manager'

// Lazy-load MCP SDK to avoid import issues in test environments
let McpServer: any = null
let SSEServerTransport: any = null
let z: any = null

function loadMcpDeps(): void {
  if (!McpServer) {
    McpServer = require('@modelcontextprotocol/sdk/server/mcp.js').McpServer
    SSEServerTransport = require('@modelcontextprotocol/sdk/server/sse.js').SSEServerTransport
    z = require('zod')
  }
}

interface VisionManagerInterface {
  executeCommand(cmd: VisionCommand): Promise<VisionResult>
  isConnected(): boolean
  getBrowser(): string
  getDebugPort(): number
}

/** Getter so the MCP server can run before the vision manager exists (or with no browser at all). */
type GetVisionManager = () => VisionManagerInterface | null

let httpServer: http.Server | null = null
let mcpPort: number = 0
const transports = new Map<string, any>()

function resultToMcpContent(result: VisionResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError: !result.ok
  }
}

function visionUnavailable() {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Vision not connected. Open Settings > Vision and launch a browser to enable browser automation tools.' }) }],
    isError: true
  }
}

/**
 * Read an image file from the host's screenshots directory and return it as
 * inline MCP image content. Sandboxed: filename must not contain path separators
 * or '..' segments to prevent escaping the screenshots dir.
 */
function imageFileToMcpContent(filename: string) {
  // Reject anything that isn't a plain filename in the screenshots dir
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Invalid filename — must be a bare filename in the host screenshots directory' }) }],
      isError: true
    }
  }
  try {
    const screenshotsDir = path.join(getResourcesDirectory(), 'screenshots')
    const filePath = path.join(screenshotsDir, filename)
    // Resolve to absolute path and verify containment as a defence-in-depth check
    const resolved = path.resolve(filePath)
    const dirResolved = path.resolve(screenshotsDir)
    if (!resolved.startsWith(dirResolved + path.sep) && resolved !== dirResolved) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Path escape attempt rejected' }) }],
        isError: true
      }
    }
    if (!fs.existsSync(resolved)) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `File not found: ${filename}` }) }],
        isError: true
      }
    }
    const buffer = fs.readFileSync(resolved)
    const lower = filename.toLowerCase()
    const mimeType = lower.endsWith('.png') ? 'image/png'
      : lower.endsWith('.webp') ? 'image/webp'
      : 'image/jpeg'
    return {
      content: [{
        type: 'image' as const,
        data: buffer.toString('base64'),
        mimeType
      }]
    }
  } catch (err: any) {
    logError('[vision-mcp] imageFileToMcpContent failed:', err?.message)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err?.message || 'Read failed' }) }],
      isError: true
    }
  }
}

export async function startMcpServer(port: number, getVisionManager: GetVisionManager): Promise<void> {
  if (httpServer) {
    logInfo('[vision-mcp] Server already running, stopping first')
    stopMcpServer()
  }

  loadMcpDeps()

  // Helper: run a command if vision is connected, otherwise return unavailable
  const withVision = async (cmd: VisionCommand) => {
    const vm = getVisionManager()
    if (!vm) return visionUnavailable()
    return resultToMcpContent(await vm.executeCommand(cmd))
  }

  const createServer = () => {
    const server = new McpServer(
      { name: 'conductor-vision', version: '1.1.0' },
      { capabilities: {} }
    )

    // ── Host file access (always available, no vision required) ────────────

    // -- fetch_host_screenshot --
    // Returns an image from the host's screenshots dir as inline MCP image content.
    // Used by snap, storyboard, and clipboard paste in BOTH local and SSH sessions.
    // SSH sessions reach the MCP server via the existing reverse tunnel.
    server.tool(
      'fetch_host_screenshot',
      'Fetch an image file from the Conductor host\'s screenshots directory and return it as inline image content. The Conductor app saves clipboard pastes, snap captures, and storyboard frames here so they can be viewed by Claude regardless of session type (local or SSH). Use the filename the user references (e.g. "clipboard-1234.jpg" or "screenshot-2026-04-08-...jpg").',
      {
        filename: z.string().describe('Bare filename (no path separators) of an image in the Conductor screenshots directory')
      },
      async ({ filename }: { filename: string }) => {
        return imageFileToMcpContent(filename)
      }
    )

    // ── Vision tools (require connected browser) ────────────────────────────

    // -- Status --
    server.tool('vision_status', 'Check browser connection status', {}, async () => {
      const vm = getVisionManager()
      if (!vm) return resultToMcpContent({ ok: true, data: { connected: false, browser: null } })
      return resultToMcpContent(await vm.executeCommand({ command: 'status', args: [] }))
    })

    // -- Screenshot --
    // Returns inline image content directly (no separate Read tool call needed).
    server.tool('vision_screenshot', 'Capture a screenshot of the current browser page and return it as inline image content. No need to call Read afterwards — the image is included in the response.', {}, async () => {
      const vm = getVisionManager()
      if (!vm) return visionUnavailable()
      const result = await vm.executeCommand({ command: 'screenshot', args: [] })
      if (!result.ok || !result.path) return resultToMcpContent(result)
      // Extract bare filename and return as inline image
      const filename = path.basename(result.path)
      return imageFileToMcpContent(filename)
    })

    // -- Navigate --
    server.tool('vision_navigate', 'Navigate the browser to a URL', {
      url: z.string().describe('URL to navigate to')
    }, async ({ url }: { url: string }) => withVision({ command: 'navigate', args: [url] }))

    // -- Click --
    server.tool('vision_click', 'Click an element by CSS selector or x,y coordinates', {
      target: z.string().describe('CSS selector or "x,y" coordinates')
    }, async ({ target }: { target: string }) => withVision({ command: 'click', args: [target] }))

    // -- Type --
    server.tool('vision_type', 'Type text into an element', {
      selector: z.string().describe('CSS selector of the input element'),
      text: z.string().describe('Text to type')
    }, async ({ selector, text }: { selector: string; text: string }) =>
      withVision({ command: 'type', args: [selector, text] }))

    // -- Eval --
    server.tool('vision_eval', 'Execute JavaScript in the browser and return the result', {
      expression: z.string().describe('JavaScript expression to evaluate')
    }, async ({ expression }: { expression: string }) =>
      withVision({ command: 'eval', args: [expression] }))

    // -- Wait --
    server.tool('vision_wait', 'Wait for a CSS selector to appear on the page', {
      selector: z.string().describe('CSS selector to wait for'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default 5000)')
    }, async ({ selector, timeout }: { selector: string; timeout?: number }) => {
      const args = [selector]
      if (timeout) args.push(String(timeout))
      return withVision({ command: 'wait', args })
    })

    // -- HTML --
    server.tool('vision_html', 'Get the innerHTML of an element', {
      selector: z.string().optional().describe('CSS selector (default: body)')
    }, async ({ selector }: { selector?: string }) =>
      withVision({ command: 'html', args: selector ? [selector] : [] }))

    // -- Text --
    server.tool('vision_text', 'Get the textContent of an element', {
      selector: z.string().optional().describe('CSS selector (default: body)')
    }, async ({ selector }: { selector?: string }) =>
      withVision({ command: 'text', args: selector ? [selector] : [] }))

    // -- Title --
    server.tool('vision_title', 'Get the page title', {}, async () =>
      withVision({ command: 'title', args: [] }))

    // -- URL --
    server.tool('vision_url', 'Get the current page URL', {}, async () =>
      withVision({ command: 'url', args: [] }))

    // -- Tabs --
    server.tool('vision_tabs', 'List all open browser tabs', {}, async () =>
      withVision({ command: 'tabs', args: [] }))

    // -- Tab --
    server.tool('vision_tab', 'Switch to a browser tab by index', {
      index: z.number().describe('Tab index (0-based)')
    }, async ({ index }: { index: number }) =>
      withVision({ command: 'tab', args: [String(index)] }))

    // -- Back --
    server.tool('vision_back', 'Navigate back in browser history', {}, async () =>
      withVision({ command: 'back', args: [] }))

    // -- Forward --
    server.tool('vision_forward', 'Navigate forward in browser history', {}, async () =>
      withVision({ command: 'forward', args: [] }))

    // -- Reload --
    server.tool('vision_reload', 'Reload the current page', {}, async () =>
      withVision({ command: 'reload', args: [] }))

    // -- Scroll --
    server.tool('vision_scroll', 'Scroll the page', {
      direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction (default: down)'),
      pixels: z.number().optional().describe('Pixels to scroll (default: 400)')
    }, async ({ direction, pixels }: { direction?: string; pixels?: number }) => {
      const args: string[] = []
      if (direction) args.push(direction)
      if (pixels) args.push(String(pixels))
      return withVision({ command: 'scroll', args })
    })

    return server
  }

  return new Promise((resolve, reject) => {
    httpServer = http.createServer(async (req, res) => {
      // CORS headers for cross-origin MCP clients
      res.setHeader('Access-Control-Allow-Origin', `http://localhost:${port}`)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === 'GET' && req.url === '/sse') {
        logInfo('[vision-mcp] New SSE connection')
        const server = createServer()
        const transport = new SSEServerTransport('/messages', res)
        transports.set(transport.sessionId, transport)

        res.on('close', () => {
          transports.delete(transport.sessionId)
          logInfo(`[vision-mcp] SSE connection closed (${transports.size} remaining)`)
        })

        try {
          await server.connect(transport)
        } catch (err: any) {
          logError('[vision-mcp] SSE connect error:', err?.message)
        }
        return
      }

      if (req.method === 'POST' && req.url?.startsWith('/messages')) {
        const url = new URL(req.url, `http://localhost:${port}`)
        const sessionId = url.searchParams.get('sessionId')

        if (!sessionId) {
          res.writeHead(400)
          res.end('Missing sessionId')
          return
        }

        const transport = transports.get(sessionId)
        if (!transport) {
          res.writeHead(404)
          res.end('Session not found')
          return
        }

        try {
          await transport.handlePostMessage(req, res)
        } catch (err: any) {
          logError('[vision-mcp] POST handler error:', err?.message)
          if (!res.headersSent) {
            res.writeHead(500)
            res.end('Internal error')
          }
        }
        return
      }

      // Health check endpoint
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          connected: visionManager.isConnected(),
          browser: visionManager.getBrowser(),
          sessions: transports.size
        }))
        return
      }

      res.writeHead(404)
      res.end()
    })

    // Listen on localhost only — SSH reverse tunnels connect to localhost on the remote end
    httpServer.listen(port, '127.0.0.1', () => {
      mcpPort = port
      logInfo(`[vision-mcp] MCP SSE server listening on 127.0.0.1:${port}`)
      resolve()
    })

    httpServer.on('error', (err: any) => {
      logError('[vision-mcp] Server error:', err?.message)
      httpServer = null
      reject(err)
    })
  })
}

export function stopMcpServer(): void {
  if (httpServer) {
    // Close all active transports
    for (const [sessionId, transport] of transports) {
      try { transport.close?.() } catch { /* ignore */ }
    }
    transports.clear()

    httpServer.close()
    httpServer = null
    mcpPort = 0
    logInfo('[vision-mcp] MCP SSE server stopped')
  }
}

export function isMcpServerRunning(): boolean {
  return httpServer !== null
}

export function getMcpPort(): number {
  return mcpPort
}
