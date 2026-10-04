/**
 * account-archive-hooks.ts: work that must happen BEFORE an account is
 * archived, registered at start (WP2 PR 4, P4.6, row 58).
 *
 * The accounts service (provider core) archives an account; what else an
 * account holds is not core's to know. A Codex account's chatgpt.com web
 * session is one such thing: it must be cleared first, and a clear that fails
 * must refuse the archive (Claude's account delete is the precedent). The
 * service calls prepareAccountArchive with the account and its provider; the
 * owners of such state register a hook here at start (index.ts). Provider
 * neutral, and zero dependencies, so provider core reaches nothing concrete
 * through it.
 *
 * A hook resolves to an optional release, run once the archive has settled
 * (archived or refused). A hook that rejects refuses the archive: the hooks
 * that already ran are released and the error is rethrown.
 *
 * No default export (project convention).
 */

export type BeforeAccountArchive = (accountId: string, providerId: string) => Promise<(() => void) | void>

const hooks: BeforeAccountArchive[] = []

/** Register a hook (once per function). */
export function onBeforeAccountArchive(hook: BeforeAccountArchive): void {
  if (!hooks.includes(hook)) hooks.push(hook)
}

/**
 * Run every hook, in registration order. Resolves to one release for all of
 * them; rejects (after releasing the ones that ran) when any hook rejects.
 */
export async function prepareAccountArchive(accountId: string, providerId: string): Promise<() => void> {
  const releases: Array<() => void> = []
  const releaseAll = (): void => {
    for (const release of releases.splice(0).reverse()) {
      try { release() } catch { /* one release must not stop the rest */ }
    }
  }
  for (const hook of [...hooks]) {
    try {
      const release = await hook(accountId, providerId)
      if (typeof release === 'function') releases.push(release)
    } catch (err) {
      releaseAll()
      throw err
    }
  }
  return releaseAll
}

/** Tests only: drop every hook. */
export function _resetAccountArchiveHooksForTest(): void {
  hooks.length = 0
}
