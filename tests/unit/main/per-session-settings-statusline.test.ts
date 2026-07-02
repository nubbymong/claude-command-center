// U2 (2a): CCC must deliver its statusLine PER-SESSION (in ~/.claude/settings-<sid>.json)
// rather than via a global ~/.claude/settings.json write. writeLocalSessionSettings
// injects the statusLine command (pointing at the bundled resources script) and
// overrides any statusLine inherited from the shared-settings clone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { writeLocalSessionSettings } from '../../../src/main/hooks/per-session-settings'

describe('writeLocalSessionSettings -- per-session statusLine', () => {
  let fakeHome = ''
  let claudeDir = ''
  const resourcesDir = () => path.join(fakeHome, 'res')
  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'per-session-sl-'))
    claudeDir = path.join(fakeHome, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome)
  })
  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('injects a statusLine command pointing at the bundled script when resourcesDir is given', () => {
    const p = writeLocalSessionSettings('sid-1', { resourcesDir: resourcesDir() })
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(cfg.statusLine?.type).toBe('command')
    expect(cfg.statusLine?.command).toContain('claude-multi-statusline.js')
    expect(String(cfg.statusLine?.command).startsWith('node ')).toBe(true)
  })

  it('overrides any statusLine inherited from the shared-settings clone (and keeps other keys)', () => {
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: 'GLOBAL_PLACEHOLDER' },
        outputStyle: 'concise',
      }),
    )
    const p = writeLocalSessionSettings('sid-2', { resourcesDir: resourcesDir() })
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(cfg.statusLine?.command).not.toBe('GLOBAL_PLACEHOLDER')
    expect(cfg.statusLine?.command).toContain('claude-multi-statusline.js')
    expect(cfg.outputStyle).toBe('concise')
  })

  it('does not inject a statusLine when no resourcesDir is provided', () => {
    const p = writeLocalSessionSettings('sid-3', {})
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(cfg.statusLine).toBeUndefined()
  })
})
