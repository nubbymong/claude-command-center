// The renderer names a CCC session's remote tmux session (the Resume card's
// kill-session hint) with the shared tmuxSessionName / tmuxExactTarget. They
// must name exactly the session main creates: main's safeSid (ssh-tmux.ts) is
// the rule, so the two are compared here on ids that need sanitising.
import { describe, it, expect } from 'vitest'
import { tmuxSessionName, tmuxExactTarget } from '../../../src/shared/ssh-tmux-persistence'
import { safeSid } from '../../../src/main/ssh-tmux'

const IDS = ['det-1', 'abc_DEF-123', 'det 1;x$y', "it's", 'a/b\\c', '=ccc-evil', 'tab\there', `uni${String.fromCharCode(0xe9)}code`, '']

describe('tmuxSessionName / tmuxExactTarget', () => {
  it('names the same tmux session main creates (ccc-<safeSid>)', () => {
    for (const id of IDS) expect(tmuxSessionName(id), JSON.stringify(id)).toBe(`ccc-${safeSid(id)}`)
  })

  it('the exact target is =ccc-<safeSid> in single quotes, and nothing a shell would expand survives inside them', () => {
    expect(tmuxExactTarget('det-1')).toBe("'=ccc-det-1'")
    expect(tmuxExactTarget('det 1;x$y')).toBe("'=ccc-det_1_x_y'")
    for (const id of IDS) expect(tmuxExactTarget(id), JSON.stringify(id)).toMatch(/^'=ccc-[A-Za-z0-9_-]*'$/)
  })
})
