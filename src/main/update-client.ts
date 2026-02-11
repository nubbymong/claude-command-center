/**
 * Update Client - runs in production mode to receive push notifications from dev server
 * Connects via WebSocket to receive real-time update notifications
 */
import { BrowserWindow } from 'electron'
import WebSocket from 'ws'
import { execSync } from 'child_process'
import { logInfo, logError } from './debug-logger'

const DEFAULT_UPDATE_SERVER = 'ws://localhost:9847'
const RECONNECT_INTERVAL = 5000  // Reconnect every 5 seconds if disconnected

interface UpdateMessage {
  type: 'update_available' | 'heartbeat' | 'connected'
  timestamp: number
  hash?: string
  version?: string
  changedFiles?: string[]
  installerPath?: string
}

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setInterval> | null = null
let windowGetter: (() => BrowserWindow | null) | null = null
let currentServerHash: string | null = null
let currentServerVersion: string | null = null
let currentInstallerPath: string | null = null
let localHash: string | null = null
let isConnected = false

// Read update server URL from registry
function getUpdateServerUrl(): string {
  if (process.platform !== 'win32') return DEFAULT_UPDATE_SERVER
  try {
    const result = execSync(
      'reg query "HKCU\\Software\\Claude Conductor" /v UpdateServer 2>nul',
      { encoding: 'utf-8' }
    )
    const match = result.match(/UpdateServer\s+REG_SZ\s+(.+)/)
    if (match && match[1].trim()) {
      return match[1].trim()
    }
  } catch { /* use default */ }
  return DEFAULT_UPDATE_SERVER
}

// Set update server URL in registry
export function setUpdateServerUrl(url: string): boolean {
  if (process.platform !== 'win32') return false
  try {
    execSync(
      `reg add "HKCU\\Software\\Claude Conductor" /v UpdateServer /t REG_SZ /d "${url}" /f`,
      { encoding: 'utf-8' }
    )
    logInfo(`[update-client] Set update server URL: ${url}`)
    // Reconnect to new server
    disconnect()
    connect()
    return true
  } catch (err) {
    logError('[update-client] Failed to set update server URL:', err)
    return false
  }
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
  logInfo(`[update-client] Connecting to update server: ${serverUrl}`)

  try {
    ws = new WebSocket(serverUrl)

    ws.on('open', () => {
      logInfo('[update-client] Connected to update server')
      isConnected = true
      notifyRenderer(false)  // Connected but no update yet
    })

    ws.on('message', (data) => {
      handleMessage(data.toString())
    })

    ws.on('close', () => {
      logInfo('[update-client] Disconnected from update server')
      isConnected = false
      ws = null
      // Will reconnect via interval
    })

    ws.on('error', (err) => {
      // Connection refused is expected if dev server isn't running
      if ((err as NodeJS.ErrnoException).code !== 'ECONNREFUSED') {
        logError('[update-client] WebSocket error:', err)
      }
      isConnected = false
    })
  } catch (err) {
    logError('[update-client] Failed to connect:', err)
    isConnected = false
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

// Start the update client
export function startUpdateClient(getWindow: () => BrowserWindow | null, initialHash?: string): void {
  windowGetter = getWindow
  localHash = initialHash || null

  // Initial connection
  connect()

  // Reconnect periodically if disconnected
  reconnectTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect()
    }
  }, RECONNECT_INTERVAL)

  logInfo('[update-client] Update client started')
}

// Stop the update client
export function stopUpdateClient(): void {
  if (reconnectTimer) {
    clearInterval(reconnectTimer)
    reconnectTimer = null
  }
  disconnect()
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
