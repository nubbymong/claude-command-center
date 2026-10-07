// PR 4 (owner answers review, E-Q10): Sentinel's check reads the shared
// "could not reach" words as plain text. A rewording that held a character a
// regular expression treats specially (a dot, brackets, a question mark) must
// still match only itself, at word edges. The shared words are swapped for
// such a wording here. [host]
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/shared/sentinel-analysis-contract', () => ({ ANALYSIS_UNREACHABLE_WORDS: 'got no route (to) its host?' }))

const { envelopeError } = await import('../../src/main/sentinel/sentinel-analysis')
const reason = (result: string) => envelopeError(JSON.stringify({ is_error: true, result }))

describe('the shared words are matched as plain text (owner answers review)', () => {
  it('the words themselves, at word edges, count as unreachable [host]', () => {
    expect(reason('Claude Code got no route (to) its host? (5 tries)')?.unreachable).toBe(true)
    expect(reason('got no route (to) its host?')?.unreachable).toBe(true)
  })

  it('what the characters would mean in a pattern does not count [host]', () => {
    expect(reason('Claude Code got no route to its host')?.unreachable).toBe(false)
    expect(reason('Claude Code got no route to its hos')?.unreachable).toBe(false)
    expect(reason('Claude Code xgot no route (to) its host?')?.unreachable).toBe(false)
  })
})
