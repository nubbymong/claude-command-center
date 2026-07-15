// U2 (2c): boot-heal for installs that already have the global statusLine stanza
// + the planted ~/.claude/claude-multi-statusline.js from a prior version. Strip
// OUR stanza (never a user's own) and delete the legacy script. DI'd on claudeDir.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// getResourcesDirectory is unused by healGlobalStatusline, but statusline.ts
// imports it at module load -- mock it so importing the module is side-effect free.
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: vi.fn(() => ''),
}))

import { healGlobalStatusline } from '../../../../src/main/providers/claude/statusline'

describe('healGlobalStatusline', () => {
  let claudeDir = ''
  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-heal-'))
  })
  afterEach(() => {
    fs.rmSync(claudeDir, { recursive: true, force: true })
  })

  it('strips a global statusLine stanza that points at our script (keeps other keys)', () => {
    const sp = path.join(claudeDir, 'settings.json')
    fs.writeFileSync(
      sp,
      JSON.stringify({
        statusLine: { type: 'command', command: 'node "/x/scripts/claude-multi-statusline.js"' },
        outputStyle: 'concise',
      }),
    )
    healGlobalStatusline(claudeDir)
    const s = JSON.parse(fs.readFileSync(sp, 'utf-8'))
    expect(s.statusLine).toBeUndefined()
    expect(s.outputStyle).toBe('concise')
  })

  it('preserves a user-owned statusLine', () => {
    const sp = path.join(claudeDir, 'settings.json')
    fs.writeFileSync(sp, JSON.stringify({ statusLine: { type: 'command', command: 'my-own-line.sh' } }))
    healGlobalStatusline(claudeDir)
    const s = JSON.parse(fs.readFileSync(sp, 'utf-8'))
    expect(s.statusLine?.command).toBe('my-own-line.sh')
  })

  it('deletes the legacy planted claude-multi-statusline.js', () => {
    const script = path.join(claudeDir, 'claude-multi-statusline.js')
    fs.writeFileSync(script, '// legacy')
    healGlobalStatusline(claudeDir)
    expect(fs.existsSync(script)).toBe(false)
  })
})
