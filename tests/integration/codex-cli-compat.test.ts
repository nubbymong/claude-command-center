// HOST QUARANTINE: this file starts the real `codex` found on PATH (when one is
// there), so it runs in CI and on the VM, never on the owner's workstation.
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { codexCommandLine } from '../../src/main/providers/codex'
import { compatProbeEnv, withCompatHome } from './codex-cli-compat-env'

/**
 * P7.7.9 -- CI flag-drift integration test.
 *
 * Background: P7.7.6 was triggered by Codex CLI 0.128.0 removing
 * `--ask-for-approval` from `codex exec`. We had no automated signal --
 * the only catch was manual smoke. This file spawns the real codex
 * binary and asserts every flag the Codex reviewer passes (WP2 commit 5a:
 * the `review` operation of src/main/providers/codex/cli-runner.ts, run by
 * src/main/providers/codex/review.ts) is still listed in `codex exec --help`.
 *
 * Behaviour when codex is not on PATH: SKIP (do not fail). CI runners
 * without Codex installed pass this suite trivially -- the regression
 * signal fires on dev machines + the pre-release smoke environment.
 *
 * PR 4 VM checkpoint (F4): the run of codex gets a fresh, empty Codex folder
 * of its own (CODEX_HOME), under the app's allowlisted Codex environment, so
 * no Codex or OpenAI variable of the caller reaches it and nothing is read
 * from or written into the user's own ~/.codex; the folder is removed after
 * the run by its own temp-folder prefix (codex-cli-compat-env.ts, checked
 * without starting anything by codex-cli-compat-env.test.ts).
 */

function codexOnPath(): string | null {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(which, ['codex'], { encoding: 'utf-8', timeout: 3_000 })
    const first = out.split('\n')[0].trim()
    return first || null
  } catch {
    return null
  }
}

type HelpResult = { ok: true; text: string } | { ok: false; reason: string }

function codexExecHelp(): HelpResult {
  // `codex exec --help` -- some platforms ship the binary as a .cmd shim
  // (Windows npm-installed). This test-only probe resolves it with a shell
  // and a constant argv; the product runs a shim through an absolute cmd.exe
  // (cli-runner.ts codexCommandLine).
  const useShell = process.platform === 'win32'
  return withCompatHome((home): HelpResult => {
    const result = spawnSync('codex', ['exec', '--help'], {
      encoding: 'utf-8',
      timeout: 10_000,
      shell: useShell,
      env: compatProbeEnv(process.env, home),
    })
    if (result.error) return { ok: false, reason: 'spawn failed: ' + result.error.message }
    if (result.status !== 0) return { ok: false, reason: `exit ${result.status}: ${result.stderr}` }
    if (!result.stdout) return { ok: false, reason: 'empty stdout' }
    return { ok: true, text: result.stdout }
  })
}

const haveCodex = codexOnPath() !== null
const maybeIt = haveCodex ? it : it.skip

describe('integration: codex CLI flag compatibility', () => {
  // Capture --help once per file so the assertions share one spawn.
  let helpText = ''
  let helpReason = ''
  if (haveCodex) {
    const result = codexExecHelp()
    if (result.ok) helpText = result.text
    else helpReason = result.reason
  }

  maybeIt('codex exec --help responds successfully', () => {
    expect(helpText, helpReason).not.toBe('')
  })

  // The reviewer's argv, taken from the product rather than restated here.
  const reviewArgv = (() => {
    const cmd = codexCommandLine('/opt/codex/codex', 'review', 'linux', {})
    if ('refused' in cmd) throw new Error(cmd.refused)
    return cmd.args
  })()

  maybeIt('reads the request from stdin when the prompt is "-" (the reviewer never puts it in argv)', () => {
    expect(reviewArgv[reviewArgv.length - 1]).toBe('-')
    expect(helpText).toMatch(/\[PROMPT\]|<PROMPT>/)
    expect(helpText).toMatch(/read from stdin/)
  })

  maybeIt('lists every flag the reviewer passes', () => {
    for (const flag of reviewArgv.filter((x) => /^--?[a-z]/.test(x))) {
      expect(helpText, flag).toMatch(new RegExp('(^|[\\s,])' + flag + '\\b', 'm'))
    }
  })

  maybeIt('exposes -s/--sandbox <SANDBOX_MODE> with read-only', () => {
    expect(reviewArgv.join(' ')).toContain('--sandbox read-only')
    expect(helpText).toMatch(/--sandbox <SANDBOX_MODE>/)
    expect(helpText).toMatch(/read-only/)
  })

  maybeIt('does NOT expose --ask-for-approval (removed in CLI 0.128.0)', () => {
    // Regression guard for P7.7.6. If a future codex release restores the
    // flag we should re-evaluate whether to pass it -- but until then any
    // unconditional argv inclusion would crash exec on 0.128.0+.
    expect(helpText).not.toMatch(/--ask-for-approval/)
  })

  if (!haveCodex) {
    it.skip('codex not on PATH -- skipping flag-drift suite', () => { /* skipped */ })
  }
})
