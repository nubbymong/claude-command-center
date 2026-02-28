/**
 * Account Manager — switch between two Claude Max credential profiles.
 * Stores profiles in CONFIG/accounts.json (via config-manager).
 * Credentials (full .credentials.json content) are stored per-profile.
 * The renderer only sees AccountProfile metadata — never raw tokens.
 */

import { join } from 'path'
import { tmpdir } from 'os'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { readConfig, writeConfig } from './config-manager'
import { logInfo, logError } from './debug-logger'
import { killAllAgents } from './cloud-agent-manager'
import { gracefulExitAllPty } from './pty-manager'
import { cancelAllRuns } from './team-manager'
import type { AccountProfile } from '../shared/types'

interface StoredAccount {
  profile: AccountProfile
  credentials: unknown // full .credentials.json content
}

interface AccountsData {
  accounts: StoredAccount[]
  lastActiveId?: string // persisted across restarts
}

function getClaudeCredentialsPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return join(home, '.claude', '.credentials.json')
}

function getUsageCachePath(): string {
  return join(tmpdir(), 'claude-command-center-usage-cache.json')
}

function readClaudeCredentials(): unknown | null {
  try {
    const p = getClaudeCredentialsPath()
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

function writeClaudeCredentials(data: unknown): boolean {
  try {
    writeFileSync(getClaudeCredentialsPath(), JSON.stringify(data, null, 2), 'utf-8')
    return true
  } catch (err) {
    logError(`[account-manager] Failed to write credentials: ${err}`)
    return false
  }
}

function loadAccountsData(): AccountsData {
  const data = readConfig<AccountsData>('accounts')
  return data || { accounts: [] }
}

function saveAccountsData(data: AccountsData): void {
  writeConfig('accounts', data)
}

/**
 * Generate a short fingerprint from the refresh token to distinguish accounts.
 * Returns something like "...x7Kf" — last 4 chars.
 */
function tokenFingerprint(creds: any): string {
  const rt = creds?.claudeAiOauth?.refreshToken || ''
  if (rt.length < 4) return '???'
  return '...' + rt.slice(-4)
}

/**
 * Auto-detect the current account on startup.
 * If no accounts are saved yet, save the current credentials as Primary.
 * If credentials don't match any saved account, save as the next available slot.
 * Runs once at app startup (fire-and-forget, non-blocking).
 */
export async function initAccounts(): Promise<void> {
  const creds = readClaudeCredentials() as any
  if (!creds?.claudeAiOauth?.refreshToken) {
    logInfo('[account-manager] No credentials found, skipping auto-detect')
    return
  }

  const data = loadAccountsData()
  const currentRefresh = creds.claudeAiOauth.refreshToken

  // Check if current credentials already match a saved account
  const existingMatch = data.accounts.find(a => {
    const stored = a.credentials as any
    return stored?.claudeAiOauth?.refreshToken === currentRefresh
  })

  if (existingMatch) {
    // Update lastActiveId to match
    if (data.lastActiveId !== existingMatch.profile.id) {
      data.lastActiveId = existingMatch.profile.id
      saveAccountsData(data)
    }
    logInfo(`[account-manager] Auto-detected active account: ${existingMatch.profile.id}`)
    return
  }

  // New credentials — save into the first available slot
  const usedSlots = new Set(data.accounts.map(a => a.profile.id))
  const slotId: 'primary' | 'secondary' = usedSlots.has('primary') ? 'secondary' : 'primary'

  const fp = tokenFingerprint(creds)
  const sub = creds.claudeAiOauth?.subscriptionType || 'unknown'

  const stored: StoredAccount = {
    profile: {
      id: slotId,
      label: `${sub} ${fp}`,
      savedAt: Date.now(),
    },
    credentials: creds,
  }

  data.accounts.push(stored)
  data.lastActiveId = slotId
  saveAccountsData(data)
  logInfo(`[account-manager] Auto-saved current account as ${slotId}: ${sub} ${fp}`)
}

/**
 * Return profile metadata for all saved accounts (no credentials).
 */
export function getAccounts(): AccountProfile[] {
  const data = loadAccountsData()
  return data.accounts.map(a => a.profile)
}

/**
 * Determine which stored profile is active.
 * Uses persisted lastActiveId first (survives restarts).
 * Falls back to refreshToken matching if lastActiveId is missing.
 */
export function getActiveAccount(): AccountProfile | null {
  const data = loadAccountsData()
  if (data.accounts.length === 0) return null

  // Primary: use persisted last-switched-to ID
  if (data.lastActiveId) {
    const match = data.accounts.find(a => a.profile.id === data.lastActiveId)
    if (match) return match.profile
  }

  // Fallback: match by refreshToken
  const currentCreds = readClaudeCredentials() as any
  if (!currentCreds?.claudeAiOauth?.refreshToken) return null

  const currentRefresh = currentCreds.claudeAiOauth.refreshToken
  for (const stored of data.accounts) {
    const storedCreds = stored.credentials as any
    if (storedCreds?.claudeAiOauth?.refreshToken === currentRefresh) {
      return stored.profile
    }
  }
  return null
}

/**
 * Switch to a stored account by gracefully exiting all running sessions/agents,
 * then overwriting ~/.claude/.credentials.json and clearing caches.
 */
export async function switchAccount(id: string): Promise<{ ok: boolean; error?: string }> {
  const data = loadAccountsData()
  const account = data.accounts.find(a => a.profile.id === id)
  if (!account) {
    return { ok: false, error: `Account "${id}" not found. Save it first.` }
  }

  // Gracefully shut down everything running under the old account
  logInfo(`[account-manager] Gracefully exiting all sessions before account switch...`)
  cancelAllRuns()
  killAllAgents()
  await gracefulExitAllPty(5000)

  if (!writeClaudeCredentials(account.credentials)) {
    return { ok: false, error: 'Failed to write credentials file.' }
  }

  // Persist which account is now active
  data.lastActiveId = id
  saveAccountsData(data)

  // Clear usage cache so statusline re-reads identity
  try {
    const cachePath = getUsageCachePath()
    if (existsSync(cachePath)) unlinkSync(cachePath)
  } catch { /* ignore */ }

  logInfo(`[account-manager] Switched to account: ${account.profile.label} (${id})`)
  return { ok: true }
}

/**
 * Snapshot the current ~/.claude/.credentials.json as a named profile.
 */
export async function saveCurrentAs(id: string, label: string): Promise<{ ok: boolean; error?: string }> {
  const creds = readClaudeCredentials() as any
  if (!creds) {
    return { ok: false, error: 'No credentials file found at ~/.claude/.credentials.json' }
  }

  const data = loadAccountsData()
  const existing = data.accounts.findIndex(a => a.profile.id === id)

  // Use provided label, or generate from token fingerprint
  const fp = tokenFingerprint(creds)
  const sub = creds.claudeAiOauth?.subscriptionType || 'unknown'
  const displayLabel = (label && label !== 'Primary' && label !== 'Secondary')
    ? label
    : `${sub} ${fp}`

  const stored: StoredAccount = {
    profile: {
      id: id as 'primary' | 'secondary',
      label: displayLabel,
      savedAt: Date.now(),
    },
    credentials: creds,
  }

  if (existing >= 0) {
    data.accounts[existing] = stored
  } else {
    data.accounts.push(stored)
  }

  // Also mark this as the active account
  data.lastActiveId = id
  saveAccountsData(data)

  logInfo(`[account-manager] Saved current credentials as: ${stored.profile.label} (${id})`)
  return { ok: true }
}

/**
 * Rename an account's display label.
 */
export function renameAccount(id: string, newLabel: string): { ok: boolean; error?: string } {
  const data = loadAccountsData()
  const account = data.accounts.find(a => a.profile.id === id)
  if (!account) return { ok: false, error: `Account "${id}" not found.` }

  account.profile.label = newLabel
  saveAccountsData(data)
  logInfo(`[account-manager] Renamed account ${id} to: ${newLabel}`)
  return { ok: true }
}
