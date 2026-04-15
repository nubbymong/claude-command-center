import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { logInfo, logDebug, setVerboseMode } from './debug-logger'
import { getDataDirectory } from './ipc/setup-handlers'

function getDebugDir(): string {
  return path.join(getDataDirectory(), 'debug')
}

let debugModeEnabled = false

function ensureDirs() {
  const debugDir = getDebugDir()
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true })
}

export function isDebugModeEnabled(): boolean {
  return debugModeEnabled
}

export function enableDebugMode(): void {
  if (debugModeEnabled) return
  debugModeEnabled = true
  setVerboseMode(true)
  ensureDirs()
  logInfo('[debug] Verbose logging ENABLED')
}

export function disableDebugMode(): void {
  if (!debugModeEnabled) return
  logInfo('[debug] Verbose logging DISABLED')
  debugModeEnabled = false
  setVerboseMode(false)
}

export function logUserInput(sessionId: string, input: string, source: 'inputBar' | 'terminal'): void {
  if (!debugModeEnabled) return
  const truncated = input.length > 1000 ? input.slice(0, 1000) + '...(truncated)' : input
  logDebug(`[input] [${sessionId}] [${source}] ${truncated}`)
}

export function logPtyOutput(sessionId: string, data: string): void {
  if (!debugModeEnabled) return
  const truncated = data.length > 2000 ? data.slice(0, 2000) + '...(truncated)' : data
  logDebug(`[pty-out] [${sessionId}] (${data.length} bytes) ${truncated}`)
}

// Export getDebugDir for external use
export { getDebugDir }
