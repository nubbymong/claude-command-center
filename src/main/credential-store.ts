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
import { readFileSync, existsSync } from 'fs'
import { getConfigDir, ensureConfigDir } from './config-manager'
import { atomicWriteSecure } from './account-profiles'

function getCredentialsFile(): string {
  return join(getConfigDir(), 'ssh-credentials.json')
}

/**
 * The credentials file, read. `null` means the file EXISTS but could not be
 * read or parsed (a scanner holding it, a permissions hiccup, a torn write,
 * corruption) -- which is NOT the same as "no credentials yet". The writers
 * below refuse to touch a file they could not read: before the ADR-009 pass on
 * #386 an unreadable file read as `{}` and the next save or delete wrote that
 * `{}` back, destroying every stored SSH password, sudo password and command
 * secret in one go (the class the beta.16 config hardening closed elsewhere).
 */
export function readCredentialsFile(): Record<string, string> | null {
  const file = getCredentialsFile()
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, string>
  } catch {
    return null
  }
}

/** Every stored credential, or `{}` when there are none or the file is unreadable (read-only callers). */
export function loadAllCredentials(): Record<string, string> {
  return readCredentialsFile() ?? {}
}

/** Write the whole file; false when the write failed. */
export function saveAllCredentials(creds: Record<string, string>): boolean {
  try {
    ensureConfigDir()
    // ssh-credentials.json holds the per-config safeStorage ciphertext. Write it
    // owner-only through the shared atomic helper (exclusive create + rename), not
    // a bare writeFileSync: the old shape landed 0644 and followed a link planted
    // at the path — the world-readable / link-redirect class the pwfw/58r3
    // hardening closed for the other credential writers.
    atomicWriteSecure(getCredentialsFile(), JSON.stringify(creds), 0o600)
    return true
  } catch {
    return false
  }
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
 * Encrypt and save a credential. False when encryption is unavailable, when the
 * existing file could not be read (never write over what we could not read),
 * or when the write failed -- the caller must not claim the secret is stored.
 */
export function saveCredential(configId: string, password: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  const creds = readCredentialsFile()
  if (creds === null) return false
  const encrypted = safeStorage.encryptString(password).toString('base64')
  creds[configId] = encrypted
  return saveAllCredentials(creds)
}

/**
 * Delete a credential. False when the file could not be read (nothing is
 * written) or the write failed; true when the key is gone (or was never there).
 */
export function deleteCredential(configId: string): boolean {
  const creds = readCredentialsFile()
  if (creds === null) return false
  if (!(configId in creds)) return true
  delete creds[configId]
  return saveAllCredentials(creds)
}
