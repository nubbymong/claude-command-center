// WP2 commit 5b (plan "Commit 5b", owner decision 1): the Claude reviewer's
// account and launch. A review runs on a registry account -- the reviewer
// default, else the provider default -- through a launch the accounts service
// prepares: this module is that launch's provider side, for reviews ONLY.
// Claude sessions keep their own launch path (A12), so `kinds` says `review`
// and the accounts service refuses a Claude session here.
//
// A Claude account's realm is its profile home (`claude-profile:<id>`). The
// home is composed by account-profiles (the one module allowed to compose a
// profile home's variables), handed in by the composition root, because this
// package imports no shared main module that reaches the Codex package (R2).
import type { ProviderSetupOperations, ProviderLaunchOperations, ProviderReviewOperations, RealmRef, LaunchPreparation, AuthFailureCode } from '../core'
import { reviewerEnv } from '../review-support'
import type { AuthRealm, RealmEnvPatch } from '../../../shared/providers'
import { CLAUDE_PROFILE_PATH_REF_PREFIX } from '../../../shared/providers'
import { isValidProfileId } from '../../../shared/profile-id'
import { discoverClaude, verifyClaudeExecutable, claudeCompatibilityAllowsUse } from './discovery'
import type { ClaudeDiscovery, ClaudeDiscoveryDeps, ClaudeFileStat } from './discovery'
import { createClaudeReviewOperations } from './review'
import type { ClaudeCliPorts } from './review'
import { CLAUDE_MIN_MANAGED_CLI_VERSION } from './managed-launch'
import fs from 'node:fs'

/** What the composition root hands the Claude package for reviews. */
export interface ClaudeReviewPorts extends ClaudeCliPorts {
  /** The registry's record of a live realm (a snapshot read, never the lock). */
  lookupRealm(ref: RealmRef): Promise<{ ok: true; realm: AuthRealm } | { ok: false }>
  /** account-profiles' profile-home composition, or why this profile cannot
   *  review here (on macOS only the primary account is the normal sign-in).
   *  Throws when the home cannot be set up. */
  profileRealmLaunch(profileId: string): { home: string; baseEnv: Record<string, string>; realmEnv: RealmEnvPatch; sessionsDir: string } | { refused: string }
  /** account-profiles' platform rule on its own (profileReviewRefusal): why
   *  this profile can never review here, or null; throws when it cannot
   *  tell. Synchronous; absent means no platform rule applies. */
  profileReviewRefusal?(profileId: string): string | null
  /** See ClaudeReviewDeps.holdProfile. */
  holdProfile(profileId: string, maxAgeMs: number, signal?: AbortSignal): Promise<(() => void) | null>
  /** See ClaudeReviewDeps.recordPreflight. */
  recordPreflight(profileId: string, env: Readonly<Record<string, string>>): void
  /** The executable the version probe would run (absolute), or null. */
  resolveExecutable(): Promise<string | null>
  /** Replaces the real filesystem reads of discovery, for a test. */
  fileStat?: { realpath(p: string): string; stat(p: string): ClaudeFileStat }
  platform?: NodeJS.Platform
  now?(): number
}

const VERSION_TIMEOUT_MS = 10_000

type Refusal = { ok: false; code: AuthFailureCode; message?: string }
const refuse = (code: AuthFailureCode, message?: string): Refusal => ({ ok: false, code, ...(message ? { message } : {}) })

function realFileStat(): { realpath(p: string): string; stat(p: string): ClaudeFileStat } {
  return {
    realpath: (p) => fs.realpathSync.native(p),
    stat: (p) => {
      // bigint: NTFS file ids exceed 2^53; times come back in whole ms.
      const s = fs.statSync(p, { bigint: true })
      return { size: Number(s.size), mtimeMs: Number(s.mtimeMs), ctimeMs: Number(s.ctimeMs), dev: String(s.dev), ino: String(s.ino), isFile: s.isFile() }
    },
  }
}

export function createClaudeReviewLaunch(ports: ClaudeReviewPorts): {
  setup: ProviderSetupOperations
  launch: ProviderLaunchOperations
  review: ProviderReviewOperations
} {
  const platform = ports.platform ?? process.platform
  const files = ports.fileStat ?? realFileStat()
  const discoveryDeps: ClaudeDiscoveryDeps = {
    resolve: () => ports.resolveExecutable(),
    realpath: (p) => files.realpath(p),
    stat: (p) => files.stat(p),
    // `--version` through the runner with the reviewer's own hygiene: no
    // Conductor variable, absolute PATH entries only, no shell.
    runVersion: async (executable) => {
      const env = reviewerEnv(Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')), platform)
      const cmd = ports.commandLine(executable, ['--version'], platform, ports.shellEnv(env, platform))
      if ('refused' in cmd) return cmd
      return ports.run(cmd, { env, timeoutMs: VERSION_TIMEOUT_MS })
    },
    platform,
    now: () => (ports.now ? ports.now() : Date.now()),
  }

  // What discovery last proved. A re-check clears it while it runs and a
  // failed check leaves it clear; overlapping checks keep the newest.
  let proven: ClaudeDiscovery | null = null
  let generation = 0
  const discover = async (): Promise<ClaudeDiscovery> => {
    const mine = ++generation
    proven = null
    const r = await discoverClaude(discoveryDeps)
    if (mine === generation) proven = r.state === 'found' ? r : null
    return r
  }

  /** The executable a launch runs: the proven one, re-verified now. Claude
   *  Code replaces itself on update, so a changed file is proved again (a
   *  fresh discovery, with the version floor) rather than run unproven --
   *  and rather than refused until a setup screen this release does not
   *  have. What runs is always a file this package has just proved. */
  const currentExecutable = async (): Promise<{ ok: true; executable: string } | Refusal> => {
    const p = proven
    if (p?.identity && claudeCompatibilityAllowsUse(p.compatibility)) {
      const v = await verifyClaudeExecutable(p.identity, discoveryDeps)
      if (v.ok) return v
    }
    const again = await discover()
    if (again.state !== 'found' || !again.executable) return refuse('cli-unavailable', `Claude Code is not available for reviews: ${again.detail ?? 'it was not found'}.`)
    if (!claudeCompatibilityAllowsUse(again.compatibility)) {
      return refuse('cli-unavailable', `Claude Code ${again.version ?? ''} is older than ${CLAUDE_MIN_MANAGED_CLI_VERSION}, the oldest version reviews run on. Update Claude Code, then try again.`)
    }
    return { ok: true, executable: again.executable }
  }

  /** The profile behind a realm: a live Claude profile-home realm whose
   *  reference names a valid profile id, else null. */
  const profileOfRecord = (r: AuthRealm): string | null => {
    if (r.kind !== 'claude-config-home' || typeof r.pathRef !== 'string' || !r.pathRef.startsWith(CLAUDE_PROFILE_PATH_REF_PREFIX)) return null
    const id = r.pathRef.slice(CLAUDE_PROFILE_PATH_REF_PREFIX.length)
    return isValidProfileId(id) ? id : null
  }
  const profileOf = async (realm: RealmRef): Promise<string | null> => {
    let found: Awaited<ReturnType<ClaudeReviewPorts['lookupRealm']>>
    try { found = await ports.lookupRealm({ authRealmId: realm.authRealmId }) } catch { return null }
    if (!found || found.ok !== true || !found.realm) return null
    return profileOfRecord(found.realm)
  }

  return {
    // Nothing to install through the app yet: the capability stays unknown.
    setup: { discover, installRecipes: () => [] },
    launch: {
      kinds: ['review'],
      async prepare(realm: RealmRef): Promise<LaunchPreparation | Refusal> {
        try {
          const profileId = await profileOf(realm)
          if (!profileId) return refuse('realm-unavailable')
          const exe = await currentExecutable()
          if (!exe.ok) return exe
          const l = ports.profileRealmLaunch(profileId)
          if ('refused' in l) return refuse('realm-unavailable', l.refused)
          return { ok: true, home: l.home, executable: exe.executable, baseEnv: l.baseEnv, realmEnv: l.realmEnv, sessionsDir: l.sessionsDir }
        } catch {
          return refuse('not-started')
        }
      },
      // The platform rule alone, for the accounts service's offer and choice.
      // A record that names no profile is left to `prepare`, which refuses it.
      // A rule that cannot tell throws through: the service refuses to offer
      // on it but never clears a choice because of it.
      reviewRefusal(realm: AuthRealm): string | null {
        const profileId = profileOfRecord(realm)
        if (!profileId || !ports.profileReviewRefusal) return null
        return ports.profileReviewRefusal(profileId)
      },
      // A reviewer persists no transcript (--no-session-persistence), and
      // Claude sessions do not launch here: nothing for the usage index.
      async sessionsDir(): Promise<string | null> { return null },
    },
    review: createClaudeReviewOperations({
      platform,
      profileOf,
      holdProfile: (profileId, maxAgeMs, signal) => ports.holdProfile(profileId, maxAgeMs, signal),
      recordPreflight: (profileId, env) => { try { ports.recordPreflight(profileId, env) } catch { /* diagnostic only */ } },
      commandLine: (e, a, p, s) => ports.commandLine(e, a, p, s),
      shellEnv: (e, p) => ports.shellEnv(e, p),
      run: (c, o) => ports.run(c, o),
    }),
  }
}
