import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

import { SHIM_GATHER_JS } from '../../../../src/main/providers/claude/statusline-gather'

// The account read moved from the local bridge's own body into the SHARED
// gather snippet (statusline-gather.ts) in the harmonise-remote local-
// unification slice — one source embedded by the local bridge AND both SSH
// shims. These assertions pin the read itself on the shared snippet, and that
// the local bridge actually embeds it.
describe('statusline bridge script -- account read (shared gather)', () => {
  it('reads ~/.claude.json:oauthAccount.emailAddress', () => {
    expect(SHIM_GATHER_JS).toMatch(/\.claude\.json/)
    expect(SHIM_GATHER_JS).toMatch(/oauthAccount/)
    expect(SHIM_GATHER_JS).toMatch(/emailAddress/)
  })

  it('applies a 5MB defensive size cap', () => {
    expect(SHIM_GATHER_JS).toMatch(/5\s*\*\s*1024\s*\*\s*1024/)
  })

  it('attaches accountEmail to the status payload', () => {
    expect(SHIM_GATHER_JS).toMatch(/s\.accountEmail\s*=/)
  })

  it('swallows identity-read errors (try/catch wraps the read)', () => {
    expect(SHIM_GATHER_JS).toMatch(/try\{var cj=[\s\S]*?\}catch\(eA\)\{\}/)
  })

  it('the LOCAL bridge embeds the shared gather (no bespoke account read left)', () => {
    const localSource = readFileSync(
      join(__dirname, '../../../../src/main/providers/claude/statusline.ts'),
      'utf-8',
    )
    expect(localSource).toContain('${SHIM_GATHER_JS}')
    expect(localSource).not.toContain('claudeJsonPath')
  })
})
