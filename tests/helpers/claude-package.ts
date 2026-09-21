// Register the REAL Claude provider package with a faked spawn surface.
//
// Since WP1 slice 2 the local launch path takes the Claude package's own
// policy -- the ambient authority variables it strips and the host control it
// applies last -- from the registry. A bare `registerProvider(fakeSession)` is
// no longer enough to drive `spawnPty`: there is no package behind the id, and
// a managed launch fails closed rather than composing an environment with no
// policy in it.
//
// The obvious fix, registering a wholly fake PACKAGE, would be worse than the
// problem: every one of these suites would then assert against a stub's empty
// ambient list and absent host control, and would keep passing if the real
// declarations regressed to nothing. So this layers the caller's fake session
// over a real `ClaudeProvider` instance and keeps everything else -- the
// capability declarations, `ambientAuthVariables`, `hostManagedEnv`,
// `managedLaunch` -- exactly as the app ships it.
import { registerProviderPackage, _resetProviderRegistryForTest } from '../../src/main/providers/core'
import { createClaudePackage } from '../../src/main/providers/claude'

/**
 * Reset the registry and register the real Claude package, with `fakeSession`'s
 * own properties layered over a real ClaudeProvider instance.
 *
 * Layered rather than substituted so the capability-backing check still finds
 * the methods a partial fake omits (`listHistorySessions`,
 * `configureRemoteSettings`, ...) on the real prototype -- a fake that only
 * needs to intercept `buildSpawnCommand` should not have to restate the rest.
 */
export function registerFakeClaudePackage(fakeSession: Record<string, unknown>): void {
  const real = createClaudePackage()
  const session = Object.assign(
    Object.create(Object.getPrototypeOf(real.session) as object),
    real.session,
    fakeSession,
    // The id is the package's, never the fake's: a mismatch is a registration
    // failure, and silently accepting one would hide a genuine defect.
    { id: real.id },
  )
  _resetProviderRegistryForTest()
  registerProviderPackage({ ...real, session })
}
