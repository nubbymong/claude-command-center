/**
 * Update Server - runs in dev mode to push update notifications to production clients
 * Uses WebSocket to broadcast when source files change
 */
import { createServer, IncomingMessage } from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { logInfo, logError } from './debug-logger'

const UPDATE_SERVER_PORT = 9847  // Arbitrary port for update notifications
const UPDATE_SERVER_PORT_ALT = 9848  // Fallback port if primary is in use

let wss: WebSocketServer | null = null
let httpServer: ReturnType<typeof createServer> | null = null
let fileWatcher: fs.FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

interface UpdateMessage {
  type: 'update_available' | 'heartbeat' | 'connected'
  timestamp: number
  hash?: string
  changedFiles?: string[]
}

// Compute a quick hash of all source files
function computeSourceHash(srcDir: string): string {
  const hash = crypto.createHash('md5')

  function walkDir(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
            walkDir(fullPath)
          }
        } else if (/\.(ts|tsx|css|html|json)$/.test(entry.name)) {
          try {
            const content = fs.readFileSync(fullPath)
            hash.update(content)
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  walkDir(srcDir)
  return hash.digest('hex')
}

// Broadcast update to all connected clients
function broadcastUpdate(srcDir: string, changedFiles: string[] = []) {
  if (!wss) return

  const hash = computeSourceHash(srcDir)
  const message: UpdateMessage = {
    type: 'update_available',
    timestamp: Date.now(),
    hash,
    changedFiles
  }

  const json = JSON.stringify(message)
  let clientCount = 0

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json)
      clientCount++
    }
  })

  if (clientCount > 0) {
    logInfo(`[update-server] Broadcasted update to ${clientCount} client(s)`)
  }
}

// Watch source directory for changes
function watchSourceDirectory(srcDir: string) {
  if (fileWatcher) {
    fileWatcher.close()
  }

  // Use recursive watching
  try {
    fileWatcher = fs.watch(srcDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return

      // Only care about source files
      if (!/\.(ts|tsx|css|html|json)$/.test(filename)) return

      // Debounce to avoid multiple rapid notifications
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        logInfo(`[update-server] Source change detected: ${filename}`)
        broadcastUpdate(srcDir, [filename])
      }, 500)
    })

    logInfo(`[update-server] Watching source directory: ${srcDir}`)
  } catch (err) {
    logError('[update-server] Failed to watch source directory:', err)
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createServer()
    tester.once('error', () => { resolve(false) })
    tester.listen(port, '0.0.0.0', () => {
      tester.close(() => resolve(true))
    })
  })
}

export async function startUpdateServer(projectRoot: string): Promise<{ port: number } | null> {
  const srcDir = path.join(projectRoot, 'src')

  if (!fs.existsSync(srcDir)) {
    logError('[update-server] Source directory not found:', srcDir)
    return null
  }

  // Find a free port
  let port = UPDATE_SERVER_PORT
  if (!(await isPortFree(port))) {
    logInfo(`[update-server] Port ${port} in use, trying ${UPDATE_SERVER_PORT_ALT}`)
    port = UPDATE_SERVER_PORT_ALT
    if (!(await isPortFree(port))) {
      logInfo('[update-server] Both ports in use, skipping update server (prod likely running)')
      watchSourceDirectory(srcDir)
      return null
    }
  }

  // Create HTTP server for health checks
  httpServer = createServer((req: IncomingMessage, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        clients: wss?.clients.size || 0,
        hash: computeSourceHash(srcDir)
      }))
    } else if (req.url === '/hash') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(computeSourceHash(srcDir))
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  // Create WebSocket server
  wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws) => {
    logInfo('[update-server] Client connected')

    // Send current state on connect
    const hash = computeSourceHash(srcDir)
    const message: UpdateMessage = {
      type: 'connected',
      timestamp: Date.now(),
      hash
    }
    ws.send(JSON.stringify(message))

    ws.on('close', () => {
      logInfo('[update-server] Client disconnected')
    })

    ws.on('error', (err) => {
      logError('[update-server] WebSocket error:', err)
    })
  })

  // Start watching source files
  watchSourceDirectory(srcDir)

  // Start the server
  httpServer.listen(port, '0.0.0.0', () => {
    logInfo(`[update-server] Update server running on port ${port}`)
  })

  // Send heartbeat every 30 seconds to keep connections alive
  setInterval(() => {
    if (!wss) return
    const message: UpdateMessage = {
      type: 'heartbeat',
      timestamp: Date.now()
    }
    const json = JSON.stringify(message)
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json)
      }
    })
  }, 30000)

  return { port }
}

export function stopUpdateServer(): void {
  if (fileWatcher) {
    fileWatcher.close()
    fileWatcher = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (wss) {
    wss.close()
    wss = null
  }
  if (httpServer) {
    httpServer.close()
    httpServer = null
  }
  logInfo('[update-server] Update server stopped')
}

export function getConnectedClients(): number {
  return wss?.clients.size || 0
}
