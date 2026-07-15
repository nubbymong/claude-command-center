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

/**
 * Read the active Codex (OpenAI) account identity by decoding the JWT
 * id_token in ~/.codex/auth.json. Returns null on missing file,
 * malformed JWT, missing email claim, or expired exp. Never throws.
 * Codex CLI owns refresh -- we never try to renew the token here.
 */
export function readCodexAccountEmail(): AccountIdentity | null {
  try {
    const path = join(homedir(), '.codex', 'auth.json')
    const j = JSON.parse(readFileSync(path, 'utf-8'))
    const idToken = j?.tokens?.id_token
    if (typeof idToken !== 'string') return null
    const parts = idToken.split('.')
    if (parts.length !== 3) return null
    let payload: any
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
    } catch {
      return null
    }
    if (typeof payload?.email !== 'string') return null
    if (typeof payload?.exp === 'number' && payload.exp * 1000 < Date.now()) return null
    return {
      email: payload.email,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      accountUuid: typeof j?.tokens?.account_id === 'string' ? j.tokens.account_id : undefined,
      provider: 'codex',
    }
  } catch {
    return null
  }
}
