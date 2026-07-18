import { BrowserWindow, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { logInfo, logError } from './debug-logger'
import { readRegistry, writeRegistry } from './registry'

const IS_PACKAGED = app.isPackaged
const HASH_FILE = path.join(app.getPath('userData'), 'source-hash.json')

// Read source path from Windows registry (set during install or manually)
function getSourcePathFromRegistry(): string | null {
  return readRegistry('SourcePath') || null
}

// Read data directory from Windows registry
export function getDataDirectoryFromRegistry(): string | null {
  return readRegistry('DataDirectory') || null
}

// Read install path from Windows registry
export function getInstallPath(): string {
  return readRegistry('InstallPath') || ''
}

// Set source path in registry (Windows) or config file (macOS/Linux)
export function setSourcePathInRegistry(sourcePath: string): boolean {
  const ok = writeRegistry('SourcePath', sourcePath)
  if (ok) {
    logInfo(`[update-watcher] Set source path in registry: ${sourcePath}`)
    // Trigger re-initialization of watcher
    if (windowGetter) {
      reinitializeWatcher()
    }
  } else {
    logError('[update-watcher] Failed to set source path in registry')
  }
  return ok
}

// Get project root DYNAMICALLY - always re-read from registry
export function getProjectRootPath(): string {
  if (!IS_PACKAGED) {
    // Dev mode: out/main -> project root
    const appPath = app.getAppPath()
    if (appPath.includes('out')) {
      return path.resolve(appPath, '..', '..')
    }
    return appPath
  }

  // Production/Installed mode: Check registry for source path
  const registryPath = getSourcePathFromRegistry()
  if (registryPath && fs.existsSync(registryPath)) {
    return registryPath
  }

  // Fallback: check for a stored project path in userData
  const configFile = path.join(app.getPath('userData'), 'source-path.txt')
  if (fs.existsSync(configFile)) {
    const storedPath = fs.readFileSync(configFile, 'utf-8').trim()
    if (fs.existsSync(storedPath)) {
      return storedPath
    }
  }

  return ''
}

export function isPackagedApp(): boolean {
  return IS_PACKAGED
}

export function hasSourcePath(): boolean {
  const projectRoot = getProjectRootPath()
  if (!projectRoot) return false
  const srcDir = path.join(projectRoot, 'src')
  return fs.existsSync(srcDir)
}

interface SourceHashes {
  timestamp: number
  hashes: Record<string, string>
}

let currentHashes: SourceHashes | null = null
let watchInterval: ReturnType<typeof setInterval> | null = null
let updateAvailable = false
let lastSourceConfigured: boolean | null = null
let windowGetter: (() => BrowserWindow | null) | null = null
let watcherInitialized = false

function hashFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath)
    return crypto.createHash('md5').update(content).digest('hex')
  } catch {
    return ''
  }
}

function getAllSourceFiles(dir: string, files: string[] = []): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          getAllSourceFiles(fullPath, files)
        }
      } else if (/\.(ts|tsx|css|html|json)$/.test(entry.name)) {
        files.push(fullPath)
      }
    }
  } catch { /* ignore */ }
  return files
}

// Yield to the event loop so a long sweep can never freeze the main thread.
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function getAllSourceFilesAsync(dir: string, files: string[] = []): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await getAllSourceFilesAsync(fullPath, files)
        }
      } else if (/\.(ts|tsx|css|html|json)$/.test(entry.name)) {
        files.push(fullPath)
      }
    }
  } catch { /* ignore */ }
  return files
}

async function hashFileAsync(filePath: string): Promise<string> {
  try {
    const content = await fs.promises.readFile(filePath)
    return crypto.createHash('md5').update(content).digest('hex')
  } catch {
    return ''
  }
}

function computeHashes(): SourceHashes | null {
  const projectRoot = getProjectRootPath()
  if (!projectRoot) return null

  const srcDir = path.join(projectRoot, 'src')
  if (!fs.existsSync(srcDir)) return null

  const files = getAllSourceFiles(srcDir)
  const hashes: Record<string, string> = {}

  for (const file of files) {
    const relativePath = path.relative(srcDir, file)
    hashes[relativePath] = hashFile(file)
  }

  return { timestamp: Date.now(), hashes }
}

// #120: non-blocking twin of computeHashes(). The synchronous version walked the
// entire dev src tree and readFileSync+md5-hashed every file on the main thread,
// freezing the event loop ~20s at boot (jank monitor logged a matching ~27s
// stall) and blocking first paint. This variant uses async fs + yields to the
// loop every ~50 files, so the sweep can never freeze the main thread.
async function computeHashesAsync(): Promise<SourceHashes | null> {
  const projectRoot = getProjectRootPath()
  if (!projectRoot) return null

  const srcDir = path.join(projectRoot, 'src')
  if (!fs.existsSync(srcDir)) return null

  const files = await getAllSourceFilesAsync(srcDir)
  const hashes: Record<string, string> = {}

  let sinceYield = 0
  for (const file of files) {
    const relativePath = path.relative(srcDir, file)
    hashes[relativePath] = await hashFileAsync(file)
    if (++sinceYield >= 50) { sinceYield = 0; await yieldToLoop() }
  }

  return { timestamp: Date.now(), hashes }
}

function loadSavedHashes(): SourceHashes | null {
  try {
    if (fs.existsSync(HASH_FILE)) {
      return JSON.parse(fs.readFileSync(HASH_FILE, 'utf-8'))
    }
  } catch { /* ignore */ }
  return null
}

function saveHashes(hashes: SourceHashes): boolean {
  try {
    const dir = path.dirname(HASH_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(HASH_FILE, JSON.stringify(hashes, null, 2))
    logInfo(`[update-watcher] Saved hashes to ${HASH_FILE}`)
    return true
  } catch (err) {
    logError('[update-watcher] Failed to save hashes:', err)
    return false
  }
}

function hasChanges(oldHashes: SourceHashes, newHashes: SourceHashes): boolean {
  const oldKeys = Object.keys(oldHashes.hashes)
  const newKeys = Object.keys(newHashes.hashes)

  // Check for new or removed files
  if (oldKeys.length !== newKeys.length) return true

  // Check for changed files
  for (const key of newKeys) {
    if (oldHashes.hashes[key] !== newHashes.hashes[key]) return true
  }

  return false
}

// #120: fully async so the file-hash sweep never blocks the main thread. The
// old synchronous checkForUpdates() was the ~20s boot freeze (see
// computeHashesAsync). Callers that don't need the result fire-and-forget it.
async function checkForUpdates(): Promise<void> {
  // Check if source path is now available (might have been configured after startup)
  const sourceConfigured = hasSourcePath()
  if (sourceConfigured !== lastSourceConfigured) {
    lastSourceConfigured = sourceConfigured
    const w = windowGetter?.()
    if (w && !w.isDestroyed()) {
      w.webContents.send('update:sourceConfigured', sourceConfigured)
    }
  }
  if (!sourceConfigured) return

  // Load saved hashes if we haven't yet
  if (!currentHashes) {
    currentHashes = loadSavedHashes()
    if (!currentHashes) {
      // First run - save current state as baseline
      currentHashes = await computeHashesAsync()
      if (currentHashes) {
        saveHashes(currentHashes)
        logInfo('[update-watcher] Initial hash snapshot saved')
      }
    }
  }

  if (!currentHashes) return

  const newHashes = await computeHashesAsync()
  if (!newHashes) return

  const changed = hasChanges(currentHashes, newHashes)

  if (changed !== updateAvailable) {
    updateAvailable = changed
    // Re-resolve the window after the async sweep — it may have appeared or
    // been torn down while we were hashing.
    const w = windowGetter?.()
    if (w && !w.isDestroyed()) {
      w.webContents.send('update:available', updateAvailable)
      if (updateAvailable) {
        logInfo('[update-watcher] Source changes detected, update available')
      }
    }
  }
}

function reinitializeWatcher(): void {
  logInfo('[update-watcher] Re-initializing watcher (source path may have changed)')
  // Reset state so it picks up new source path
  currentHashes = null
  updateAvailable = false
  // Immediately check for updates (non-blocking).
  void checkForUpdates()
}

export function initUpdateWatcher(getWindow: () => BrowserWindow | null): void {
  windowGetter = getWindow

  if (watcherInitialized) {
    logInfo('[update-watcher] Already initialized, skipping')
    return
  }
  watcherInitialized = true

  const projectRoot = getProjectRootPath()
  const srcDir = projectRoot ? path.join(projectRoot, 'src') : ''

  if (hasSourcePath()) {
    logInfo(`[update-watcher] Source path configured: ${srcDir}`)
  } else {
    logInfo('[update-watcher] No source path configured')
  }

  // #120: DEFER the startup check off the boot path. It hashes the whole dev
  // src tree; even now that it yields, running it during boot competes with the
  // renderer's first paint. Fire it ~3s after boot, non-blocking. Single check —
  // no polling; use checkForUpdatesOnDemand() for manual checks.
  setTimeout(() => { void checkForUpdates() }, 3000)
}

export function isUpdateAvailable(): boolean {
  return updateAvailable
}

// On-demand check triggered by user clicking "Check for Updates". Async so a
// large src tree never freezes the UI on the button click either.
export async function checkForUpdatesOnDemand(): Promise<boolean> {
  await checkForUpdates()
  return updateAvailable
}

export function markUpdateInstalled(): void {
  logInfo('[update-watcher] markUpdateInstalled called')
  // Save current hashes as the new baseline
  const newHashes = computeHashes()
  if (newHashes) {
    currentHashes = newHashes
    logInfo(`[update-watcher] Computed ${Object.keys(currentHashes.hashes).length} file hashes`)
    const saved = saveHashes(currentHashes)
    updateAvailable = false
    if (saved) {
      logInfo('[update-watcher] Update installed, new hash snapshot saved successfully')
    } else {
      logError('[update-watcher] Failed to save hash snapshot!')
    }
  }
}

export function stopUpdateWatcher(): void {
  if (watchInterval) {
    clearInterval(watchInterval)
    watchInterval = null
  }
  watcherInitialized = false
}
