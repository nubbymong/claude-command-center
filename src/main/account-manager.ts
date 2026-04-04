/**
 * Account Manager — switch between two Claude Max credential profiles.
 * Stores profiles in CONFIG/accounts.json (via config-manager).
 * Credentials (full .credentials.json content) are stored per-profile.
 * The renderer only sees AccountProfile metadata — never raw tokens.
 */

import { join } from 'path'
import { tmpdir } from 'os'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import { safeStorage } from 'electron'
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

/**
 * Encrypt a string using Electron's safeStorage (OS-level credential store).
 * Falls back to plaintext if encryption is not available.
 */
function encryptField(value: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(value).toString('base64')
    }
  } catch (err) {
    logError(`[account-manager] safeStorage encrypt failed, storing plaintext: ${err}`)
  }
  return value
}

/**
 * Decrypt a string that was encrypted with encryptField().
 * Handles both encrypted ('enc:' prefix) and legacy plaintext values.
 */
function decryptField(value: string): string {
  if (!value.startsWith('enc:')) return value // plaintext or legacy
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
    }
    logError('[account-manager] safeStorage not available to decrypt credential')
  } catch (err) {
    logError(`[account-manager] safeStorage decrypt failed: ${err}`)
  }
  return '' // can't decrypt — return empty rather than ciphertext
}

/**
 * Encrypt OAuth tokens inside a credentials object before saving.
 */
function encryptCredentials(creds: any): any {
  if (!creds?.claudeAiOauth) return creds
  const clone = JSON.parse(JSON.stringify(creds))
  const oauth = clone.claudeAiOauth
  if (oauth.accessToken) oauth.accessToken = encryptField(oauth.accessToken)
  if (oauth.refreshToken) oauth.refreshToken = encryptField(oauth.refreshToken)
  return clone
}

/**
 * Decrypt OAuth tokens inside a stored credentials object when loading.
 */
function decryptCredentials(creds: any): any {
  if (!creds?.claudeAiOauth) return creds
  const clone = JSON.parse(JSON.stringify(creds))
  const oauth = clone.claudeAiOauth
  if (oauth.accessToken) oauth.accessToken = decryptField(oauth.accessToken)
  if (oauth.refreshToken) oauth.refreshToken = decryptField(oauth.refreshToken)
  return clone
}

function loadAccountsData(): AccountsData {
  const data = readConfig<AccountsData>('accounts')
  if (!data) return { accounts: [] }
  // Decrypt credentials on load
  for (const account of data.accounts) {
    account.credentials = decryptCredentials(account.credentials)
  }
  return data
}

function saveAccountsData(data: AccountsData): void {
  // Encrypt credentials before writing to disk
  const toSave: AccountsData = {
    ...data,
    accounts: data.accounts.map(a => ({
      ...a,
      credentials: encryptCredentials(a.credentials),
    })),
  }
  writeConfig('accounts', toSave)
}

/**
 * Generate a short fingerprint from the refresh token to distinguish accounts.
 * Uses a SHA-256 hash truncated to 8 hex chars instead of exposing raw token chars.
 */
function tokenFingerprint(creds: any): string {
  const rt = creds?.claudeAiOauth?.refreshToken || ''
  if (rt.length < 4) return '???'
  return createHash('sha256').update(rt).digest('hex').slice(0, 8)
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

  // Deduplicate: ensure only primary and secondary exist (max 2)
  const seen = new Set<string>()
  data.accounts = data.accounts.filter(a => {
    if (seen.has(a.profile.id)) return false
    seen.add(a.profile.id)
    return true
  })

  // Find an available slot, or replace the non-active slot if both are taken
  const usedSlots = new Set(data.accounts.map(a => a.profile.id))
  let slotId: 'primary' | 'secondary'
  if (!usedSlots.has('primary')) {
    slotId = 'primary'
  } else if (!usedSlots.has('secondary')) {
    slotId = 'secondary'
  } else {
    // Both slots full — replace the one that ISN'T lastActiveId
    slotId = data.lastActiveId === 'primary' ? 'secondary' : 'primary'
    data.accounts = data.accounts.filter(a => a.profile.id !== slotId)
  }

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
 * Deduplicates by id (keeps the first occurrence).
 */
export function getAccounts(): AccountProfile[] {
  const data = loadAccountsData()
  const seen = new Set<string>()
  return data.accounts.filter(a => {
    if (seen.has(a.profile.id)) return false
    seen.add(a.profile.id)
    return true
  }).map(a => a.profile)
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
