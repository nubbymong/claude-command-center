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
//    before the usage handlers are registered;
//  - the status poller is handed the accounts service's change subscription
//    (its side: provider-on-now.test.ts).
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
    // P3.2: the same call also wires the sessions-only in-use check for a
    // Claude profile (legacyRecordInUse).
    expect(code).toMatch(/initProviderAccounts\(\{\s*unleasedSessions: \(id\) => providerUseWithoutLease\(id\),/)
    expect(code).toMatch(/legacyRecordInUse: \(id, legacyId\) => id === 'claude' && sessionsOnProfile\(legacyId\)\.length > 0,/)
  })

  // Usage track MP3 (D5): the Account usage page reads nothing of Claude Code
  // while it is off. The rule is handed to the usage module before the usage
  // handlers are registered, so no request can be served on the default.
  it('the Claude usage gate is handed the launch rule, before the usage handlers register', () => {
    // P3.2: with the folder rule the recorder checks a figure against.
    expect(code).toMatch(/import \{ recordLiveUsageForSession, setClaudeAccountDataAllowed, setLiveUsageTranscriptProfile \} from '\.\/usage\/account-usage'/)
    const wired = code.indexOf("setClaudeAccountDataAllowed(() => providerProbeRefusal('claude') === null)")
    const registered = code.indexOf('registerAccountProfilesHandlers(getWindow)')
    expect(wired).toBeGreaterThan(-1)
    expect(registered).toBeGreaterThan(-1)
    expect(wired).toBeLessThan(registered)
    expect(code.split('setClaudeAccountDataAllowed(').length).toBe(2)
  })

  it('the version probe is handed the launch rule, before the probe at start', () => {
    const wired = code.indexOf("setClaudeCliProbeAllowed(() => providerProbeRefusal('claude') === null)")
    const probed = code.indexOf('void probeClaudeCliVersion()')
    expect(wired).toBeGreaterThan(-1)
    expect(probed).toBeGreaterThan(-1)
    expect(wired).toBeLessThan(probed)
  })

  // P3.4 ADR-009 round (G3; gate 3, S2 F1): the status poller is handed the
  // accounts service's change subscription, so a switch made there (not a
  // settings save) reaches the poller at once.
  it('the status poller is handed the accounts service change subscription', () => {
    expect(code).toMatch(/startServiceStatusPoller\(getWindow, \{\s*providerOn: providerOnNow,\s*subscribe: \(listener\) => getAccountsService\(\)\?\.subscribe\(listener\) \?\? \(\(\) => \{\}\),\s*\}\)/)
  })
})
