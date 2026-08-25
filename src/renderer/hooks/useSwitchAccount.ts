import { useCallback } from 'react'
import { Session } from '../stores/sessionStore'
import { persistLastUsedAccount } from '../session-persistence'
import { useRestartSession } from './useRestartSession'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { isAccountActive } from '../../shared/account-types'

/**
 * Guard for the mid-session account switch. A switch is only meaningful when
 * the chosen profile differs from the session's current one. `undefined` on
 * either side means "the default account" (no CLAUDE_CONFIG_DIR profile), so
 * undefined<->undefined is a no-op, and a real id replacing undefined (or
 * vice-versa) is a genuine switch.
 */
export function shouldSwitch(
  current: string | undefined,
  next: string | undefined,
): boolean {
  return (current ?? undefined) !== (next ?? undefined)
}

/**
 * Mid-session account switch (locked design: switch = respawn + resume).
 *
 * `CLAUDE_CONFIG_DIR` is read once at process start, so changing account on a
 * live session means: pin the new `profileId` on the session, then RESTART it
 * via the SAME path the Restart control uses. The respawn (TerminalView ->
 * pty.spawn) reads `session.profileId` and exports the matching config dir, and
 * the normal restart resume-picker flow brings the transcript back -- now under
 * the new account. No bespoke PTY teardown or resume logic here.
 *
 * Order matters: updateSession(profileId) MUST precede restart() so the
 * respawn sees the new id. We also pass `{ profileId }` through restart() as an
 * explicit override so the remove/re-add can never race the store update back
 * to the old value.
 */
export function useSwitchAccount(
  session: Session | null | undefined,
): (sessionId: string, newProfileId: string | undefined) => void {
  const { restart } = useRestartSession(session, false)

  return useCallback(
    (sessionId, newProfileId) => {
      if (!session || session.id !== sessionId) return
      // Defense-in-depth (BUG-13): account profiles are LOCAL Claude only, so a
      // Codex (its own login) or SSH (remote host's login) session must never
      // switch a CCC profile -- the surfaces are already gated, this is a backstop.
      // Shell-only panes are refused too: the add-account /login shell is pinned
      // to its new profile, and a switch would redirect the /login elsewhere.
      if ((session.provider ?? 'claude') !== 'claude' || session.sshConfig || session.shellOnly) return
      // 1. No-op when the chosen account is already the active one.
      if (!shouldSwitch(session.profileId, newProfileId)) return
      // 1b. Backstop: never switch TO an account that has been marked inactive.
      //     The switch surfaces already hide/disable it; this guards the hook so
      //     a stale menu or a programmatic call can't slip past. (undefined =>
      //     the default account, which has no profile row and is always allowed.)
      if (newProfileId) {
        const target = useAccountProfilesStore.getState().profiles.find((p) => p.id === newProfileId)
        if (target && !isAccountActive(target)) return
      }
      // 2. Pin the new profile (undefined => default account) AND flush it to disk
      //    eagerly so a crash can't lose the switch. updateSession runs
      //    synchronously inside, before restart() reads session.profileId.
      void persistLastUsedAccount(sessionId, newProfileId)
      // 2b. Refresh the picked account's usage snapshot (#447). The pick is the
      //     one moment we know the user cares about this account's numbers.
      //     `noRefresh` is what makes this SAFE next to the respawn on the next
      //     line (adversarial review): that child spawns onto this same profile,
      //     and a rotating fetch of a lapsed non-primary token would spend the
      //     single-use refresh token the child is about to use and log the
      //     account out — in the window before the child registers as a live
      //     consumer, which is exactly where the in-use guard is blind. With
      //     noRefresh it NEVER rotates: a valid token fetches live, a lapsed one
      //     falls back to the last-known snapshot. Fire-and-forget and
      //     null-guarded (the default account has no profile row); a usage fetch
      //     must never block or fail the switch.
      if (newProfileId) {
        void window.electronAPI.accountUsage.fetchOne(newProfileId, { noRefresh: true }).catch(() => {})
      }
      // 3. Respawn via the existing Restart path, forcing the new profileId so
      //    the remount reads the new account; resume is inherited from Restart.
      restart({ profileId: newProfileId })
    },
    [session, restart],
  )
}
