/**
 * Account Manager — switch between two Claude Max credential profiles.
 * Stores profiles in CONFIG/accounts.json (via config-manager).
 * Credentials (full .credentials.json content) are stored per-profile.
 * The renderer only sees AccountProfile metadata — never raw tokens.
 */

import { join } from 'path'
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
}

function getClaudeCredentialsPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return join(home, '.claude', '.credentials.json')
}

function getUsageCachePath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return join(home, '.claude', 'usage_cache.json')
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
 * Return profile metadata for all saved accounts (no credentials).
 */
export function getAccounts(): AccountProfile[] {
  const data = loadAccountsData()
  return data.accounts.map(a => a.profile)
}

/**
 * Determine which stored profile matches the current credentials file.
 * Compares by JSON equality of the credentials content.
 */
export function getActiveAccount(): AccountProfile | null {
  const currentCreds = readClaudeCredentials()
  if (!currentCreds) return null

  const currentJson = JSON.stringify(currentCreds)
  const data = loadAccountsData()

  for (const stored of data.accounts) {
    if (JSON.stringify(stored.credentials) === currentJson) {
      return stored.profile
    }
  }
  return null
}

/**
 * Switch to a stored account by gracefully exiting all running sessions/agents,
 * then overwriting ~/.claude/.credentials.json and clearing caches.
 * Uses graceful exit (sends /exit) so Claude CLI can flush .claude.json cleanly.
 */
export async function switchAccount(id: string): Promise<{ ok: boolean; error?: string }> {
  const data = loadAccountsData()
  const account = data.accounts.find(a => a.profile.id === id)
  if (!account) {
    return { ok: false, error: `Account "${id}" not found. Save it first.` }
  }

  // Gracefully shut down everything running under the old account
  logInfo(`[account-manager] Gracefully exiting all sessions before account switch...`)
  cancelAllRuns()         // Cancel team pipeline runs (which also cancels their agents)
  killAllAgents()         // Kill cloud agents (headless, no .claude.json risk)
  await gracefulExitAllPty(5000)  // Send /exit to PTYs, wait up to 5s, then force-kill

  if (!writeClaudeCredentials(account.credentials)) {
    return { ok: false, error: 'Failed to write credentials file.' }
  }

  // Clear usage cache so Claude re-reads identity
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
export function saveCurrentAs(id: string, label: string): { ok: boolean; error?: string } {
  const creds = readClaudeCredentials()
  if (!creds) {
    return { ok: false, error: 'No credentials file found at ~/.claude/.credentials.json' }
  }

  const data = loadAccountsData()
  const existing = data.accounts.findIndex(a => a.profile.id === id)

  const stored: StoredAccount = {
    profile: { id: id as 'primary' | 'secondary', label, savedAt: Date.now() },
    credentials: creds,
  }

  if (existing >= 0) {
    data.accounts[existing] = stored
  } else {
    data.accounts.push(stored)
  }

  saveAccountsData(data)
  logInfo(`[account-manager] Saved current credentials as: ${label} (${id})`)
  return { ok: true }
}
