#!/usr/bin/env node
/**
 * Standalone Update Server
 * Run this to push update notifications to production Claude Conductor apps
 *
 * Usage: node scripts/update-server.js
 */

const http = require('http')
const { WebSocketServer, WebSocket } = require('ws')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PORT = 9847
const PROJECT_ROOT = path.resolve(__dirname, '..')
const SRC_DIR = path.join(PROJECT_ROOT, 'src')

console.log('Claude Conductor Update Server')
console.log('==============================')
console.log(`Project root: ${PROJECT_ROOT}`)
console.log(`Watching: ${SRC_DIR}`)
console.log('')

// Compute hash of all source files
function computeSourceHash() {
  const hash = crypto.createHash('md5')

  function walkDir(dir) {
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

  walkDir(SRC_DIR)
  return hash.digest('hex')
}

// Create HTTP server for health checks
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      clients: wss.clients.size,
      hash: computeSourceHash()
    }))
  } else if (req.url === '/hash') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(computeSourceHash())
  } else {
    res.writeHead(404)
    res.end()
  }
})

// Create WebSocket server
const wss = new WebSocketServer({ server: httpServer })

wss.on('connection', (ws) => {
  console.log(`[${new Date().toLocaleTimeString()}] Client connected (total: ${wss.clients.size})`)

  // Send current state on connect
  const hash = computeSourceHash()
  ws.send(JSON.stringify({
    type: 'connected',
    timestamp: Date.now(),
    hash
  }))

  ws.on('close', () => {
    console.log(`[${new Date().toLocaleTimeString()}] Client disconnected (total: ${wss.clients.size})`)
  })
})

// Broadcast update to all clients
function broadcastUpdate(changedFile) {
  const hash = computeSourceHash()
  const message = JSON.stringify({
    type: 'update_available',
    timestamp: Date.now(),
    hash,
    changedFiles: changedFile ? [changedFile] : []
  })

  let count = 0
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
      count++
    }
  })

  if (count > 0) {
    console.log(`[${new Date().toLocaleTimeString()}] Broadcasted update to ${count} client(s)`)
  }
}

// Watch for file changes
let debounceTimer = null
fs.watch(SRC_DIR, { recursive: true }, (eventType, filename) => {
  if (!filename) return
  if (!/\.(ts|tsx|css|html|json)$/.test(filename)) return

  // Debounce
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    console.log(`[${new Date().toLocaleTimeString()}] Change detected: ${filename}`)
    broadcastUpdate(filename)
  }, 500)
})

// Start server
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Update server running on port ${PORT}`)
  console.log(`Production apps will connect to ws://localhost:${PORT}`)
  console.log('')
  console.log('Waiting for clients...')
  console.log('(Press Ctrl+C to stop)')
  console.log('')
})

// Heartbeat every 30 seconds
setInterval(() => {
  const message = JSON.stringify({
    type: 'heartbeat',
    timestamp: Date.now()
  })
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
    }
  })
}, 30000)
