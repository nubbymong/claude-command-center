/**
 * Guards for the renderer's `config:save` of the `configs` key.
 *
 * The renderer is the less-trusted process, and `config:save` used to validate
 * only the KEY, never the VALUE. Two problems followed from that, and this
 * module closes both:
 *
 *  1. (LOAD-BEARING) A saved SSH config's credentials live in the OS keychain
 *     keyed by the config's ID — the bare id is the SSH password, `<id>_sudo`
 *     the sudo password — and are NOT pinned to the config's host. So a renderer
 *     that rewrote a saved config's `sshConfig.host` (or username/port) while
 *     leaving its id unchanged would leave the stored password bound, BY ID, to
 *     a destination the user never approved; the next connect for that id
 *     (`pty:spawn`, `ssh:endRemote`, `ssh:checkDetachedLive`) would then dial
 *     the new host and offer the password. `sshCredentialKeysToInvalidate` names
 *     the connection-bound credential slots of every config whose SSH identity
 *     changed, so the save path can drop them in the SAME transaction. A
 *     legitimate host edit then simply re-prompts for the password (correct,
 *     minor friction); a malicious silent rewrite loses the secret, so there is
 *     nothing left to exfiltrate.
 *
 *  2. (DEFENCE IN DEPTH) `isValidConfigsPayload` rejects a `configs` value that
 *     is not a well-formed config array before it can reach disk — or the
 *     invalidation comparison, or the load-time migrations.
 *
 * Pure and dependency-light so both halves can be unit-tested exhaustively; the
 * config:save handler is the only caller.
 */

import { z } from 'zod'

// A user's whole saved-config list. Well above any real fleet (a few dozen
// configs at the very most) and far below a size at which the comparison or the
// load-time migrations become expensive. A bound AT ALL is the point: an
// unbounded array from a compromised renderer is a memory-pressure primitive on
// the main process, persisted straight to disk.
const MAX_CONFIGS = 1000

// Per-item shape: an OBJECT with a string `id`. `id` is required because it is
// the credential-store key and the coordinate Part 1 matches a config on across
// a save — every config the app writes has one (see configStore.ts). `sshConfig`,
// when present, must be an OBJECT (never a string or array), which is all Part 1
// relies on; its individual fields are deliberately left UNCHECKED (see below).
// Every other TerminalConfig field passes through unexamined.
//
// Left loose on purpose: the goal is to reject a value that is not a config
// array, NOT to police every field. TerminalConfig carries dozens of optional
// fields (provider sub-options, github integration, identity colours, …) and a
// strict enumeration here would reject a legitimate save the day a new optional
// field ships — and Part 1 already reads host/username/port defensively, so a
// malformed sshConfig cannot mislead it. `.nullish()` on sshConfig tolerates a
// config that carries `sshConfig: null`.
const configItemSchema = z
  .object({
    id: z.string(),
    sshConfig: z.object({}).passthrough().nullish(),
  })
  .passthrough()

const configsPayloadSchema = z.array(configItemSchema).max(MAX_CONFIGS)

/**
 * True when `value` is a well-formed `configs` payload (Part 2): an array,
 * within the length bound, of objects each carrying a string `id` and (if
 * present) an object `sshConfig`. Everything else about each config is
 * intentionally not inspected.
 */
export function isValidConfigsPayload(value: unknown): boolean {
  return configsPayloadSchema.safeParse(value).success
}

/**
 * The connection-bound credential suffixes for a config id: the SSH password
 * (bare id, `''`) and the sudo password (`_sudo`). These are the only two slots
 * whose secret is offered TO THE SSH HOST, so they are the only two a change of
 * host/username/port can misdirect.
 *
 * Deliberately NOT here: `_argsecret` (a terminal-only, non-SSH config's secret
 * argument — such a config has no sshConfig identity to change) and `_cmdsecret`
 * (a command button's secret, keyed by a COMMAND id, never sent to an SSH host).
 * Neither is connection-bound to the destination this change moves.
 */
const CONNECTION_BOUND_SUFFIXES = ['', '_sudo'] as const

interface SshIdentity {
  host: string
  username: string
  port: string
}

function norm(v: unknown): string {
  return v == null ? '' : String(v)
}

/**
 * The SSH connection identity of a saved config, or null when it is not a
 * credential-bearing SSH config. Matches every other reader in main
 * (bindSshToSavedConfig, endTargetFromSavedConfig, savedSshPingHosts): a config
 * is SSH only when `sessionType === 'ssh'` AND it carries an `sshConfig` object.
 * host/username/port are normalised to strings so `22` (number) and `'22'`
 * (string) compare equal and a missing field never reads as changed-to-present
 * spuriously.
 */
function sshIdentityOf(cfg: unknown): SshIdentity | null {
  if (!cfg || typeof cfg !== 'object') return null
  const c = cfg as { sessionType?: unknown; sshConfig?: unknown }
  if (c.sessionType !== 'ssh' || !c.sshConfig || typeof c.sshConfig !== 'object') return null
  const s = c.sshConfig as Record<string, unknown>
  return { host: norm(s.host), username: norm(s.username), port: norm(s.port) }
}

/**
 * The credential-store keys to DROP when persisting `nextConfigs` over
 * `prevConfigs` (Part 1). A config contributes its connection-bound keys (`id`
 * and `id_sudo`) when it was an SSH config in `prev` and, in `next` (matched by
 * id), either is no longer an SSH config or has a different host / username /
 * port. remotePath and everything else are NOT part of the identity: they do
 * not decide which host a stored password is offered to.
 *
 * Both arguments may be anything (a missing or garbled configs.json reads as
 * null): a non-array on either side yields no drops. Non-object entries and
 * entries without a string id are skipped. A config present in `prev` but absent
 * from `next` is a DELETION and out of scope here — its credential lifecycle is
 * the delete path's, not this comparison's.
 */
export function sshCredentialKeysToInvalidate(prevConfigs: unknown, nextConfigs: unknown): string[] {
  if (!Array.isArray(prevConfigs) || !Array.isArray(nextConfigs)) return []

  const nextById = new Map<string, unknown>()
  for (const c of nextConfigs) {
    if (!c || typeof c !== 'object') continue
    const id = (c as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) nextById.set(id, c)
  }

  const keys: string[] = []
  const dropped = new Set<string>()
  for (const prev of prevConfigs) {
    if (!prev || typeof prev !== 'object') continue
    const id = (prev as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0 || dropped.has(id)) continue

    const prevIdentity = sshIdentityOf(prev)
    if (!prevIdentity) continue // nothing connection-bound to protect for this id
    if (!nextById.has(id)) continue // deleted — out of scope here

    const nextIdentity = sshIdentityOf(nextById.get(id))
    // A next config that is no longer SSH (nextIdentity === null) has lost the
    // host the credential was bound to: that is an identity change too, so drop.
    const changed =
      !nextIdentity ||
      prevIdentity.host !== nextIdentity.host ||
      prevIdentity.username !== nextIdentity.username ||
      prevIdentity.port !== nextIdentity.port
    if (!changed) continue

    dropped.add(id)
    for (const suffix of CONNECTION_BOUND_SUFFIXES) keys.push(id + suffix)
  }
  return keys
}
