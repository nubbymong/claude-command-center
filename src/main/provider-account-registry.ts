// WP2: the account registry at runtime (plan A1). Provider core owns the
// rules and the store; this module supplies the real file and starts it.
//
// The file is `<resources>/providers/registry.json`, owner-only on POSIX,
// written through the app's one atomic write (exclusive-create staging, then
// rename) and read back before the write counts. Its directory is built with
// mkdirSecure, which refuses to create it through a pre-planted link. The
// registry holds no credential, token or login URL; its integrity matters
// because it binds sessions to accounts.
//
// Windows ACL hardening of `providers/` is deliberately NOT applied here: the
// shared ACL primitive has an open, unexplained empty-DACL failure (aicc
// planning #103). Until that is root-caused the directory inherits the
// resources directory's ACL, like every other non-credential config file.
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-write'
import { mkdirSecure } from './account-profiles'
import { getResourcesDirectory } from './data-paths'
import { logInfo, logError } from './debug-logger'
import { AccountRegistryStore, ConsumerLeaseRegistry, listProviderPackages } from './providers/core'
import type { RegistryFsPort, RegistryStatus, LegacyReconcileOutcome } from './providers/core'

export const REGISTRY_DIRNAME = 'providers'
export const REGISTRY_FILENAME = 'registry.json'
const BACKUP_NAME_RE = /^registry\.\d+\.json\.bak$/
const IS_POSIX = process.platform !== 'win32'
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The real registry file under a resources directory. */
export function createRegistryFsPort(resourcesDir: string): RegistryFsPort {
  const dir = path.join(resourcesDir, REGISTRY_DIRNAME)
  const file = path.join(dir, REGISTRY_FILENAME)
  const write = (target: string, data: string | Buffer) => {
    mkdirSecure(dir)
    atomicWriteFileSync(target, data, IS_POSIX ? { mode: 0o600 } : undefined)
  }
  return {
    read() {
      try {
        return { kind: 'ok', text: fs.readFileSync(file, 'utf8') }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code
        if (code !== 'ENOENT') return { kind: 'error', message: `${code ?? 'error'}: ${errText(e)}` }
        // ENOENT is absence only when the resources directory itself is
        // there: an unmounted network drive answers ENOENT for every path,
        // and an empty registry written over a real one would lose it. And
        // not when the registry evidently existed: its backups, or a cloud
        // placeholder for an evicted file (iCloud "Optimize Storage").
        try {
          if (!fs.statSync(resourcesDir).isDirectory()) return { kind: 'error', message: 'the resources directory is not a directory' }
        } catch {
          return { kind: 'error', message: 'the resources directory is not available' }
        }
        let siblings: string[] = []
        try { siblings = fs.readdirSync(dir) } catch (d) {
          // No providers/ yet is a first start; anything else is not absence.
          if ((d as NodeJS.ErrnoException)?.code !== 'ENOENT') return { kind: 'error', message: `providers/ could not be listed: ${errText(d)}` }
        }
        if (siblings.some((n) => BACKUP_NAME_RE.test(n) || n.toLowerCase() === `.${REGISTRY_FILENAME}.icloud`)) {
          return { kind: 'error', message: `${REGISTRY_FILENAME} is missing but its backups or a cloud placeholder are present; restore it or remove them` }
        }
        return { kind: 'missing' }
      }
    },
    write(text) {
      write(file, text)
      if (fs.readFileSync(file, 'utf8') !== text) throw new Error('the registry did not read back as written')
    },
    backup(name) {
      if (!BACKUP_NAME_RE.test(name)) throw new Error('refused an unexpected backup name')
      write(path.join(dir, name), fs.readFileSync(file))
    },
    listBackups() {
      try { return fs.readdirSync(dir).filter((n) => BACKUP_NAME_RE.test(n)) } catch { return [] }
    },
    removeBackup(name) {
      if (!BACKUP_NAME_RE.test(name)) throw new Error('refused an unexpected backup name')
      fs.unlinkSync(path.join(dir, name))
    },
  }
}

let store: AccountRegistryStore | null = null
let storeResourcesDir: string | null = null

/** The one consumer lease registry (A11). The store reads its counts under
 *  the lock that applies a lifecycle change; the accounts service adds and
 *  releases leases. */
const leases = new ConsumerLeaseRegistry()

export function getConsumerLeases(): ConsumerLeaseRegistry {
  return leases
}

/** The resources directory the registry was loaded from: the managed realm
 *  folders live under it, so realm lookups use exactly this one. */
export function getAccountRegistryResourcesDir(): string | null {
  return storeResourcesDir
}

/** Load the registry once at start. Never throws: a registry problem leaves
 *  the app running in recovery mode, and Claude keeps working from
 *  profiles.json. */
export function initAccountRegistry(resourcesDir: string): RegistryStatus {
  // A replaced store refuses every later change: an operation that captured
  // it cannot write the old directory's file, nor the same file behind the
  // new store's own lock.
  store?.retire()
  store = new AccountRegistryStore({
    fs: createRegistryFsPort(resourcesDir),
    now: () => Date.now(),
    consumers: (accountId) => leases.count(accountId),
    log: (m) => logInfo(m),
  })
  storeResourcesDir = resourcesDir
  const status = store.load()
  logInfo(`[registry] loaded: ${status.mode}${status.mode === 'recovery' ? ` (${status.reason})` : ''}`)
  return status
}

export function getAccountRegistry(): AccountRegistryStore | null {
  return store
}

/** Whether the registry was loaded from the resources directory the app uses
 *  NOW. The file port captures its directory when the store is made, while
 *  a legacy store (Claude's profiles.json) is read from the current one: a
 *  reconcile across the two would mirror one directory's profiles into
 *  another directory's registry. */
export function accountRegistryIsCurrent(): boolean {
  if (!store || storeResourcesDir === null) return false
  try { return sameDirectory(getResourcesDirectory(), storeResourcesDir) } catch { return false }
}

/** Two spellings of one folder: compared by the real path when both exist,
 *  else by the resolved path; case-insensitively on Windows and macOS (their
 *  default file systems ignore case). */
export function sameDirectory(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const canon = (p: string) => {
    let out: string
    try { out = fs.realpathSync.native(p) } catch { out = path.resolve(p) }
    out = out.replace(/[\\/]+$/, '')
    return platform === 'win32' || platform === 'darwin' ? out.toLowerCase() : out
  }
  return canon(a) === canon(b)
}

/** Mirror one provider's legacy account store now (after an identity edit
 *  it mirrors). A failure is logged and retried at the next start. */
export async function reconcileLegacyAccountStore(providerId: string): Promise<void> {
  const s = store
  const pkg = listProviderPackages().find((p) => p.id === providerId)
  if (!s || !pkg?.legacyAccounts) return
  if (!accountRegistryIsCurrent()) {
    logError(`[registry] ${providerId}: write-through skipped: the resources directory changed since the registry was loaded`)
    return
  }
  const outcome = await s.reconcileLegacy(pkg.legacyAccounts)
  if (!outcome.ok) logError(`[registry] ${providerId}: write-through not applied (${outcome.code}): ${outcome.message}`)
}

/** Mirror every provider's legacy account store into the registry. */
export async function reconcileLegacyAccountStores(): Promise<Array<{ providerId: string; outcome: LegacyReconcileOutcome }>> {
  const s = store
  if (!s) return []
  if (!accountRegistryIsCurrent()) {
    logError('[registry] reconcile skipped: the resources directory changed since the registry was loaded')
    return []
  }
  const out: Array<{ providerId: string; outcome: LegacyReconcileOutcome }> = []
  for (const pkg of listProviderPackages()) {
    if (!pkg.legacyAccounts) continue
    try {
      const outcome = await s.reconcileLegacy(pkg.legacyAccounts)
      if (outcome.ok) {
        logInfo(`[registry] ${pkg.id}: created ${outcome.created}, imported ${outcome.imported}, archived ${outcome.archived}, restored ${outcome.restored}, pending writes ${outcome.writes}`)
      } else {
        logError(`[registry] ${pkg.id}: reconcile not applied (${outcome.code}): ${outcome.message}`)
      }
      out.push({ providerId: pkg.id, outcome })
    } catch (e) {
      logError(`[registry] ${pkg.id}: reconcile threw: ${errText(e)}`)
    }
  }
  return out
}

export function _resetAccountRegistryForTest(): void {
  store = null
  storeResourcesDir = null
}
