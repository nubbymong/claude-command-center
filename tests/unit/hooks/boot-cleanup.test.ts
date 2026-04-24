import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { cleanupStaleHookEntries } from '../../../src/main/hooks/boot-cleanup'

describe('cleanupStaleHookEntries', () => {
  let fakeHome = ''
  let claudeDir = ''
  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-bootclean-'))
    claudeDir = path.join(fakeHome, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome)
  })
  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('removes hooks from stale sid files', () => {
    const f = path.join(claudeDir, 'settings-dead-sid.json')
    fs.writeFileSync(
      f,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { type: 'http', url: 'http://localhost:19334/hook/dead-sid' },
          ],
        },
      }),
    )
    const n = cleanupStaleHookEntries(new Set<string>())
    expect(n).toBe(1)
    const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'))
    expect(parsed.hooks).toBeUndefined()
  })

  it('leaves active sid files alone', () => {
    const f = path.join(claudeDir, 'settings-live-sid.json')
    fs.writeFileSync(
      f,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { type: 'http', url: 'http://localhost:19334/hook/live-sid' },
          ],
        },
      }),
    )
    const n = cleanupStaleHookEntries(new Set(['live-sid']))
    expect(n).toBe(0)
    const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'))
    expect(parsed.hooks).toBeDefined()
  })

  it('ignores settings files with no hooks block', () => {
    const f = path.join(claudeDir, 'settings-other.json')
    fs.writeFileSync(f, JSON.stringify({ statusLine: 'x' }))
    expect(cleanupStaleHookEntries(new Set())).toBe(0)
  })

  it('ignores settings files whose hooks do not reference /hook/', () => {
    const f = path.join(claudeDir, 'settings-foreign.json')
    fs.writeFileSync(
      f,
      JSON.stringify({ hooks: { PreToolUse: [{ type: 'command', command: 'echo' }] } }),
    )
    expect(cleanupStaleHookEntries(new Set())).toBe(0)
  })

  it('ignores .bak sibling files (regex non-greedy)', () => {
    const f = path.join(claudeDir, 'settings-backup.json.bak')
    fs.writeFileSync(f, JSON.stringify({ hooks: { X: [{ url: '/hook/x' }] } }))
    expect(cleanupStaleHookEntries(new Set())).toBe(0)
    expect(fs.existsSync(f)).toBe(true)
  })

  it('returns 0 when ~/.claude does not exist', () => {
    fs.rmSync(claudeDir, { recursive: true, force: true })
    expect(cleanupStaleHookEntries(new Set())).toBe(0)
  })
})
