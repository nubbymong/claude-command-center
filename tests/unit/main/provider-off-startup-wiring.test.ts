/// <reference types="vite/client" />
// WP2: two start-up wirings in main (index.ts) that the provider-off rules
// depend on, each tested on its own side (provider-in-use.test.ts,
// claude-cli-version-provider-off.test.ts); this pins that main makes them:
//
//  - the accounts service's switch-off rule counts everything that runs a
//    provider's CLI without a lease (provider-in-use.ts), not only sessions;
//  - the Claude CLI version probe is handed main's launch rule, so it does
//    not run while Claude Code is switched off -- and is handed it BEFORE the
//    probe at start runs;
//  - the Claude usage gate (usage track MP3, D5) is handed the same rule
//    before the usage handlers are registered.
import { describe, it, expect } from 'vitest'
import indexSource from '../../../src/main/index.ts?raw'

/** The source with its comments removed, so a commented-out line fails. */
const code = indexSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n')

describe('provider-off start-up wiring', () => {
  it('the switch-off rule counts what runs without a lease (provider-in-use.ts)', () => {
    expect(code).toMatch(/import \{ providerUseWithoutLease \} from '\.\/provider-in-use'/)
    expect(code).toMatch(/initProviderAccounts\(\{ unleasedSessions: \(id\) => providerUseWithoutLease\(id\) \}\)/)
  })

  // Usage track MP3 (D5): the Account usage page reads nothing of Claude Code
  // while it is off. The rule is handed to the usage module before the usage
  // handlers are registered, so no request can be served on the default.
  it('the Claude usage gate is handed the launch rule, before the usage handlers register', () => {
    expect(code).toMatch(/import \{ recordLiveUsageForSession, setClaudeUsageAllowed \} from '\.\/usage\/account-usage'/)
    const wired = code.indexOf("setClaudeUsageAllowed(() => providerProbeRefusal('claude') === null)")
    const registered = code.indexOf('registerAccountProfilesHandlers()')
    expect(wired).toBeGreaterThan(-1)
    expect(registered).toBeGreaterThan(-1)
    expect(wired).toBeLessThan(registered)
    expect(code.split('setClaudeUsageAllowed(').length).toBe(2)
  })

  it('the version probe is handed the launch rule, before the probe at start', () => {
    const wired = code.indexOf("setClaudeCliProbeAllowed(() => providerProbeRefusal('claude') === null)")
    const probed = code.indexOf('void probeClaudeCliVersion()')
    expect(wired).toBeGreaterThan(-1)
    expect(probed).toBeGreaterThan(-1)
    expect(wired).toBeLessThan(probed)
  })
})
