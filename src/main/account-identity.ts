import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { AccountIdentity } from '../shared/types'

const CLAUDE_JSON_MAX_BYTES = 5 * 1024 * 1024  // 5MB defensive cap

/**
 * Read the active Claude account identity from ~/.claude.json's
 * oauthAccount block. Returns null on any failure -- missing file,
 * malformed JSON, missing oauthAccount, file size > 5MB cap.
 * Never throws.
 */
export function readClaudeAccountEmail(): AccountIdentity | null {
  try {
    const path = join(homedir(), '.claude.json')
    const stat = statSync(path)
    if (stat.size > CLAUDE_JSON_MAX_BYTES) return null
    const j = JSON.parse(readFileSync(path, 'utf-8'))
    const oa = j?.oauthAccount
    if (!oa || typeof oa.emailAddress !== 'string') return null
    return {
      email: oa.emailAddress,
      name: typeof oa.displayName === 'string' ? oa.displayName : undefined,
      accountUuid: typeof oa.accountUuid === 'string' ? oa.accountUuid : undefined,
      provider: 'claude',
    }
  } catch {
    return null
  }
}
