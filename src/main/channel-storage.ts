// src/main/channel-storage.ts
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { getResourcesDirectory } from './ipc/setup-handlers'
import { logInfo, logError } from './debug-logger'
import { randomId } from '../shared/id'

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
    // A collision-breaker on an already-timestamped name, not an identifier --
    // 8 hex chars is plenty, and the full 24 would push an already-long
    // quarantine path 16 chars closer to Windows MAX_PATH for no benefit.
    const corruptPath = `${fp}.corrupt-${Date.now()}-${randomId().slice(0, 8)}`
    try { renameSync(fp, corruptPath); logError(`[channels] ${name} unreadable, moved to ${corruptPath}`) }
    catch (e) { logError(`[channels] could not quarantine ${name}: ${String(e)}`) }
    return seedDefaults()
  }
}

// Append one line to a daily JSONL file. Used by the ledger (Task P2.4).
// True O(1) append (no read+rewrite of the whole day-file): the JSONL format is
// newline-delimited records, so appending one line preserves it and stays back-
// compatible with files written by the previous read+rewrite implementation. It
// is also crash-safe for prior records (a torn write only affects the last line).
export function appendLine(name: string, line: string): void {
  ensureDir()
  const fp = filePath(name)
  try {
    appendFileSync(fp, line + '\n', 'utf-8')
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
