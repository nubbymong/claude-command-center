// WP2 PR 4 review fix pass (A1-Q2): the two Claude provider operations the app
// reaches with `?.` -- the boot heal of the global statusLine stanza and the
// statusline delivery to a session's subscribers -- are pinned at the provider:
// a no-op body or a broken delegation fails here, where typecheck cannot see it
// (both members are optional on SessionProvider). [host] The heal's helper is
// a spy (nothing reads or writes any home folder); the delivery runs on the
// package's in-memory subscriber registry.
import { describe, it, expect, vi } from 'vitest'

const heal = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('../../../src/main/providers/claude/statusline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/providers/claude/statusline')>()),
  healGlobalStatusline: (...args: unknown[]) => { heal.calls.push(args) },
}))

const { ClaudeProvider } = await import('../../../src/main/providers/claude')

describe('the Claude provider\'s statusline operations delegate to the package [host]', () => {
  it('healGlobalStatusline runs the package\'s heal once, with its own default folder', () => {
    new ClaudeProvider().healGlobalStatusline()
    expect(heal.calls).toEqual([[]])
  })

  it('deliverStatusline reaches exactly the session\'s subscribers made by ingestSessionTelemetry, and stops when they stop', () => {
    const p = new ClaudeProvider()
    const got: unknown[] = []
    const sub = p.ingestSessionTelemetry('sid-deliver-1', { cwd: '.', spawnTimestamp: 0 }, (d) => { got.push(d) })
    p.deliverStatusline({ sessionId: 'sid-deliver-1', model: 'm' } as never)
    p.deliverStatusline({ sessionId: 'sid-deliver-other', model: 'm' } as never)
    expect(got).toEqual([expect.objectContaining({ sessionId: 'sid-deliver-1', model: 'm' })])
    sub.stop()
    p.deliverStatusline({ sessionId: 'sid-deliver-1', model: 'n' } as never)
    expect(got).toHaveLength(1)
  })
})
