// SEC-BATCH FLAG (2026-08-14): the per-session settings clone unions CCC's
// own Agent Canvas tools into permissions.allow so the render->review loop
// doesn't stall in approval prompts (the VM transcript lost 11 minutes to
// one). The tests pin the ADDITIVE contract: user entries survive, deny/ask
// are never touched, malformed shapes are left exactly as found, and nothing
// is injected when the flag is off.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { writeLocalSessionSettings } from '../../../src/main/hooks/per-session-settings'

const CANVAS_TOOLS = [
  'mcp__conductor__canvas_render',
  'mcp__conductor__canvas_snapshot',
  'mcp__conductor__canvas_review',
]

describe('writeLocalSessionSettings -- canvas tool pre-allow', () => {
  let fakeHome = ''
  let claudeDir = ''
  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'per-session-ca-'))
    claudeDir = path.join(fakeHome, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome)
  })
  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const sharedPath = () => path.join(claudeDir, 'settings.json')

  it('creates permissions.allow with exactly the canvas tools when none exist', () => {
    const p = writeLocalSessionSettings('sid-1', { allowCanvasTools: true })
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(cfg.permissions.allow).toEqual(CANVAS_TOOLS)
  })

  it('unions with the user allow list, dedupes, and never touches deny/ask', () => {
    fs.writeFileSync(
      sharedPath(),
      JSON.stringify({
        permissions: {
          allow: ['Bash(npm run *)', 'mcp__conductor__canvas_render'],
          deny: ['mcp__conductor__vision_eval'],
          ask: ['WebFetch'],
        },
      }),
    )
    const p = writeLocalSessionSettings('sid-2', { allowCanvasTools: true })
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(cfg.permissions.allow).toEqual([
      'Bash(npm run *)',
      'mcp__conductor__canvas_render',
      'mcp__conductor__canvas_snapshot',
      'mcp__conductor__canvas_review',
    ])
    expect(cfg.permissions.deny).toEqual(['mcp__conductor__vision_eval'])
    expect(cfg.permissions.ask).toEqual(['WebFetch'])
  })

  it('leaves a malformed permissions value exactly as found', () => {
    fs.writeFileSync(sharedPath(), JSON.stringify({ permissions: 'defaultMode-typo' }))
    const p = writeLocalSessionSettings('sid-3', { allowCanvasTools: true })
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(cfg.permissions).toBe('defaultMode-typo')
  })

  it('leaves a malformed allow value exactly as found (never repaired into shape)', () => {
    fs.writeFileSync(sharedPath(), JSON.stringify({ permissions: { allow: 'not-a-list', deny: [] } }))
    const p = writeLocalSessionSettings('sid-4', { allowCanvasTools: true })
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(cfg.permissions).toEqual({ allow: 'not-a-list', deny: [] })
  })

  it('injects nothing when the flag is off', () => {
    const p = writeLocalSessionSettings('sid-5', {})
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(cfg.permissions).toBeUndefined()
  })
})
