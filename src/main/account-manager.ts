/**
 * Account Manager — switch between two Claude Max credential profiles.
 * Stores profiles in CONFIG/accounts.json (via config-manager).
 * Credentials (full .credentials.json content) are stored per-profile.
 * The renderer only sees AccountProfile metadata — never raw tokens.
 */

import { join } from 'path'
import { tmpdir } from 'os'
import * as https from 'https'
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
 * Fetch the user's email/name from the Anthropic API using the OAuth token.
 * Returns null if the fetch fails (non-blocking, best-effort).
 */
function fetchUserEmail(accessToken: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/userinfo',
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      timeout: 5000,
    }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          resolve(data.email || data.name || null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.end()
  })
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
 * Fetches the user's email from the API for display.
 */
export async function saveCurrentAs(id: string, label: string): Promise<{ ok: boolean; error?: string }> {
  const creds = readClaudeCredentials() as any
  if (!creds) {
    return { ok: false, error: 'No credentials file found at ~/.claude/.credentials.json' }
  }

  // Try to fetch the user's email for display
  let email: string | null = null
  const token = creds?.claudeAiOauth?.accessToken
  if (token) {
    email = await fetchUserEmail(token)
    logInfo(`[account-manager] Fetched email for ${id}: ${email || '(none)'}`)
  }

  const data = loadAccountsData()
  const existing = data.accounts.findIndex(a => a.profile.id === id)

  const stored: StoredAccount = {
    profile: {
      id: id as 'primary' | 'secondary',
      label: email || label,  // Use email if available, fallback to label
      email: email || undefined,
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
