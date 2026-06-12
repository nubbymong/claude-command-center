// Live CCC sessions running in a memory project: a local session whose cwd
// mangles to the same canonical projectDir (spec §4.3). SSH sessions have no
// usable local cwd.
import { mangleCwdToProjectDir } from '../../../shared/project-key'

// Field names mirror the REAL Session interface (sessionStore.ts:23,24,33 —
// `label` is the display name) so callers pass sessions straight through.
export interface LiveSessionLite { id: string; label: string; workingDirectory: string; sessionType: string }

export function liveSessionsForProject<T extends LiveSessionLite>(sessions: T[], projectDir: string): T[] {
  return sessions.filter(
    (s) => s.sessionType === 'local' && !!s.workingDirectory
      && mangleCwdToProjectDir(s.workingDirectory) === projectDir,
  )
}
