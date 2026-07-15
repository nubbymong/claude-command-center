import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { detectCodexUi } from '../../../../src/main/providers/codex/ui-detection'

const trace = readFileSync(
  join(__dirname, '../../../fixtures/codex/tui-trace.txt'),
  'utf-8',
)

describe('detectCodexUi', () => {
  it('matches the real Codex TUI capture (first 500 bytes)', () => {
    expect(detectCodexUi(trace.slice(0, 500))).toBe(true)
  })

  it('matches anywhere in the captured trace', () => {
    expect(detectCodexUi(trace)).toBe(true)
  })

  it('does not match a plain bash prompt', () => {
    expect(detectCodexUi('user@host:~$ ')).toBe(false)
  })

  it('does not match a plain cmd.exe prompt', () => {
    expect(detectCodexUi('C:\\Users\\nicho>')).toBe(false)
  })

  it('does not match a plain powershell prompt', () => {
    expect(detectCodexUi('PS C:\\Users\\nicho> ')).toBe(false)
  })

  it('matches synchronized-output mode in isolation', () => {
    expect(detectCodexUi('\x1b[?2026h')).toBe(true)
    expect(detectCodexUi('\x1b[?2026l')).toBe(true)
  })

  it('matches focus-tracking mode in isolation', () => {
    expect(detectCodexUi('\x1b[?1004h')).toBe(true)
  })
})
