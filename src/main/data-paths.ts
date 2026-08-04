import * as path from 'path'
import * as fs from 'fs'
import { homedir } from 'os'
import { readRegistry, writeRegistry } from './registry'
import { logInfo } from './debug-logger'

// Default data dir. Uses os.homedir() (not Electron's app.getPath('home')) so
// this module stays electron-free and can run inside the hooks utilityProcess.
// Resolved lazily via getDataDirectory() so downstream lazy-initializers
// (e.g. debug-logger) can call it without a module-load-order constraint.
// Current-brand default, plus the legacy locations it replaced. A FRESH install
// gets the brand path so nothing on disk carries the old name; an install that
// already has data keeps using the directory it has, because relocating it would
// look to the user like every session, config and log had vanished.
//
// This matters most on macOS and Linux: neither has an installer to record a
// chosen directory, so this fallback IS where their data lives. On Windows the
// installer normally writes the location to the registry and this is only the
// last resort.
function dataDirCandidates(): { brand: string; legacy: string[] } {
  if (process.platform === 'darwin') {
    const appSupport = path.join(homedir(), 'Library', 'Application Support')
    return {
      brand: path.join(appSupport, 'AI Code Conductor'),
      legacy: [path.join(appSupport, 'Claude Conductor')],
    }
  }
  if (process.platform === 'linux') {
    return {
      brand: path.join(homedir(), '.ai-code-conductor', 'data'),
      legacy: [path.join(homedir(), '.claude-conductor', 'data')],
    }
  }
  // Windows: derive %LOCALAPPDATA% from the env var,
  // falling back to <home>\AppData\Local.
  const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
  return {
    brand: path.join(localAppData, 'AI Code Conductor'),
    legacy: [
      path.join(localAppData, 'Claude Command Center'),
      path.join(localAppData, 'Claude Conductor'),
    ],
  }
}

function getDefaultDataDir(): string {
  const { brand, legacy } = dataDirCandidates()
  if (fs.existsSync(brand)) return brand
  for (const dir of legacy) {
    if (fs.existsSync(dir)) return dir
  }
  return brand
}

// Cache registry values — they don't change during the app's lifetime
// (only set during installer wizard or setup dialog, which restarts the app)
let cachedDataDir: string | null = null
let cachedResourcesDir: string | null = null
let dataDirFromRegistry = false // true if DataDirectory was found in registry

// Read data directory from registry (cached after first call)
export function getDataDirectory(): string {
  if (cachedDataDir) return cachedDataDir

  // E2E isolation: when CCC_E2E_DATA_DIR is set (Playwright only, never in
  // production) use a fresh temp dir as the data root and treat it as
  // configured so the setup wizard is skipped. Keeps e2e off the user's
  // real data and registry.
  const e2eDir = process.env.CCC_E2E_DATA_DIR
  if (e2eDir) {
    cachedDataDir = e2eDir
    dataDirFromRegistry = true
    logInfo(`[setup] Data directory from E2E override: ${cachedDataDir}`)
    return cachedDataDir
  }

  // DEV isolation: a dev instance (npm run dev / ccc) runs alongside a live
  // production install. CCC_DEV_DATA_DIR (set by index.ts when !app.isPackaged,
  // and by the ccc launcher) points dev at its OWN data root so it never shares
  // CONFIG/sessions/transcripts with prod. Checked BEFORE the registry so dev
  // ignores prod's configured dir. Treated as configured (skip the setup wizard).
  const devDir = process.env.CCC_DEV_DATA_DIR
  if (devDir) {
    cachedDataDir = devDir
    dataDirFromRegistry = true
    logInfo(`[setup] Data directory from DEV override: ${cachedDataDir}`)
    return cachedDataDir
  }

  const regVal = readRegistry('DataDirectory')
  if (regVal) {
    cachedDataDir = regVal
    dataDirFromRegistry = true
    logInfo(`[setup] Data directory from registry: ${cachedDataDir}`)
    return cachedDataDir
  }

  cachedDataDir = getDefaultDataDir()
  logInfo(`[setup] Data directory default: ${cachedDataDir}`)
  return cachedDataDir
}

// Read resources directory from registry (cached after first call)
export function getResourcesDirectory(): string {
  if (cachedResourcesDir) return cachedResourcesDir

  // E2E isolation (see getDataDirectory): resources live under the temp data dir.
  const e2eDir = process.env.CCC_E2E_DATA_DIR
  if (e2eDir) {
    cachedResourcesDir = path.join(e2eDir, 'resources')
    logInfo(`[setup] Resources directory from E2E override: ${cachedResourcesDir}`)
    return cachedResourcesDir
  }

  // DEV isolation (see getDataDirectory): dev resources live under the dev data
  // root, so CONFIG/, screenshots/, skills/ etc. are all isolated from prod.
  const devDir = process.env.CCC_DEV_DATA_DIR
  if (devDir) {
    cachedResourcesDir = path.join(devDir, 'resources')
    logInfo(`[setup] Resources directory from DEV override: ${cachedResourcesDir}`)
    return cachedResourcesDir
  }

  const regVal = readRegistry('ResourcesDirectory')
  if (regVal) {
    cachedResourcesDir = regVal
    logInfo(`[setup] Resources directory from registry: ${cachedResourcesDir}`)
    return cachedResourcesDir
  }

  cachedResourcesDir = path.join(getDataDirectory(), 'resources')
  logInfo(`[setup] Resources directory fallback: ${cachedResourcesDir}`)
  return cachedResourcesDir
}

// Set data directory in registry and create folders
export function setDataDirectory(dataDir: string): boolean {
  try {
    // Create directory structure
    fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'debug'), { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })

    writeRegistry('DataDirectory', dataDir)

    cachedDataDir = dataDir // Update cache
    dataDirFromRegistry = true
    logInfo(`[setup] Data directory set to: ${dataDir}`)
    return true
  } catch (err) {
    logInfo(`[setup] Failed to set data directory: ${err}`)
    return false
  }
}

// Set resources directory in registry and create folders
export function setResourcesDirectory(resourcesDir: string): boolean {
  try {
    fs.mkdirSync(path.join(resourcesDir, 'insights'), { recursive: true })
    fs.mkdirSync(path.join(resourcesDir, 'screenshots'), { recursive: true })
    fs.mkdirSync(path.join(resourcesDir, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(resourcesDir, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(resourcesDir, 'status'), { recursive: true })

    writeRegistry('ResourcesDirectory', resourcesDir)

    cachedResourcesDir = resourcesDir // Update cache
    logInfo(`[setup] Resources directory set to: ${resourcesDir}`)
    return true
  } catch (err) {
    logInfo(`[setup] Failed to set resources directory: ${err}`)
    return false
  }
}

// Accessor for the dataDirFromRegistry flag (used by isSetupComplete in the IPC layer)
export function isDataDirFromRegistry(): boolean {
  return dataDirFromRegistry
}
