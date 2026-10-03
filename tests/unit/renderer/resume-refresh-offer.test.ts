// @vitest-environment jsdom
// P3.5, the C item "Resume replaces the tab list": the resume prompt's
// Refresh re-reads the saved file, which the autosave has meanwhile rewritten
// with the tabs launched while the prompt was open. Offering those again made
// Resume bring back a second copy of a running tab. Refresh now offers only
// saved tabs that are not open, and keeps its list when that leaves nothing.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { refreshRestoreOffer } from '../../../src/renderer/session-persistence'
import type { SessionState } from '../../../src/renderer/types/electron'

const state = (ids: string[]): SessionState => ({ sessions: ids.map((id) => ({ id, label: id })) as SessionState['sessions'], activeSessionId: ids[0] ?? null, savedAt: 1 })

describe('refreshRestoreOffer', () => {
  it('offers the saved tabs that are not already open', () => {
    const out = refreshRestoreOffer(state(['a']), state(['a', 'b', 'live']), new Set(['live']))
    expect(out?.sessions.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('keeps the list it had when the re-read holds nothing else to offer', () => {
    const prev = state(['a', 'b'])
    expect(refreshRestoreOffer(prev, state(['live']), new Set(['live']))).toBe(prev)
    expect(refreshRestoreOffer(prev, state([]), new Set())).toBe(prev)
    expect(refreshRestoreOffer(prev, null, new Set())).toBe(prev)
  })

  it('once the prompt is answered, a late re-read brings nothing back', () => {
    expect(refreshRestoreOffer(null, state(['a']), new Set())).toBeNull()
  })

  it('the prompt\'s Refresh offers through it, with the tabs open now (source wiring)', () => {
    const app = readFileSync(join(__dirname, '../../../src/renderer/App.tsx'), 'utf8')
    expect(app).toContain('const open = new Set(useSessionStore.getState().sessions.map((s) => s.id))')
    expect(app).toContain('setPendingRestore((prev) => refreshRestoreOffer(prev, saved, open))')
  })
})
