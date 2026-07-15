import type { SessionGitHubIntegration } from '../../shared/github-types'

/**
 * Minimal session shape the helper needs. Defined locally instead of importing
 * the full Session type so the helper is easy to call from tests without
 * having to construct unrelated session fields.
 */
export interface AutoDetectAcceptSession {
  id: string
  configId?: string
  githubIntegration?: SessionGitHubIntegration
}

/**
 * Minimal profile shape -- mirrors useGitHubStore profiles but kept local so
 * tests don't have to pull the full AuthProfile (with createdAt, scopes, etc).
 */
export interface AutoDetectAcceptProfile {
  id: string
  username: string
  allowedRepos?: string[]
}

export interface AutoDetectAcceptDeps {
  /**
   * Subset of window.electronAPI we touch. Typed loose so tests can pass a
   * minimal stub without recreating the full electron.d.ts surface.
   */
  electronAPI: {
    github: {
      updateSessionConfig: (
        sessionId: string,
        patch: Partial<SessionGitHubIntegration>,
      ) => Promise<{ ok: boolean; error?: string }>
    }
  }
  /** Mirror onto the live session in the renderer store. */
  updateSession: (
    id: string,
    patch: { githubIntegration: SessionGitHubIntegration },
  ) => void
  /**
   * Mirror onto the parent CONFIG so re-spawned sessions inherit the setup.
   * Bug #436: previously this write was missing and the GH repo selection
   * was forgotten across app restarts.
   */
  updateConfig: (
    id: string,
    patch: { githubIntegration: SessionGitHubIntegration },
  ) => void
  profiles: ReadonlyArray<AutoDetectAcceptProfile>
  /**
   * Called only when no profiles exist, to send the user to Settings so they
   * can sign in. Bug #437: previously this fired unconditionally even when
   * the user was already authed.
   */
  navigateToGitHubSettings: () => void
  /**
   * Flush the renderer session store to disk (session-state.json) so the
   * main-side updateSessionConfig handler can look the session up. Bug #441:
   * freshly-spawned sessions weren't on disk yet, so the IPC returned
   * { ok: false, error: 'not-found' } and the c56f7da bail then suppressed
   * both the store mirror and the unauthed-only nav fallback -- the click
   * looked like a no-op. Mirrors the pattern already used by
   * SessionGitHubConfig.tsx's save() (the same handler is also called there).
   * Returns true on success, false on failure; failure aborts the IPC call.
   */
  flushSessionState: () => Promise<boolean>
}

/**
 * Picks a profile to auto-assign based on the slug owner. Mirrors the intent
 * of SessionGitHubConfig.tsx's auto-match useEffect (the comment there says
 * "allowedRepos takes priority over username because fine-grained PATs are
 * scoped per repo, not per owner") but does it as a two-pass scan so the
 * priority is real -- the form's single find() with an OR was first-match
 * wins, which would let a username-only profile listed earlier in the array
 * beat a properly-scoped fine-grained PAT.
 *
 *  - prefer a profile whose allowedRepos contains the exact slug
 *  - else a profile whose username matches the slug owner (case-insensitive)
 *  - else undefined -- capability routing handles the no-match path
 */
export function pickProfileIdForSlug(
  slug: string,
  profiles: ReadonlyArray<AutoDetectAcceptProfile>,
): string | undefined {
  if (!slug) return undefined
  const [owner] = slug.split('/')
  const scoped = profiles.find((p) => p.allowedRepos?.includes(slug))
  if (scoped) return scoped.id
  const byUsername = profiles.find(
    (p) => p.username.toLowerCase() === owner.toLowerCase(),
  )
  return byUsername?.id
}

/**
 * Handles the "Use this repo" click on the AutoDetectBanner.
 *
 * Behaviour:
 *  - Writes the detected repo to BOTH the session AND the parent config
 *    (#436 fix: parent config write was missing -- selection was lost on
 *    restart because re-spawned sessions inherit from the config, not from
 *    the previous SavedSession's mirror).
 *  - If at least one auth profile exists, auto-enable the integration and
 *    auto-pick a profile by slug owner, then STAY on the session view
 *    (#437 fix: previously routed to Settings even when authed).
 *  - If no profiles exist, route to GitHub Settings so the user can sign in
 *    (today's behaviour for the unauthed path).
 *
 * The patch is best-effort: if the IPC write throws, we still navigate the
 * unauthed user to Settings so they can configure manually. Losing the write
 * is fine; losing the navigation would be worse.
 */
export async function handleAutoDetectAccept(
  slug: string,
  session: AutoDetectAcceptSession,
  deps: AutoDetectAcceptDeps,
): Promise<void> {
  const hasAuth = deps.profiles.length > 0
  const basePatch: Partial<SessionGitHubIntegration> = {
    repoUrl: `https://github.com/${slug}`,
    repoSlug: slug,
    autoDetected: true,
  }
  // Authed path: also flip enabled on + pick a profile so the integration is
  // live without an extra trip through Settings.
  const patch: Partial<SessionGitHubIntegration> = hasAuth
    ? {
        ...basePatch,
        enabled: true,
        authProfileId: pickProfileIdForSlug(slug, deps.profiles),
      }
    : basePatch

  const prior = session.githubIntegration ?? { enabled: false, autoDetected: false }
  const merged: SessionGitHubIntegration = { ...prior, ...patch }

  // #441: Flush the renderer session store to disk BEFORE the IPC, so the
  // main-side handler can find the row in sessions[]. Without this step the
  // IPC returns ok:false for newly-spawned sessions and the ok:false bail
  // (c56f7da) suppresses everything -- the classic "click does nothing"
  // symptom. Same pattern as SessionGitHubConfig.tsx's save() flow.
  let flushed = false
  try {
    flushed = await deps.flushSessionState()
  } catch {
    flushed = false
  }
  if (!flushed) {
    // eslint-disable-next-line no-console
    console.warn(
      `[github] auto-detect accept aborted: flush=false ok=false error=flush-failed`,
    )
    // Unauthed users still get routed to Settings so they can finish setup
    // manually -- mirrors the pre-existing unauthed-fallback behaviour on
    // IPC failure. Authed users stay put and the next click retries.
    if (!hasAuth) deps.navigateToGitHubSettings()
    return
  }

  try {
    const res = await deps.electronAPI.github.updateSessionConfig(session.id, patch)
    if (!res.ok) {
      // Flush succeeded but the main-side write still failed -- this is now
      // a real persistence error (not the unflushed-session race that #441
      // fixed). Do NOT mirror to the stores: that would desync in-memory
      // state from disk. Unauthed users still get routed to Settings so
      // they can finish setup manually; authed users stay put for retry.
      // eslint-disable-next-line no-console
      console.warn(
        `[github] auto-detect accept aborted: flush=true ok=false error=${res.error ?? 'unknown'}`,
      )
      if (!hasAuth) deps.navigateToGitHubSettings()
      return
    }
    deps.updateSession(session.id, { githubIntegration: merged })
    if (session.configId) {
      deps.updateConfig(session.configId, { githubIntegration: merged })
    }
  } catch (err) {
    // Swallow IPC errors. The unauthed user still gets routed to Settings
    // below so they can finish setup manually. For the authed path there is
    // nothing useful to do here -- the next save attempt will surface a real
    // error to the user. We DO still warn so the authed-path silent no-op
    // (preload TypeError, IPC disconnect, etc.) is observable in devtools --
    // closes the same silent-failure class as the flush=false / ok=false
    // branches above.
    const msg = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.warn(
      `[github] auto-detect accept aborted: flush=true ok=throw error=${msg}`,
    )
  }

  if (!hasAuth) {
    deps.navigateToGitHubSettings()
  }
}
