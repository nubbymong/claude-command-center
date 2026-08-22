import { describe, it, expect } from 'vitest'
import { assertSafeArgv } from '../../src/main/claude-headless'
import { buildKpiSpawnArgs } from '../../src/main/insights-runner'
import { buildCrossAccountSpawnArgs } from '../../src/main/insights-cross-account'

// Regression guard for the MAJOR finding from the adversarial pass on PR #206:
// `spawnClaudeHeadless` uses `shell: true`, so argv is concatenated into a shell
// command line WITHOUT quoting, and the safety property lived only in comments
// 500 lines away. The attacker demonstrated all three payloads below against a
// real echo shim on cmd.exe and `sh -c`.
//
// The previous tests walked the two STATIC arrays and asserted no element was
// empty or contained whitespace. They could not fail for a dynamic argument and
// did not run at the sink. This one runs at the sink.

describe('assertSafeArgv', () => {
  it('accepts the argv every real call site passes', () => {
    expect(() => assertSafeArgv(buildKpiSpawnArgs())).not.toThrow()
    expect(() => assertSafeArgv(buildCrossAccountSpawnArgs())).not.toThrow()
    expect(() => assertSafeArgv(['--version'])).not.toThrow()
    expect(() => assertSafeArgv(['-p', '--model', 'sonnet', '--output-format', 'json'])).not.toThrow()
  })

  it('rejects the empty argument that silently shifts every later flag', () => {
    // Demonstrated: ['-p','--tools','','--output-format','json'] arrives as
    // `--tools --output-format json`, so --tools swallows --output-format.
    expect(() => assertSafeArgv(['-p', '--tools', '', '--output-format', 'json'])).toThrow(/empty argv element/)
  })

  it('rejects cmd.exe command chaining', () => {
    // Demonstrated: cmd.exe ran `echo PWNED_AMP` as a second command.
    expect(() => assertSafeArgv(['-p', '--settings', 'x&echo PWNED'])).toThrow(/unsafe argv element/)
  })

  it('rejects the POSIX metacharacters that are inert on Windows', () => {
    // `sh -c` executed the `;` payload and substituted `$(...)` and `*` before
    // claude ever ran. A Windows-only character class would pass CI and be a no-op.
    for (const payload of ['x;echo PWNED', '$(echo PWNED)', '`echo PWNED`', '*.sh', '~/x']) {
      expect(() => assertSafeArgv(['-p', '--settings', payload]), payload).toThrow(/unsafe argv element/)
    }
  })

  it('rejects the Windows metacharacters that are inert on POSIX', () => {
    // cmd.exe splices %VAR% from the environment into the command line and then
    // re-parses the expanded value's own metacharacters.
    for (const payload of ['%CCC_PROBE%', 'a|b', 'a>out', 'a^b']) {
      expect(() => assertSafeArgv(['-p', '--settings', payload]), payload).toThrow(/unsafe argv element/)
    }
  })

  it('rejects a value containing a space, however innocent', () => {
    // The most likely real mistake: passing a JSON blob or a path with a space.
    expect(() => assertSafeArgv(['-p', '--settings', '{"a": 1}'])).toThrow()
    expect(() => assertSafeArgv(['-p', '--add-dir', 'C:\\Program Files\\x'])).toThrow()
  })

  it('names the offending value so the error is actionable', () => {
    expect(() => assertSafeArgv(['-p', 'a&b'])).toThrow(/"a&b"/)
  })

  it('rejects the glob CHARACTER CLASS brackets — the 1M model id (#144/#385)', () => {
    // `[1m]` is a POSIX glob character class. This path spawns with shell:true
    // and cannot quote its argv, so a bracketed model id must be refused here
    // rather than silently glob-expanded (under zsh: "no matches found",
    // aborting the whole command). Every other --model emitter quotes instead.
    for (const payload of ['opus[1m]', 'claude-opus-4-6[1m]', 'claude-opus-5[1m]']) {
      expect(() => assertSafeArgv(['-p', '--model', payload]), payload).toThrow(/unsafe argv element/)
    }
    // Either bracket alone is enough to make the shell treat it as a pattern.
    expect(() => assertSafeArgv(['-p', 'a[b'])).toThrow(/unsafe argv element/)
    expect(() => assertSafeArgv(['-p', 'a]b'])).toThrow(/unsafe argv element/)
  })

  it('still accepts the plain model ids this path actually passes', () => {
    // Guards the inverse mistake: widening the class until legitimate argv
    // stops working. These are the values the Sentinel analysis pass sends.
    expect(() => assertSafeArgv(['-p', '--model', 'sonnet', '--output-format', 'json'])).not.toThrow()
    expect(() => assertSafeArgv(['--version'])).not.toThrow()
    expect(() => assertSafeArgv(['-p', '--model', 'claude-opus-4-6'])).not.toThrow()
  })
})
