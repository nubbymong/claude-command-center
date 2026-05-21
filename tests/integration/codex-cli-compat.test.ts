import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'

/**
 * P7.7.9 -- CI flag-drift integration test.
 *
 * Background: P7.7.6 was triggered by Codex CLI 0.128.0 removing
 * `--ask-for-approval` from `codex exec`. We had no automated signal --
 * the only catch was manual smoke. This file spawns the real codex
 * binary and asserts every flag we depend on in `buildArgv`
 * (src/main/codex-review-mcp-tool.ts) is still listed in `codex exec --help`.
 *
 * Behaviour when codex is not on PATH: SKIP (do not fail). CI runners
 * without Codex installed pass this suite trivially -- the regression
 * signal fires on dev machines + the pre-release smoke environment.
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

function codexExecHelp(): { ok: true; text: string } | { ok: false; reason: string } {
  // `codex exec --help` -- some platforms ship the binary as a .cmd shim
  // (Windows npm-installed). spawnSync with shell:true mirrors how
  // runCodexStreaming spawns the binary in production code (Windows .cmd
  // paths require cmd.exe wrapping).
  const useShell = process.platform === 'win32'
  const result = spawnSync('codex', ['exec', '--help'], {
    encoding: 'utf-8',
    timeout: 10_000,
    shell: useShell,
  })
  if (result.error) return { ok: false, reason: 'spawn failed: ' + result.error.message }
  if (result.status !== 0) return { ok: false, reason: `exit ${result.status}: ${result.stderr}` }
  if (!result.stdout) return { ok: false, reason: 'empty stdout' }
  return { ok: true, text: result.stdout }
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

  maybeIt('accepts a trailing positional [PROMPT] argument', () => {
    // buildArgv pushes the constructed prompt as the final positional arg
    // (codex-review-mcp-tool.ts: argv.push(prompt)). If a future codex release
    // moves to a --prompt flag or stdin-only mode every named-flag assertion
    // below could still match while production calls silently break.
    expect(helpText).toMatch(/\[PROMPT\]|<PROMPT>/)
  })

  maybeIt('exposes --json (JSONL events flag we parse for token_count)', () => {
    expect(helpText).toMatch(/--json\b/)
  })

  maybeIt('exposes -o/--output-last-message <FILE> (tmpfile capture)', () => {
    expect(helpText).toMatch(/--output-last-message <FILE>/)
  })

  maybeIt('exposes --ephemeral (no rollout persistence)', () => {
    expect(helpText).toMatch(/--ephemeral\b/)
  })

  maybeIt('exposes --skip-git-repo-check (P7.7.9 guard surfaces this earlier)', () => {
    expect(helpText).toMatch(/--skip-git-repo-check\b/)
  })

  maybeIt('exposes -s/--sandbox <SANDBOX_MODE> with read-only', () => {
    expect(helpText).toMatch(/--sandbox <SANDBOX_MODE>/)
    expect(helpText).toMatch(/read-only/)
  })

  maybeIt('exposes -C/--cd <DIR>', () => {
    expect(helpText).toMatch(/-C,\s*--cd <DIR>/)
  })

  maybeIt('exposes -m/--model <MODEL>', () => {
    expect(helpText).toMatch(/-m,\s*--model <MODEL>/)
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
