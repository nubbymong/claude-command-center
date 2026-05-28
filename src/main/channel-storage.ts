// src/main/channel-storage.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { getResourcesDirectory } from './ipc/setup-handlers'
import { logInfo, logError } from './debug-logger'

const SUBDIR = 'conductor-channels'

export function channelsDir(): string {
  return join(getResourcesDirectory(), SUBDIR)
}
function ensureDir(): void {
  const dir = channelsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
function filePath(name: string): string {
  return join(channelsDir(), name)
}

// Atomic write -- temp + replace. Mirrors config-manager.ts:147-167.
export function writeJsonFile(name: string, data: unknown): boolean {
  ensureDir()
  const fp = filePath(name)
  const tmp = fp + '.tmp'
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    // rename atomically replaces on the same volume (Windows + POSIX)
    renameSync(tmp, fp)
    return true
  } catch (err) {
    logError(`[channels] write ${name} failed: ${String(err)}`)
    return false
  }
}

// Read with corruption recovery. On parse error / read error the bad file is
// renamed to <name>.corrupt-<ts> (evidence preserved) and seedDefaults() is returned.
// A missing file silently returns seedDefaults() (no write).
export function readJsonFile<T>(name: string, seedDefaults: () => T): T {
  const fp = filePath(name)
  if (!existsSync(fp)) return seedDefaults()
  try {
    return JSON.parse(readFileSync(fp, 'utf-8')) as T
  } catch (err) {
    const corruptPath = `${fp}.corrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try { renameSync(fp, corruptPath); logError(`[channels] ${name} unreadable, moved to ${corruptPath}`) }
    catch (e) { logError(`[channels] could not quarantine ${name}: ${String(e)}`) }
    return seedDefaults()
  }
}

// Append one line to a daily JSONL file. Used by the ledger (Task P2.4).
export function appendLine(name: string, line: string): void {
  ensureDir()
  const fp = filePath(name)
  try {
    const existing = existsSync(fp) ? readFileSync(fp, 'utf-8') : ''
    writeFileSync(fp, existing + line + '\n', 'utf-8')
  } catch (err) {
    logError(`[channels] append ${name} failed: ${String(err)}`)
  }
}

export function listFiles(): string[] {
  ensureDir()
  try { return readdirSync(channelsDir()) } catch { return [] }
}
export function deleteFile(name: string): void {
  try { unlinkSync(filePath(name)) } catch { /* ignore */ }
}
export { logInfo }
