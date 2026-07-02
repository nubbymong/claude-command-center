/**
 * Legacy Version Manager — install/manage specific Claude CLI versions
 *
 * Each version is installed in <ResourcesDirectory>/claude-versions/<version>/
 * using npm install, then the binary is resolved for PTY spawning.
 */

import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { BrowserWindow } from 'electron'
import { getResourcesDirectory } from './ipc/setup-handlers'
import { logInfo, logError } from './debug-logger'
import { isValidLegacyVersion } from '../shared/legacy-version'

const execFileAsync = promisify(execFile)

// On Windows the npm CLI is a .cmd shim, which execFile (no shell) cannot launch
// directly; resolve it per platform. Mirrors the install path's reliance on the
// shell to map `npm` -> `npm.cmd` (doInstall uses spawn with shell:true).
const NPM_BIN = os.platform() === 'win32' ? 'npm.cmd' : 'npm'

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
  const versionsDir = getVersionsDir()
  // P0.3: `version` flows in from IPC / PTY spawn / cloud-agent dispatch and is
  // used as a filesystem path segment and an npm install coordinate. Reject
  // anything that isn't strict semver before it can traverse or inject.
  if (!isValidLegacyVersion(version)) {
    throw new Error(`Invalid Claude version identifier: ${JSON.stringify(version)}`)
  }
  // Containment backstop: the resolved path must be a DIRECT child of the
  // versions dir, defending any future caller that reaches here without first
  // calling isValidLegacyVersion.
  const dir = path.resolve(versionsDir, version)
  if (path.dirname(dir) !== path.resolve(versionsDir)) {
    throw new Error(`Refusing out-of-bounds version path: ${JSON.stringify(version)}`)
  }
  return dir
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
    // execFile (async) instead of execSync so the network round-trip to the npm
    // registry never blocks the main thread. The handler is already async.
    // shell on win32: Node's CVE-2024-27980 hardening makes execFile of a
    // .cmd shim throw EINVAL without it. Args are literal constants, so the
    // shell adds no injection surface here.
    const { stdout } = await execFileAsync(
      NPM_BIN,
      ['view', '@anthropic-ai/claude-code', 'versions', '--json'],
      { encoding: 'utf-8', timeout: 15000, windowsHide: true, shell: process.platform === 'win32' },
    )

    const versions: string[] = JSON.parse(stdout)
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
  // Invalid versions are simply "not installed" — callers fall back to the
  // system claude binary rather than throwing into the spawn path.
  if (!isValidLegacyVersion(version)) return null
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
  if (!isValidLegacyVersion(version)) {
    logError(`[legacy-version] Refusing to install invalid version id: ${JSON.stringify(version)}`)
    return Promise.resolve({ ok: false, error: `Invalid Claude version: ${version}` })
  }
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
  if (!isValidLegacyVersion(version)) {
    logError(`[legacy-version] Refusing to remove invalid version id: ${JSON.stringify(version)}`)
    return false
  }
  // A destructive recursive delete must only ever act on a version we actually
  // list as installed — never on an arbitrary (even validly-named) path.
  if (!listInstalledVersions().some((v) => v.version === version)) {
    logError(`[legacy-version] Refusing to remove non-installed version: ${version}`)
    return false
  }
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
