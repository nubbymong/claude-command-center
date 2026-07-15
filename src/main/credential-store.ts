/**
 * Credential Store — encrypted credential storage using Electron safeStorage.
 * Extracted from index.ts so credentials can be resolved in the main process
 * without transiting through the renderer.
 *
 * THREAT MODEL (P3.1)
 * -------------------
 * Secret VALUES (SSH / sudo passwords) are encrypted at rest with Electron
 * `safeStorage`, backed by the OS keychain (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux). The ciphertext is base64-encoded and stored as the VALUE
 * of each entry in `ssh-credentials.json`.
 *
 * METADATA is intentionally plaintext: the JSON object's KEYS are CCC `configId`
 * strings — opaque, randomly-generated internal identifiers. A reader of the
 * file on disk learns only WHICH configs have a stored credential, never the
 * secret. configIds are not secrets and map to nothing outside this install, and
 * without the OS keychain entry the encrypted values cannot be decrypted.
 *
 * Full-payload (whole-file) encryption is deliberately NOT implemented: it would
 * force CCC to manage its own master key — re-introducing the key-storage problem
 * `safeStorage` exists to solve — to hide only the low-value set of configIds, in
 * a file already inside the user's OS-permission-protected config dir. Encrypting
 * the metadata is YAGNI for non-sensitive config IDs.
 *
 * Residual risk: an attacker with BOTH the file AND a live session of the same OS
 * user (where safeStorage can decrypt) could read secrets — but that attacker
 * already owns the user's session and could read the same secrets from process
 * memory or the live SSH connection regardless. safeStorage's guarantee is
 * at-rest / cross-user protection, which this design preserves.
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
