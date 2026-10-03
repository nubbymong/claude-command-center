// [host] WP2 PR 4, P4.5 review (C-3): at quit, a cloud agent of the second
// provider is stopped BEFORE the pending CLI kills are flushed, so its
// stop's kill is pending when the flush runs and the flush ends its tree. Were
// the stop moved after the flush (or dropped, leaving only killAllAgents()
// later in the teardown), no kill would be flushed and the suite stayed green.
// index.ts cannot be imported in a unit test (it boots the app), so this pins
// the SHAPE of the quit teardown's source, as window-ipc-registered-once does
// for the usage reads.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = readFileSync(resolve(__dirname, '../../../src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The quit teardown's body, comments removed (a call only named in a
 *  comment is not a call). */
function teardownCode(): string {
  const start = src.indexOf('quitTeardown = () => {')
  expect(start, 'the quit teardown').toBeGreaterThanOrEqual(0)
  const end = src.indexOf('\n  }\n', start)
  expect(end, 'the end of the quit teardown').toBeGreaterThan(start)
  return src.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
}

describe('the quit teardown stops background agent runs before it flushes the pending CLI kills', () => {
  it('stopBackgroundAgentRuns() is called, then flushPendingProviderCliKills()', () => {
    const body = teardownCode()
    const stop = body.indexOf('stopBackgroundAgentRuns()')
    const flush = body.indexOf('flushPendingProviderCliKills()')
    expect(stop).toBeGreaterThan(0)
    expect(flush).toBeGreaterThan(stop)
    // Each exactly once: a second flush earlier, or a second stop after the
    // flush, would read as the right order here.
    expect(body.split('stopBackgroundAgentRuns()').length - 1).toBe(1)
    expect(body.split('flushPendingProviderCliKills()').length - 1).toBe(1)
  })

  it('the stop is imported from the cloud agent manager', () => {
    expect(src).toMatch(/import \{[^}]*\bstopBackgroundAgentRuns\b[^}]*\} from '\.\/cloud-agent-manager'/)
  })
})
