/**
 * Legacy Version Manager — install/manage specific Claude CLI versions
 *
 * Each version is installed in <ResourcesDirectory>/claude-versions/<version>/
 * using npm install, then the binary is resolved for PTY spawning.
 */

import { spawn, execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { BrowserWindow } from 'electron'
import { getResourcesDirectory } from './ipc/setup-handlers'
import { logInfo, logError } from './debug-logger'

// Cache fetched versions for 10 minutes
let cachedVersions: string[] | null = null
let cachedVersionsAt = 0
const CACHE_TTL = 10 * 60 * 1000

// Prevent concurrent installs of the same version
const installLocks = new Map<string, Promise<{ ok: boolean; error?: string }>>()

let getWindow: () => BrowserWindow | null = () => null

export function initLegacyVersionManager(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
}

function getVersionsDir(): string {
  return path.join(getResourcesDirectory(), 'claude-versions')
}

function getVersionDir(version: string): string {
  return path.join(getVersionsDir(), version)
}

/**
 * Fetch available versions from npm registry.
 * Caches result for 10 minutes. Returns newest-first.
 */
export async function fetchAvailableVersions(): Promise<string[]> {
  if (cachedVersions && Date.now() - cachedVersionsAt < CACHE_TTL) {
    return cachedVersions
  }

  try {
    const output = execSync('npm view @anthropic-ai/claude-code versions --json', {
      encoding: 'utf-8',
      timeout: 15000,
      windowsHide: true,
    })

    const versions: string[] = JSON.parse(output)
    // Newest first
    cachedVersions = versions.reverse()
    cachedVersionsAt = Date.now()
    return cachedVersions
  } catch (err: any) {
    logError('[legacy-version] Failed to fetch versions:', err?.message || err)
    // Return cache even if stale, or empty
    if (cachedVersions) return cachedVersions
    throw new Error('Failed to fetch versions from npm. Is npm installed and network available?')
  }
}

/**
 * Check if a specific version is installed (binary exists).
 */
export function isVersionInstalled(version: string): boolean {
  const binPath = resolveVersionBinary(version)
  return binPath !== null
}

/**
 * Resolve the binary path for a specific installed version.
 * Returns null if not installed.
 */
export function resolveVersionBinary(version: string): string | null {
  const versionDir = getVersionDir(version)

  if (os.platform() === 'win32') {
    // Check for .cmd wrapper first (npm-installed), then .exe
    for (const bin of ['claude.cmd', 'claude.exe', 'claude.ps1']) {
      const binPath = path.join(versionDir, 'node_modules', '.bin', bin)
      if (fs.existsSync(binPath)) return binPath
    }
  } else {
    const binPath = path.join(versionDir, 'node_modules', '.bin', 'claude')
    if (fs.existsSync(binPath)) return binPath
  }

  return null
}

/**
 * Install a specific version of Claude CLI.
 * Sends progress events to the renderer via IPC.
 */
export function installVersion(version: string): Promise<{ ok: boolean; error?: string }> {
  // Deduplicate concurrent installs of the same version
  const existing = installLocks.get(version)
  if (existing) return existing

  const promise = doInstall(version)
  installLocks.set(version, promise)
  promise.finally(() => installLocks.delete(version))
  return promise
}

async function doInstall(version: string): Promise<{ ok: boolean; error?: string }> {
  const versionDir = getVersionDir(version)

  logInfo(`[legacy-version] Installing @anthropic-ai/claude-code@${version} into ${versionDir}`)
  sendProgress(version, `Installing Claude CLI v${version}...`)

  try {
    // Ensure directory exists with a minimal package.json
    fs.mkdirSync(versionDir, { recursive: true })
    const pkgPath = path.join(versionDir, 'package.json')
    if (!fs.existsSync(pkgPath)) {
      fs.writeFileSync(pkgPath, JSON.stringify({
        name: `claude-cli-${version}`,
        version: '1.0.0',
        private: true,
      }, null, 2))
    }

    // Run npm install
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npm', ['install', `@anthropic-ai/claude-code@${version}`, '--no-save'], {
        cwd: versionDir,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      child.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim()
        if (line) sendProgress(version, line)
      })

      child.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim()
        if (line) sendProgress(version, line)
      })

      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`npm install exited with code ${code}`))
        }
      })

      child.on('error', (err) => {
        reject(err)
      })
    })

    // Verify the binary was installed
    if (!resolveVersionBinary(version)) {
      throw new Error('Binary not found after install — npm install may have failed silently')
    }

    logInfo(`[legacy-version] Successfully installed v${version}`)
    sendProgress(version, `Claude CLI v${version} installed successfully`)
    return { ok: true }
  } catch (err: any) {
    const errorMsg = err?.message || String(err)
    logError(`[legacy-version] Install failed for v${version}:`, errorMsg)
    sendProgress(version, `Install failed: ${errorMsg}`)

    // Clean up partial install
    try {
      fs.rmSync(versionDir, { recursive: true, force: true })
    } catch { /* ignore cleanup errors */ }

    return { ok: false, error: errorMsg }
  }
}

/**
 * Remove an installed version.
 */
export function removeVersion(version: string): boolean {
  const versionDir = getVersionDir(version)
  try {
    fs.rmSync(versionDir, { recursive: true, force: true })
    logInfo(`[legacy-version] Removed v${version}`)
    return true
  } catch (err: any) {
    logError(`[legacy-version] Failed to remove v${version}:`, err?.message || err)
    return false
  }
}

/**
 * List all installed versions with their sizes.
 */
export function listInstalledVersions(): Array<{ version: string; sizeBytes: number }> {
  const versionsDir = getVersionsDir()
  if (!fs.existsSync(versionsDir)) return []

  const results: Array<{ version: string; sizeBytes: number }> = []
  try {
    for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const version = entry.name
      if (!resolveVersionBinary(version)) continue // Skip incomplete installs
      const size = getDirSize(path.join(versionsDir, version))
      results.push({ version, sizeBytes: size })
    }
  } catch { /* ignore */ }

  return results
}

function getDirSize(dirPath: string): number {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        total += getDirSize(fullPath)
      } else {
        try {
          total += fs.statSync(fullPath).size
        } catch { /* skip inaccessible files */ }
      }
    }
  } catch { /* ignore */ }
  return total
}

function sendProgress(version: string, message: string): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('legacyVersion:installProgress', { version, message })
  }
}
