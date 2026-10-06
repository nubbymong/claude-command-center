// WP1.29 / WP1.51 / WP1.22 -- WP2 commit 3 (design 9.2, 12): a seeded API key
// is driven through every sign-in path the accounts service has -- success,
// a hostile CLI that echoes it, a refused handle, a second deposit, an
// invalid key, a cancelled run, a failed one -- and then every surface that
// retains anything is searched for it: the registry file, every snapshot,
// every result, every sign-in output line, the service log, the main log,
// every CLI argv and environment. The only place the key may appear is the
// one-shot stdin of the one sign-in run it was meant for.
//
// PURE.
import { describe, it, expect, vi } from 'vitest'
import { logError, logInfo, logWarn } from '../../src/main/debug-logger'
import { harness, KEY } from './accounts-harness'

/** Any 16-character window of the key (a secret split or spliced by output
 *  is still found), and the key itself. */
function leaks(text: string, key = KEY): string[] {
  const out: string[] = []
  for (let i = 0; i + 16 <= key.length; i++) if (text.includes(key.slice(i, i + 16))) out.push(key.slice(i, i + 16))
  return out
}

describe('a seeded API key never lands anywhere it could be read back (WP1.29, WP1.51)', () => {
  it('across success, a hostile echo, refusals, a cancel and a failure', async () => {
    for (const logger of [logError, logInfo, logWarn]) vi.mocked(logger).mockClear()
    let cancelNext = false
    let failNext = false
    const h = await harness({
      script: {
        'login --with-api-key': (r) => {
          const stdin = r.opts.stdin ?? ''
          // Echo it back whole, split across writes, and inside an escape.
          r.opts.onOutput?.(`echo: ${stdin}`, 'stdout')
          r.opts.onOutput?.(`part ${stdin.slice(0, 20)}`, 'stderr')
          r.opts.onOutput?.(`${stdin.slice(20)} end\n`, 'stderr')
          r.opts.onOutput?.(`\u001b]0;${stdin.trim()}\u0007\n`, 'stdout')
          if (cancelNext) return { spawnError: 'cancelled', stopped: 'cancel' }
          if (failNext) return { exitCode: 1, stderr: `error: bad key ${stdin.trim()}\n` }
          h.signedIn.set(r.home.toLowerCase(), 'api-key')
          return { exitCode: 0 }
        },
      },
    })
    const results: unknown[] = []
    const output: string[] = []
    const snapshots: unknown[] = []
    const record = <T>(r: T): T => { results.push(r); snapshots.push(h.service.snapshot()); return r }

    const setup = async () => {
      const b = record(await h.service.beginSetup({ providerId: 'codex', method: 'apiKey' }))
      return (b as { accountId: string }).accountId
    }
    const handleFor = (accountId: string, sender = 1) => {
      const i = record(h.service.issueSecretHandle({ accountId }, sender))
      return (i as { handle: string }).handle
    }

    // 1. A hostile CLI that echoes the key, then success.
    const a = await setup()
    let handle = handleFor(a)
    h.service.depositSecret(handle, 1, KEY)
    record(await h.service.signIn({ accountId: a, method: 'apiKey', secretHandle: handle }, 1, (t) => output.push(t)))
    record(await h.service.completeSetup({ accountId: a, identity: { mode: 'new', friendlyName: 'Seeded', colourKey: 'violet' } }))

    // 2. A handle for another setup; a second deposit; an invalid key.
    const b = await setup()
    handle = handleFor(a)
    h.service.depositSecret(handle, 1, KEY)
    record(await h.service.signIn({ accountId: b, method: 'apiKey', secretHandle: handle }, 1, (t) => output.push(t)))
    handle = handleFor(b)
    h.service.depositSecret(handle, 1, KEY)
    h.service.depositSecret(handle, 1, KEY)
    record(await h.service.signIn({ accountId: b, method: 'apiKey', secretHandle: handle }, 1, (t) => output.push(t)))
    handle = handleFor(b)
    h.service.depositSecret(handle, 1, `${KEY.slice(0, 20)}\n${KEY.slice(20)}`)
    record(await h.service.signIn({ accountId: b, method: 'apiKey', secretHandle: handle }, 1, (t) => output.push(t)))

    // 3. A cancelled run, and a failed one that prints the key in its error.
    for (const mode of ['cancel', 'fail'] as const) {
      cancelNext = mode === 'cancel'
      failNext = mode === 'fail'
      handle = handleFor(b)
      h.service.depositSecret(handle, 1, KEY)
      record(await h.service.signIn({ accountId: b, method: 'apiKey', secretHandle: handle }, 1, (t) => output.push(t)))
    }

    // 4. A renderer that went away with a deposited handle.
    handle = handleFor(b, 5)
    h.service.depositSecret(handle, 5, KEY)
    h.service.releaseRenderer(5)
    expect(h.secrets.take(handle)).toBeNull()

    const loginRuns = h.runs.filter((r) => r.args === 'login --with-api-key')
    expect(loginRuns.length).toBe(3)
    // The key reached the CLI only on stdin, only on the runs it was for.
    for (const r of h.runs) {
      expect(leaks(r.args), `argv of ${r.args}`).toEqual([])
      expect(leaks(JSON.stringify(r.env)), `env of ${r.args}`).toEqual([])
      if (r.args !== 'login --with-api-key') expect(r.opts.stdin, r.args).toBeUndefined()
      else expect(r.opts.stdin).toBe(`${KEY}\n`)
    }
    const mainLog = [logError, logInfo, logWarn].flatMap((l) => vi.mocked(l).mock.calls.map((c) => c.map(String).join(' ')))
    const surfaces: Record<string, string> = {
      'registry file': h.port.file ?? '',
      'results': JSON.stringify(results),
      'snapshots': JSON.stringify(snapshots),
      'sign-in output': output.join('\n'),
      'service log': h.logs.join('\n'),
      'main log': mainLog.join('\n'),
      'leases': JSON.stringify(h.service.consumersOf(a)),
    }
    for (const [name, text] of Object.entries(surfaces)) expect(leaks(text), name).toEqual([])
    // The output was shown, redacted -- not swallowed.
    expect(output.join('')).toContain('echo:')
    expect(h.secrets.size()).toBe(0)
  })
})
