// tests/unit/statusline-local-bridge-delivery.test.ts
// FUNCTIONAL proof of the local-unification slice: run the DEPLOYED bridge
// script under a real `node`, feed it claude-shaped stdin, and assert the
// delivery ladder — POST to the /status URL when one is given (no file
// written), fall back to the per-session status file when the POST cannot
// land (refused port) or no URL was baked. String assertions live in
// statusline-account-cache.test.ts; this file proves the script actually
// behaves, not merely contains the right substrings.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import * as http from 'http'
import { AddressInfo } from 'net'

import { deployClaudeStatuslineScript } from '../../src/main/providers/claude/statusline'

const STDIN_PAYLOAD = JSON.stringify({
  session_id: 'claude-own-uuid',
  model: { id: 'claude-fable-5', display_name: 'Fable' },
  context_window: { used_percentage: 40, remaining_percentage: 60, context_window_size: 200000, current_usage: { input_tokens: 100, output_tokens: 5 } },
  cost: { total_cost_usd: 0.5 },
  rate_limits: { five_hour: { used_percentage: 12, resets_at: 1767000000 }, seven_day: { used_percentage: 34, resets_at: 1767600000 } },
})

/** Run the deployed bridge: node <script> <sid> [url], HOME sandboxed so the
 *  gather finds no account/credentials and returns immediately. */
function runBridge(scriptPath: string, sandboxHome: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome }
    delete env.CCC_STATUS_URL
    delete env.CLAUDE_MULTI_SESSION_ID
    const child = spawn(process.execPath, [scriptPath, ...args], { env })
    let stdout = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout }))
    child.stdin.write(STDIN_PAYLOAD)
    child.stdin.end()
  })
}

describe('local statusline bridge: real delivery ladder', () => {
  let resDir: string
  let sandboxHome: string
  let scriptPath: string
  let statusDir: string

  beforeAll(async () => {
    resDir = mkdtempSync(join(tmpdir(), 'ccc-bridge-run-'))
    sandboxHome = mkdtempSync(join(tmpdir(), 'ccc-bridge-home-'))
    await deployClaudeStatuslineScript(resDir)
    scriptPath = join(resDir, 'scripts', 'claude-multi-statusline.js')
    statusDir = join(resDir, 'status')
  })

  afterAll(() => {
    try { rmSync(resDir, { recursive: true, force: true }) } catch {}
    try { rmSync(sandboxHome, { recursive: true, force: true }) } catch {}
  })

  it('POSTs the payload to the /status URL and writes NO status file', async () => {
    const received: Array<{ url: string; body: string }> = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        received.push({ url: req.url ?? '', body })
        res.writeHead(204)
        res.end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    try {
      const url = `http://127.0.0.1:${port}/status?cccSessionId=sid-post&token=t0k`
      const { code, stdout } = await runBridge(scriptPath, sandboxHome, ['sid-post', url])
      expect(code).toBe(0)
      expect(stdout).toBe(' ') // statusline display suppressed
      expect(received).toHaveLength(1)
      expect(received[0].url).toContain('/status?cccSessionId=sid-post')
      const posted = JSON.parse(received[0].body)
      expect(posted.sessionId).toBe('sid-post') // argv[2] beats stdin session_id
      expect(posted.model).toBe('Fable')
      expect(posted.rateLimitCurrent).toBe(12) // stdin rate_limits applied
      expect(posted.rateLimitWeekly).toBe(34)
      // POST succeeded ⇒ no fallback file
      expect(existsSync(join(statusDir, 'sid-post.json'))).toBe(false)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('falls back to the status file when the POST is refused', async () => {
    // Grab a port that is closed: bind, note it, close it again.
    const probe = http.createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const deadPort = (probe.address() as AddressInfo).port
    await new Promise<void>((r) => probe.close(() => r()))

    const url = `http://127.0.0.1:${deadPort}/status?cccSessionId=sid-fall&token=t0k`
    const { code, stdout } = await runBridge(scriptPath, sandboxHome, ['sid-fall', url])
    expect(code).toBe(0)
    expect(stdout).toBe(' ')
    const file = join(statusDir, 'sid-fall.json')
    expect(existsSync(file)).toBe(true)
    const written = JSON.parse(readFileSync(file, 'utf-8'))
    expect(written.sessionId).toBe('sid-fall')
    expect(written.rateLimitCurrent).toBe(12)
  })

  it('writes the status file when no URL is baked (legacy sessions)', async () => {
    const { code, stdout } = await runBridge(scriptPath, sandboxHome, ['sid-legacy'])
    expect(code).toBe(0)
    expect(stdout).toBe(' ')
    const file = join(statusDir, 'sid-legacy.json')
    expect(existsSync(file)).toBe(true)
    const written = JSON.parse(readFileSync(file, 'utf-8'))
    expect(written.sessionId).toBe('sid-legacy')
    // Sanity: the two delivery tests wrote exactly their own files.
    expect(readdirSync(statusDir).sort()).toEqual(['sid-fall.json', 'sid-legacy.json'])
  })
})
