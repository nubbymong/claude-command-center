/**
 * Vision MCP SSE Server — exposes browser vision tools to Claude Code via MCP protocol.
 * Wraps VisionManager to provide screenshot, navigate, click, type, eval, etc.
 * Claude Code discovers these tools via mcpServers in ~/.claude/settings.json.
 */

import * as http from 'http'
import { logInfo, logError } from './debug-logger'
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

let httpServer: http.Server | null = null
let mcpPort: number = 0
const transports = new Map<string, any>()

function resultToMcpContent(result: VisionResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError: !result.ok
  }
}

export async function startMcpServer(port: number, visionManager: VisionManagerInterface): Promise<void> {
  if (httpServer) {
    logInfo('[vision-mcp] Server already running, stopping first')
    stopMcpServer()
  }

  loadMcpDeps()

  const createServer = () => {
    const server = new McpServer(
      { name: 'conductor-vision', version: '1.0.0' },
      { capabilities: {} }
    )

    // -- Status --
    server.tool('vision_status', 'Check browser connection status', {}, async () => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'status', args: [] }))
    })

    // -- Screenshot --
    server.tool('vision_screenshot', 'Capture a screenshot of the current browser page. Returns the file path — use the Read tool to view it.', {}, async () => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'screenshot', args: [] }))
    })

    // -- Navigate --
    server.tool('vision_navigate', 'Navigate the browser to a URL', {
      url: z.string().describe('URL to navigate to')
    }, async ({ url }: { url: string }) => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'navigate', args: [url] }))
    })

    // -- Click --
    server.tool('vision_click', 'Click an element by CSS selector or x,y coordinates', {
      target: z.string().describe('CSS selector or "x,y" coordinates')
    }, async ({ target }: { target: string }) => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'click', args: [target] }))
    })

    // -- Type --
    server.tool('vision_type', 'Type text into an element', {
      selector: z.string().describe('CSS selector of the input element'),
      text: z.string().describe('Text to type')
    }, async ({ selector, text }: { selector: string; text: string }) => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'type', args: [selector, text] }))
    })

    // -- Eval --
    server.tool('vision_eval', 'Execute JavaScript in the browser and return the result', {
      expression: z.string().describe('JavaScript expression to evaluate')
    }, async ({ expression }: { expression: string }) => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'eval', args: [expression] }))
    })

    // -- Wait --
    server.tool('vision_wait', 'Wait for a CSS selector to appear on the page', {
      selector: z.string().describe('CSS selector to wait for'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default 5000)')
    }, async ({ selector, timeout }: { selector: string; timeout?: number }) => {
      const args = [selector]
      if (timeout) args.push(String(timeout))
      return resultToMcpContent(await visionManager.executeCommand({ command: 'wait', args }))
    })

    // -- HTML --
    server.tool('vision_html', 'Get the innerHTML of an element', {
      selector: z.string().optional().describe('CSS selector (default: body)')
    }, async ({ selector }: { selector?: string }) => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'html', args: selector ? [selector] : [] }))
    })

    // -- Text --
    server.tool('vision_text', 'Get the textContent of an element', {
      selector: z.string().optional().describe('CSS selector (default: body)')
    }, async ({ selector }: { selector?: string }) => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'text', args: selector ? [selector] : [] }))
    })

    // -- Title --
    server.tool('vision_title', 'Get the page title', {}, async () => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'title', args: [] }))
    })

    // -- URL --
    server.tool('vision_url', 'Get the current page URL', {}, async () => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'url', args: [] }))
    })

    // -- Tabs --
    server.tool('vision_tabs', 'List all open browser tabs', {}, async () => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'tabs', args: [] }))
    })

    // -- Tab --
    server.tool('vision_tab', 'Switch to a browser tab by index', {
      index: z.number().describe('Tab index (0-based)')
    }, async ({ index }: { index: number }) => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'tab', args: [String(index)] }))
    })

    // -- Back --
    server.tool('vision_back', 'Navigate back in browser history', {}, async () => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'back', args: [] }))
    })

    // -- Forward --
    server.tool('vision_forward', 'Navigate forward in browser history', {}, async () => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'forward', args: [] }))
    })

    // -- Reload --
    server.tool('vision_reload', 'Reload the current page', {}, async () => {
      return resultToMcpContent(await visionManager.executeCommand({ command: 'reload', args: [] }))
    })

    // -- Scroll --
    server.tool('vision_scroll', 'Scroll the page', {
      direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction (default: down)'),
      pixels: z.number().optional().describe('Pixels to scroll (default: 400)')
    }, async ({ direction, pixels }: { direction?: string; pixels?: number }) => {
      const args: string[] = []
      if (direction) args.push(direction)
      if (pixels) args.push(String(pixels))
      return resultToMcpContent(await visionManager.executeCommand({ command: 'scroll', args }))
    })

    return server
  }

  return new Promise((resolve, reject) => {
    httpServer = http.createServer(async (req, res) => {
      // CORS headers for cross-origin MCP clients
      res.setHeader('Access-Control-Allow-Origin', '*')
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

    // Listen on 0.0.0.0 so SSH reverse tunnels can route traffic
    httpServer.listen(port, '0.0.0.0', () => {
      mcpPort = port
      logInfo(`[vision-mcp] MCP SSE server listening on 0.0.0.0:${port}`)
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
