/**
 * Session State Persistence
 * Saves and restores open sessions across app restarts.
 * Now stores in ResourcesDirectory/CONFIG/ for portability.
 */

import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { getConfigDir, ensureConfigDir, migrateConfigToProviderShape } from './config-manager'
import { logInfo } from './debug-logger'
import type { SavedSession, SessionState } from '../shared/types'

export type { SavedSession, SessionState }

// Legacy top-level Claude fields that get migrated into claudeOptions.
// Mirrors CLAUDE_FIELDS in config-manager.ts for the SavedSession case.
const LEGACY_CLAUDE_FIELDS = ['model', 'effortLevel', 'legacyVersion', 'disableAutoMemory', 'flickerFree', 'powershellTool', 'agentIds'] as const

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

    if (!Array.isArray(state.sessions)) {
      logInfo('[session-state] No sessions array in state; skipping migration')
      return state
    }

    // v1.5: back-fill provider field + claudeOptions on each SavedSession.
    // Strips legacy top-level Claude fields; persists back only if something changed.
    let dirty = false
    const migratedSessions = state.sessions.map((s: any) => {
      const out = migrateConfigToProviderShape(s)
      if (!s.provider || LEGACY_CLAUDE_FIELDS.some(f => f in s)) {
        dirty = true
      }
      return out
    })
    if (dirty) {
      state.sessions = migratedSessions
      writeFileSync(getSessionStateFile(), JSON.stringify(state, null, 2))
      logInfo('[session-state] Migrated sessions to provider shape')
    }

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
