import { commandSecretEnvName, commandSecretKey } from '../shared/command-secret'

/**
 * Which command secrets a SHELL spawn should carry in its environment.
 *
 * Called from the pty:spawn handler, in main, with the commands file as read
 * from disk and a keychain loader. Nothing here is trusted: the commands file is
 * user data and may be any shape, the ids are checked before they can become a
 * variable name, and only commands that (a) say they have a secret and (b) are
 * visible to the spawning config — global, or scoped to exactly it — are looked
 * up at all. A command's TARGET is deliberately not consulted: the env var is
 * inert if nothing types its name, and the spawn being a shell is already the
 * condition that matters.
 *
 * Returns a map of command id → value, with ids already validated, so the
 * spawn builder can turn each straight into a variable.
 */
export function collectCommandSecrets(
  commands: unknown,
  configId: string | undefined,
  load: (key: string) => string | null,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(commands)) return out
  for (const c of commands) {
    if (!c || typeof c !== 'object') continue
    const cmd = c as { id?: unknown; hasSecretArg?: unknown; scope?: unknown; configId?: unknown }
    if (cmd.hasSecretArg !== true) continue
    if (typeof cmd.id !== 'string' || !commandSecretEnvName(cmd.id)) continue
    const visible = cmd.scope === 'global' || (cmd.scope === 'config' && typeof configId === 'string' && cmd.configId === configId)
    if (!visible) continue
    const value = load(commandSecretKey(cmd.id))
    if (value) out[cmd.id] = value
  }
  return out
}
