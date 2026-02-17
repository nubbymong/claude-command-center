/**
 * Update Client - runs in production mode to receive push notifications from dev server
 * Connects via WebSocket to receive real-time update notifications
 */
import { BrowserWindow } from 'electron'
import WebSocket from 'ws'
import { logInfo, logError } from './debug-logger'
import { readRegistry, writeRegistry } from './registry'

const DEFAULT_UPDATE_SERVER = 'ws://localhost:9847'
const RECONNECT_BASE = 5000       // Initial reconnect delay (5s)
const RECONNECT_MAX = 120000      // Max reconnect delay (2 minutes)
const RECONNECT_BACKOFF = 2       // Exponential backoff multiplier

interface UpdateMessage {
  type: 'update_available' | 'heartbeat' | 'connected'
  timestamp: number
  hash?: string
  version?: string
  changedFiles?: string[]
  installerPath?: string
}

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let windowGetter: (() => BrowserWindow | null) | null = null
let currentServerHash: string | null = null
let currentServerVersion: string | null = null
let currentInstallerPath: string | null = null
let localHash: string | null = null
let isConnected = false
let consecutiveFailures = 0
let reconnectDelay = RECONNECT_BASE
let hasLoggedDisconnect = false    // Suppress repeated disconnect logs

// Read update server URL from registry
function getUpdateServerUrl(): string {
  return readRegistry('UpdateServer') || DEFAULT_UPDATE_SERVER
}

// Set update server URL in registry
export function setUpdateServerUrl(url: string): boolean {
  if (process.platform !== 'win32') return false
  const ok = writeRegistry('UpdateServer', url)
  if (ok) {
    logInfo(`[update-client] Set update server URL: ${url}`)
    // Reconnect to new server
    disconnect()
    connect()
  } else {
    logError('[update-client] Failed to set update server URL')
  }
  return ok
}

// Get the local hash (from the installed app's source-hash.json)
function getLocalHash(): string | null {
  // This would be stored during install/update
  return localHash
}

// Set the local hash (called when app updates)
export function setLocalHash(hash: string): void {
  localHash = hash
  // Check if we're now up to date
  if (currentServerHash && localHash === currentServerHash) {
    notifyRenderer(false)
  }
}

// Notify renderer of update status
function notifyRenderer(updateAvailable: boolean) {
  const win = windowGetter?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('update:available', updateAvailable, currentServerVersion)
    win.webContents.send('update:serverConnected', isConnected)
  }
}

// Handle incoming message from server
function handleMessage(data: string) {
  try {
    const message: UpdateMessage = JSON.parse(data)

    switch (message.type) {
      case 'connected':
        logInfo(`[update-client] Connected to update server, server hash: ${message.hash}`)
        currentServerHash = message.hash || null
        // Check if we have an update
        if (localHash && currentServerHash && localHash !== currentServerHash) {
          logInfo('[update-client] Update available (hash mismatch)')
          notifyRenderer(true)
        }
        break

      case 'update_available':
        logInfo(`[update-client] Update pushed from server: v${message.version || '?'}, files: ${message.changedFiles?.join(', ')}`)
        currentServerHash = message.hash || null
        currentServerVersion = message.version || null
        currentInstallerPath = message.installerPath || null
        // Always notify on push - this is the key feature
        notifyRenderer(true)
        break

      case 'heartbeat':
        // Just keep-alive, no action needed
        break
    }
  } catch (err) {
    logError('[update-client] Failed to parse message:', err)
  }
}

// Connect to update server
function connect() {
  if (ws) {
    ws.close()
    ws = null
  }

  const serverUrl = getUpdateServerUrl()

  // Only log first attempt and every 50th retry to avoid log spam
  if (consecutiveFailures === 0) {
    logInfo(`[update-client] Connecting to update server: ${serverUrl}`)
  }

  try {
    ws = new WebSocket(serverUrl)

    ws.on('open', () => {
      logInfo('[update-client] Connected to update server')
      isConnected = true
      consecutiveFailures = 0
      reconnectDelay = RECONNECT_BASE
      hasLoggedDisconnect = false
      notifyRenderer(false)  // Connected but no update yet
    })

    ws.on('message', (data) => {
      handleMessage(data.toString())
    })

    ws.on('close', () => {
      const wasConnected = isConnected
      isConnected = false
      ws = null
      // Only log if we were actually connected (not on failed connection attempts)
      if (wasConnected) {
        logInfo('[update-client] Disconnected from update server')
        hasLoggedDisconnect = false  // Reset so next failure cycle logs once
        consecutiveFailures = 0
        reconnectDelay = RECONNECT_BASE
      }
      scheduleReconnect()
    })

    ws.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ECONNREFUSED') {
        logError('[update-client] WebSocket error:', err)
      } else if (!hasLoggedDisconnect) {
        logInfo('[update-client] Update server not running (will retry with backoff)')
        hasLoggedDisconnect = true
      }
      isConnected = false
      consecutiveFailures++
      // Exponential backoff: 5s → 10s → 20s → 40s → 80s → 120s (cap)
      reconnectDelay = Math.min(RECONNECT_BASE * Math.pow(RECONNECT_BACKOFF, consecutiveFailures), RECONNECT_MAX)
    })
  } catch (err) {
    logError('[update-client] Failed to connect:', err)
    isConnected = false
    consecutiveFailures++
    reconnectDelay = Math.min(RECONNECT_BASE * Math.pow(RECONNECT_BACKOFF, consecutiveFailures), RECONNECT_MAX)
  }
}

// Disconnect from server
function disconnect() {
  if (ws) {
    ws.close()
    ws = null
  }
  isConnected = false
}

// Schedule next reconnect attempt with current backoff delay
function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect()
    }
  }, reconnectDelay)
}

// Start the update client
export function startUpdateClient(getWindow: () => BrowserWindow | null, initialHash?: string): void {
  windowGetter = getWindow
  localHash = initialHash || null

  // Initial connection
  connect()

  logInfo('[update-client] Update client started')
}

// Stop the update client
export function stopUpdateClient(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  disconnect()
  consecutiveFailures = 0
  reconnectDelay = RECONNECT_BASE
  hasLoggedDisconnect = false
  logInfo('[update-client] Update client stopped')
}

// Check if connected to server
export function isServerConnected(): boolean {
  return isConnected
}

// Get current server hash
export function getServerHash(): string | null {
  return currentServerHash
}

// Get installer path from last update notification
export function getInstallerPath(): string | null {
  return currentInstallerPath
}
