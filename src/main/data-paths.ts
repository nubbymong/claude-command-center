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

/**
 * Where a DEV instance should keep Electron's `sessionData`, or null for prod.
 *
 * PURE, so the decision is testable without booting Electron. Called from
 * index.ts at module scope, because `app.setPath` only has any effect before the
 * first session is created.
 *
 * WHY THIS EXISTS. Electron stores `persist:` partitions under `sessionData`,
 * which defaults to `userData` — and nothing redirected either, so the
 * per-account claude.ai web sessions (#216) went to
 * `%APPDATA%\claude-conductor\Partitions` no matter which data dir the instance
 * was using. Dev and prod therefore SHARED them: signing out in dev revoked
 * prod's session for that account, and `ccc --clean` wiped the dev data dir while
 * leaving a live `sessionKey` on disk, because the partition was never under it.
 * `sweepAbandonedProfiles` could not help either — it only walks
 * `<dataDir>/account-web` (#261).
 *
 * DEV ONLY, DELIBERATELY. `userData` is Electron's own default for session data
 * and is not wrong for prod; relocating prod would force a re-login for anyone who
 * had already signed in on a build that created a partition there, which is a real
 * cost with no matching benefit. Packaged builds get null and are untouched.
 *
 * Returns null when there is no dev override, so the caller does nothing at all
 * rather than setting a path it computed from a guess.
 */
export function devSessionDataDir(
  env: NodeJS.ProcessEnv = process.env,
  isPackaged = true,
): string | null {
  // E2E FIRST AND UNCONDITIONALLY, matching getDataDirectory's own ordering
  // above. Its whole point is a disposable data root, and a partition outside it
  // would survive the teardown that is supposed to remove it. An explicit E2E
  // override is never a real user's install, so `isPackaged` is not the question.
  const root = env.CCC_E2E_DATA_DIR || (isPackaged ? undefined : env.CCC_DEV_DATA_DIR)
  if (!root) return null
  // ABSOLUTE ONLY. `app.setPath` rejects a relative path, and the caller creates
  // the directory BEFORE calling it — so a relative root meant `mkdirSync` quietly
  // made `<cwd>/<root>/session` (inside the repo, in one observed run) and then
  // `setPath` threw into a catch, leaving dev writing claude.ai sessionKeys to
  // prod's location exactly as before. Refusing here turns a swallowed throw into
  // a decision with a test.
  if (!path.isAbsolute(root)) return null
  return path.join(root, 'session')
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
