/**
 * Session State Persistence
 * Saves and restores open sessions across app restarts.
 * Now stores in ResourcesDirectory/CONFIG/ for portability.
 */

import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { getConfigDir, ensureConfigDir } from './config-manager'
import { logInfo } from './debug-logger'

export interface SavedSession {
  id: string
  configId?: string
  label: string
  workingDirectory: string
  model: string
  color: string
  sessionType: 'local' | 'ssh'
  shellOnly?: boolean
  partnerTerminalPath?: string
  partnerElevated?: boolean
  sshConfig?: {
    host: string
    port: number
    username: string
    remotePath: string
    hasPassword?: boolean
    postCommand?: string
    hasSudoPassword?: boolean
    startClaudeAfter?: boolean
    dockerContainer?: string
  }
}

export interface SessionState {
  sessions: SavedSession[]
  activeSessionId: string | null
  savedAt: number
}

// Lazy getter — can't call getConfigDir() at module load time
function getSessionStateFile(): string {
  return join(getConfigDir(), 'session-state.json')
}

/**
 * Save current session state to disk
 */
export function saveSessionState(state: SessionState): boolean {
  try {
    ensureConfigDir()
    writeFileSync(getSessionStateFile(), JSON.stringify(state, null, 2))
    logInfo(`[session-state] Saved ${state.sessions.length} sessions`)
    return true
  } catch (err) {
    console.error('[session-state] Failed to save:', err)
    return false
  }
}

/**
 * Load saved session state from disk
 */
export function loadSessionState(): SessionState | null {
  try {
    const file = getSessionStateFile()
    if (!existsSync(file)) {
      return null
    }
    const data = readFileSync(file, 'utf-8')
    const state = JSON.parse(data) as SessionState
    logInfo(`[session-state] Loaded ${state.sessions.length} sessions from ${new Date(state.savedAt).toLocaleString()}`)
    return state
  } catch (err) {
    console.error('[session-state] Failed to load:', err)
    return null
  }
}

/**
 * Clear saved session state (called after successful restore)
 */
export function clearSessionState(): boolean {
  try {
    const file = getSessionStateFile()
    if (existsSync(file)) {
      unlinkSync(file)
      logInfo('[session-state] Cleared saved state')
    }
    return true
  } catch (err) {
    console.error('[session-state] Failed to clear:', err)
    return false
  }
}

/**
 * Check if there's a saved session state to restore
 */
export function hasSavedSessionState(): boolean {
  return existsSync(getSessionStateFile())
}
