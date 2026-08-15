// The install's one long-lived secret, and the keys derived from it.
//
// It was born as the Conductor MCP server's auth secret and lived inside
// conductor-mcp-server.ts. It moved here when a SECOND subsystem needed a key
// off it (the canvas store's record MAC, adversarial review 2026-08-15): the
// alternative was either a second minting path writing the same config key —
// two writers, one file, and the racy half wins — or an import cycle
// (canvas-store → conductor-mcp-server → canvas-store). This module imports
// nothing but the config layer, so anything may key off it.
//
// Nothing else about the secret changed in the move; conductor-mcp-server still
// exports `getConductorMcpSecret` and its rotation semantics are unchanged.

import * as crypto from 'crypto'
import { readConfig, saveConfig } from './config-manager'
import { logWarn } from './debug-logger'

// === R-DEC-3: per-launch auth secret ===
//
// The MCP server listens on a loopback port and exposes vision_* tools --
// including vision_eval (arbitrary JS in the embedded browser) -- plus
// cross-session actions. Loopback is NOT an authorisation boundary: any
// local process (or a malicious page in a browser the user opened) could
// drive it, so we require a 32-byte secret on EVERY request, embedded into the
// MCP registration URLs CCC writes for Claude/Codex (?token=<secret>) so
// legitimate sessions authenticate transparently. The secret is PERSISTED once
// (CONFIG/conductor-secret.json) and reused across launches: a live SSH session
// bakes the token into its --mcp-config, so if a restart / crash-relaunch rotated
// the secret, that still-running session's MCP would fail every request as "not
// authenticated" (SSE closed) with no recovery but relaunching the session. It is
// already effectively on disk (in each session's mcp-config), so central
// persistence adds no new exposure; loopback remains not an auth boundary.
/**
 * Bumped when a stored secret must be considered burned regardless of its value.
 *
 * v2: every secret written by an earlier build was persisted through writeConfig
 * with no file mode, so it landed 0644 -- world-readable -- and on Windows into a
 * config dir created without a reparse-point check. Re-permissioning it does not
 * help: anything that could read it already has. So a secret stored without this
 * marker is DISCARDED and a fresh one minted, once, on first launch of a fixed
 * build.
 *
 * The cost is understood and accepted: a session already running with the old
 * token baked into its --mcp-config (the reason this is persisted rather than
 * rotated per launch) will fail MCP auth until it is relaunched. That is a
 * one-time upgrade cost and the alternative is keeping a compromised token.
 *
 * v3 (GHSA-q83v-phcc-hgv4): through v2 the secret was written VERBATIM into
 * every session's own --mcp-config as the `?token=`, so it was a shared
 * credential held by every principal on the machine. It is now used only as an
 * HMAC KEY: each session's config carries `mcpSessionToken(sessionId)` =
 * HMAC(secret, sessionId), and the secret itself never leaves this process.
 * But a v2 secret is known to anything that read a config, so as an HMAC key it
 * would let such a reader forge a binding for any session — it must be
 * discarded and a fresh, never-distributed key minted. Same one-time cost: a
 * session still running with a v2 `?token=` fails auth until relaunched.
 */
export const CONDUCTOR_SECRET_VERSION = 3

let _installSecret: string | null = null

function loadOrCreateInstallSecret(): string {
  try {
    const saved = readConfig<{ secret?: string; v?: number }>('conductorSecret')
    if (saved?.secret && /^[0-9a-f]{64}$/.test(saved.secret)) {
      if (saved.v === CONDUCTOR_SECRET_VERSION) return saved.secret
      logWarn('[conductor-mcp] rotating the auth secret: the stored one predates the file-mode fix and must be treated as compromised')
    }
  } catch { /* fall through and mint a fresh one */ }
  const secret = crypto.randomBytes(32).toString('hex')
  try { saveConfig('conductorSecret', { secret, v: CONDUCTOR_SECRET_VERSION }) } catch (err) { logWarn(`[conductor-mcp] could not persist auth secret: ${err}`) }
  return secret
}

/** The install secret, persisted across launches (lazy so it loads AFTER the
 *  resources dir is configured, not at module init).
 *
 *  As of v3 (GHSA-q83v-phcc-hgv4) this is an HMAC KEY, not a bearer token: it
 *  is NEVER written into a session config or sent off-process. */
export function getInstallSecret(): string {
  if (_installSecret === null) _installSecret = loadOrCreateInstallSecret()
  return _installSecret
}

/**
 * A purpose-bound subkey of the install secret.
 *
 * DOMAIN SEPARATION, and it is not decorative. The MCP session token is
 * `HMAC(secret, sessionId)` and IS distributed — every session's own config
 * carries one. If another subsystem keyed off `HMAC(secret, <string>)` with the
 * same shape, anyone holding a session token would hold that subsystem's key
 * for the matching string. The `ccc:` prefix is what makes that impossible:
 * session ids are `[A-Za-z0-9_-]+`, so no session id can ever contain a colon
 * and no derived key can ever equal a distributed token.
 *
 * Returns raw bytes, not hex — an HMAC key is bytes.
 */
export function deriveInstallKey(purpose: string): Buffer {
  return crypto.createHmac('sha256', getInstallSecret()).update(`ccc:${purpose}`, 'utf8').digest()
}

/** Test seam: drop the cached secret so the next call re-reads config. */
export function _resetInstallSecretForTest(): void {
  _installSecret = null
}
