import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HooksGateway } from '../../../src/main/hooks/hooks-gateway'
import { injectHooks } from '../../../src/main/hooks/session-hooks-writer'

function claudeOnPath(): string | null {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(which, ['claude'], { encoding: 'utf-8', timeout: 3_000 })
    const first = out.split('\n')[0].trim()
    return first || null
  } catch {
    return null
  }
}

function supportsSettingsFlag(claude: string): boolean {
  try {
    const help = execFileSync(claude, ['--help'], { encoding: 'utf-8', timeout: 5_000 })
    return /--settings/.test(help)
  } catch {
    return false
  }
}

/**
 * Real-Claude end-to-end. Gated on an explicit opt-in env var because:
 *
 * 1. Claude Code's `--print` mode doesn't always invoke tools in response
 *    to a prompt (the model may answer conversationally without calling
 *    Read even when asked), so the assertion is environmentally flaky.
 * 2. The test spends ~30-60s burning API tokens on every CI run.
 *
 * Set `RUN_REAL_CLAUDE_HOOKS_TEST=1` to enable — useful before cutting a
 * beta release. Otherwise this suite is a no-op.
 */
describe('integration: real Claude Code', () => {
  const envOptIn = process.env.RUN_REAL_CLAUDE_HOOKS_TEST === '1'
  const claude = envOptIn ? claudeOnPath() : null
  const canRun = envOptIn && claude !== null && supportsSettingsFlag(claude)
  const maybeIt = canRun ? it : it.skip

  let gw: HooksGateway | null = null
  let tmpDir = ''

  afterEach(async () => {
    await gw?.stop()
    gw = null
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      tmpDir = ''
    }
  })

  maybeIt('hooks fire for a Read tool call under --print + --settings', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-real-'))
    const settingsFile = path.join(tmpDir, 'settings-real-test.json')
    const events: Array<{ channel: string; payload: { event?: string } }> = []
    gw = new HooksGateway({
      emit: (c, p) => events.push({ channel: c, payload: p as { event?: string } }),
      defaultPort: 0,
    })
    await gw.start()
    const secret = gw.registerSession('real-test')
    injectHooks({
      sessionId: 'real-test',
      settingsPath: settingsFile,
      port: gw.status().port!,
      secret,
    })

    const child = spawn(
      claude!,
      ['--print', '--settings', settingsFile, 'Use the Read tool to read package.json. Then stop.'],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = '', stderr = ''
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })

    const done = new Promise<void>((resolve) => child.on('close', () => resolve()))
    await Promise.race([done, new Promise<void>((r) => setTimeout(r, 60_000))])
    child.kill('SIGKILL')

    const pre = events.filter((e) => e.channel === 'hooks:event' && e.payload.event === 'PreToolUse')
    const post = events.filter((e) => e.channel === 'hooks:event' && e.payload.event === 'PostToolUse')
    if (pre.length === 0 || post.length === 0) {
      // Dump claude's output so a flaky run is actually diagnosable.
      console.error('[real-claude] stdout:', stdout.slice(0, 2000))
      console.error('[real-claude] stderr:', stderr.slice(0, 2000))
    }
    expect(pre.length).toBeGreaterThan(0)
    expect(post.length).toBeGreaterThan(0)
  }, 65_000)
})
