// #261 — where a dev instance keeps Electron's sessionData.
//
// `persist:` partitions live under `sessionData`, which defaults to `userData`.
// Nothing redirected either, so a DEV instance wrote the per-account claude.ai web
// sessions (#216) into the same `%APPDATA%\claude-conductor\Partitions` a PROD
// install uses. Consequences observed on a real machine: dev and prod shared the
// session, signing out in dev revoked prod's, and `ccc --clean` wiped the dev data
// dir while leaving a live sessionKey on disk because the partition was never
// under it.
import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'

vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../src/main/registry', () => ({ readRegistry: () => null, writeRegistry: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => 'C:/fake/userData', isPackaged: true } }))

const { devSessionDataDir } = await import('../../src/main/data-paths')

describe('devSessionDataDir', () => {
  it('returns null for a packaged build, so prod keeps Electron’s default', () => {
    // The whole point of scoping this to dev: moving prod's partitions would log
    // out everyone who already signed in on a build that created one there.
    expect(devSessionDataDir({ CCC_DEV_DATA_DIR: 'C:/data/dev' }, true)).toBeNull()
  })

  it('puts dev session data under the dev data root', () => {
    expect(devSessionDataDir({ CCC_DEV_DATA_DIR: 'C:/data/dev' }, false))
      .toBe(join('C:/data/dev', 'session'))
  })

  it('returns null when there is no dev override rather than guessing a path', () => {
    expect(devSessionDataDir({}, false)).toBeNull()
  })

  it('covers E2E too, and prefers it over the dev dir', () => {
    // An E2E run's data root is disposable; a partition outside it would survive
    // the teardown that is supposed to remove it.
    expect(devSessionDataDir({ CCC_E2E_DATA_DIR: 'C:/tmp/e2e', CCC_DEV_DATA_DIR: 'C:/data/dev' }, false))
      .toBe(join('C:/tmp/e2e', 'session'))
  })

  it('is a SUBDIRECTORY of the data root, so --clean removes it', () => {
    // `ccc --clean` deletes the dev data dir wholesale. The session dir has to be
    // inside it for that to clear the web sessions, which is the bug being fixed.
    const root = 'C:/data/dev'
    const got = devSessionDataDir({ CCC_DEV_DATA_DIR: root }, false)!
    // Separator-normalised: `join` yields backslashes on Windows and forward
    // slashes elsewhere, and the containment claim is about the path, not its
    // spelling.
    const norm = (s: string): string => s.replace(/\\/g, '/')
    expect(norm(got).startsWith(norm(root) + '/')).toBe(true)
    expect(norm(got)).not.toBe(norm(root))   // not the root itself: Electron writes into it
  })

  it('ignores an empty override rather than treating it as a root', () => {
    expect(devSessionDataDir({ CCC_DEV_DATA_DIR: '' }, false)).toBeNull()
  })

  it('REFUSES a relative root instead of half-applying the redirect', () => {
    // `app.setPath` rejects a relative path, but the caller mkdirSync's first — so
    // a relative root quietly created `<cwd>/<root>/session` (inside the repo, in
    // one observed run) and then setPath threw into a catch, leaving dev writing
    // claude.ai sessionKeys to prod's location exactly as before the fix.
    expect(devSessionDataDir({ CCC_DEV_DATA_DIR: 'relative/dev' }, false)).toBeNull()
    expect(devSessionDataDir({ CCC_DEV_DATA_DIR: './dev' }, false)).toBeNull()
    expect(devSessionDataDir({ CCC_E2E_DATA_DIR: 'tmp/e2e' }, false)).toBeNull()
  })

  it('honours an explicit E2E root even on a packaged build', () => {
    // Matches getDataDirectory's own ordering, which checks CCC_E2E_DATA_DIR
    // unconditionally. An explicit E2E override is never a real user's install,
    // so `isPackaged` is not the question — and without this, an E2E run against a
    // packaged exe would send its data to a disposable root while leaving the
    // claude.ai partition in prod's %APPDATA%, surviving teardown.
    expect(devSessionDataDir({ CCC_E2E_DATA_DIR: 'C:/tmp/e2e' }, true))
      .toBe(join('C:/tmp/e2e', 'session'))
    // A packaged build with only the DEV var set is still left alone.
    expect(devSessionDataDir({ CCC_DEV_DATA_DIR: 'C:/data/dev' }, true)).toBeNull()
  })
})
