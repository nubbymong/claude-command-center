// A provider account's own memories on the Memory page (WP2 PR 4, P4.4, row
// 55). Claude Code keeps one memory store shared by every account
// (~/.claude/projects/*/memory/, the page's dashboard); a provider whose
// package names a memories folder per account (Codex: the account folder's
// `memories/`) has its files listed per account, beside it.
//
// The listing is main's: it walks the account's memories folder, never lists
// or opens a `.git` folder (Codex keeps that folder as a git repository),
// never follows a link or junction, and lists only plain `.md` files. Paths in
// it are main's own, read back by the existing memory channels, which check
// them again (validateAccountMemoryPath) before any read or delete.
import type { MemoryFile, MemoryScanResult, ProviderId } from './types'

/** One memory file of an account. `filename` is its path inside the
 *  memories folder, written with `/`; `relPath` the same, kept apart so a
 *  display change to `filename` never changes what is matched. */
export interface AccountMemoryFile extends MemoryFile {
  providerId: ProviderId
  accountId: string
  relPath: string
}

/** What an account's memories folder holds:
 *  - `present`: a folder (its files may still be none);
 *  - `none`: no memories folder, which is what an account with memories off
 *    has (the provider's default) or one that has not written any yet;
 *  - `unreadable`: something is there that is not a plain folder (a link or
 *    junction included), or it could not be read. */
export type AccountMemoryState = 'present' | 'none' | 'unreadable'

export interface AccountMemories {
  providerId: ProviderId
  accountId: string
  /** The provider's own folder on this computer (Codex's folder in the user's home), which
   *  other tools on this computer share. */
  external: boolean
  state: AccountMemoryState
  files: AccountMemoryFile[]
  /** The walk stopped at its bounds; more files may be there. */
  truncated: boolean
}

/** memory:scan's answer: Claude's store as before, and each account's own
 *  memories when main has any to list (absent on an older main). */
export interface MemoryScanWithAccounts extends MemoryScanResult {
  accountMemories?: AccountMemories[]
}

/** Delete is built for an account's memory files (main checks the path as
 *  it does for a read, and refuses anything inside `.git`), but it is not
 *  OFFERED until a VM check shows the provider's own consolidation (Codex
 *  keeps a git repository and a database there) does not restore or
 *  re-commit a deleted file at its next start. The check counts only if
 *  consolidation is seen to run after the delete; otherwise it stays hidden
 *  and the check joins the owner's real-model checks (P4.4, OR4). The one
 *  flag for both sides: the page shows no Delete and main's memory:delete
 *  refuses an account path while it is false. */
export const ACCOUNT_MEMORY_DELETE_SHOWN: boolean = false

/** True for a memory that belongs to an account's own folder. */
export function isAccountMemoryFile(m: MemoryFile): m is AccountMemoryFile {
  const a = m as Partial<AccountMemoryFile>
  return typeof a.accountId === 'string' && typeof a.relPath === 'string' && typeof a.providerId === 'string'
}
