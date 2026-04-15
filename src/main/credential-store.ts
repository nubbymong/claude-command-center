/**
 * Credential Store — encrypted credential storage using Electron safeStorage.
 * Extracted from index.ts so credentials can be resolved in the main process
 * without transiting through the renderer.
 */

import { safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { getConfigDir, ensureConfigDir } from './config-manager'

function getCredentialsFile(): string {
  return join(getConfigDir(), 'ssh-credentials.json')
}

export function loadAllCredentials(): Record<string, string> {
  try {
    const file = getCredentialsFile()
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf-8'))
    }
  } catch { /* ignore */ }
  return {}
}

export function saveAllCredentials(creds: Record<string, string>): void {
  try {
    ensureConfigDir()
    writeFileSync(getCredentialsFile(), JSON.stringify(creds))
  } catch { /* ignore */ }
}

/**
 * Load and decrypt a credential by configId.
 * Returns the plaintext password or null if not found/unavailable.
 */
export function loadCredential(configId: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  const creds = loadAllCredentials()
  const encrypted = creds[configId]
  if (!encrypted) return null
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch { return null }
}

/**
 * Encrypt and save a credential.
 */
export function saveCredential(configId: string, password: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  const encrypted = safeStorage.encryptString(password).toString('base64')
  const creds = loadAllCredentials()
  creds[configId] = encrypted
  saveAllCredentials(creds)
  return true
}

/**
 * Delete a credential.
 */
export function deleteCredential(configId: string): boolean {
  const creds = loadAllCredentials()
  delete creds[configId]
  saveAllCredentials(creds)
  return true
}
