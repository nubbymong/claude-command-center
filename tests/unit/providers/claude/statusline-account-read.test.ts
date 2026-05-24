import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('statusline bridge script -- account read', () => {
  const scriptText = readFileSync(
    join(__dirname, '../../../../src/main/providers/claude/statusline.ts'),
    'utf-8',
  )

  it('reads ~/.claude.json:oauthAccount.emailAddress', () => {
    expect(scriptText).toMatch(/\.claude\.json/)
    expect(scriptText).toMatch(/oauthAccount/)
    expect(scriptText).toMatch(/emailAddress/)
  })

  it('applies a 5MB defensive size cap', () => {
    expect(scriptText).toMatch(/5\s*\*\s*1024\s*\*\s*1024/)
  })

  it('attaches accountEmail to the status payload', () => {
    expect(scriptText).toMatch(/accountEmail/)
  })

  it('swallows identity-read errors (try/catch wraps the read)', () => {
    expect(scriptText).toMatch(/try\s*{[\s\S]*claudeJsonPath[\s\S]*}\s*catch/)
  })
})
