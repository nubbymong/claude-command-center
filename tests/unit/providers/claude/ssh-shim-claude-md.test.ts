// Regression (mirror of the local vision-manager fix): the SSH remote setup
// program must NEVER unlinkSync the remote ~/.claude/CLAUDE.md. If stripping the
// legacy VISION-INSTRUCTIONS marker empties it, write an empty file instead.
import { describe, it, expect } from 'vitest'
import { generateRemoteSetupScript } from '../../../../src/main/providers/claude/ssh-shim'

describe('generateRemoteSetupScript -- remote CLAUDE.md handling', () => {
  it('never unlinks the remote CLAUDE.md; writes empty when the strip empties it', () => {
    const script = generateRemoteSetupScript('sess-abc', null)
    // The CLAUDE.md cleanup is still present...
    expect(script).toContain("path.join(claudeDir,'CLAUDE.md')")
    // ...but it must not delete the user's file...
    expect(script).not.toContain('unlinkSync')
    // ...it writes an empty string instead when nothing remains.
    expect(script).toContain("fs.writeFileSync(md,c?c+'\\n':'')")
  })
})
