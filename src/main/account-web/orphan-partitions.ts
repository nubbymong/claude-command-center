/**
 * orphan-partitions.ts: the web-session partitions a dev instance left in the
 * SHARED location (#261), named at boot, never removed.
 *
 * Moved out of index.ts (WP2 PR 4, P4.6, row 58) so it can be tested, and
 * widened from Claude's claude.ai partitions to both web-session partition
 * prefixes (shared/account-web-session.ts, isWebSessionPartitionDir).
 *
 * WARN, NEVER DELETE. Those directories hold live session cookies and after
 * the redirect nothing references them: `ccc --clean` cannot reach them (wrong
 * root) and `sweepAbandonedProfiles` only walks `<dataDir>/account-web`. So they
 * would sit there forever, which is the very complaint the redirect is meant to
 * fix. But automatic removal is NOT safe: `ccc --seed-accounts` copies prod's
 * account profiles into dev, so a partition named for a dev profile id can be
 * the PROD install's live session. Deleting it would sign the user out of their
 * real account to tidy up a dev artifact. Naming the path and leaving the choice
 * to a human is the correct trade here.
 *
 * No default export (project convention).
 */

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { logInfo } from '../debug-logger'
import { isWebSessionPartitionDir } from '../../shared/account-web-session'

/**
 * The web-session partition directories in `<userData>/Partitions` when that
 * is not the live location. Empty when it is (a partition in use is never an
 * orphan) or when there is no such directory. Reads only.
 */
export function listOrphanedSharedWebPartitions(userDataDir: string, liveSessionDataDir: string): string[] {
  const shared = join(userDataDir, 'Partitions')
  if (shared === join(liveSessionDataDir, 'Partitions') || !existsSync(shared)) return []
  return readdirSync(shared).filter((name) => isWebSessionPartitionDir(name))
}

/**
 * Point out the orphans in one log line. Advisory only: never throws, never
 * removes. The user-data folder is read inside the guard, as it always was.
 */
export function warnAboutOrphanedSharedPartitions(getUserDataDir: () => string, liveSessionDataDir: string): void {
  try {
    const userDataDir = getUserDataDir()
    const orphans = listOrphanedSharedWebPartitions(userDataDir, liveSessionDataDir)
    if (!orphans.length) return
    const shared = join(userDataDir, 'Partitions')
    logInfo(
      `[setup] ${orphans.length} web session partition(s) remain in the SHARED location `
      + `and are no longer used by this dev instance: ${shared}. They hold live session cookies. `
      + `Remove them by hand ONLY if you are sure they are not your production install's `
      + `(see docs/dev-alongside-prod.md).`,
    )
  } catch { /* advisory only: never let a warning break boot */ }
}
