// P3.9 round 2: Sentinel's Claude Code analysis argv through the REAL
// headless spawner (on Windows Claude Code by the full path found in PATH's
// folders, an npm-style .cmd shim through the system cmd.exe; sh elsewhere)
// into a FAKE `claude` on PATH (an npm-style .cmd shim on Windows). The empty tool list
// and the empty settings-source list are written `--tools=` and
// `--setting-sources=`: each must arrive as ONE argument, and the run must
// start in the folder given with Claude Code's switches set.
//
// HOST QUARANTINE: this suite writes a temp directory and starts processes. It
// runs in CI and on the VM, never on the owner's workstation. It starts no
// real Claude Code.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))
vi.mock('../../src/main/pty-manager', () => ({ withProfileHome: (env: Record<string, string>) => env }))
vi.mock('../../src/main/managed-launch-diagnostics', () => ({ gateManagedLaunch: async () => ({ status: 'clean' }), peekGateVerdict: () => undefined }))
vi.mock('../../src/main/profile-consumers', () => ({ acquireProfileConsumer: () => null, pendingProfileRefresh: () => null }))
vi.mock('../../src/main/profile-id', () => ({ profileIdFromHome: () => null }))

const { spawnClaudeHeadless } = await import('../../src/main/claude-headless')
const { CLAUDE_ANALYSIS_ARGS, CLAUDE_ANALYSIS_ENV } = await import('../../src/main/sentinel/sentinel-analysis')

const IS_WIN = process.platform === 'win32'
const PREFIX = 'ccc-headless-argv-'
let dir = ''
let savedPath: string | undefined
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'

const FAKE = `
const fs = require('fs'), path = require('path')
let stdin = ''
process.stdin.on('data', (d) => { stdin += d })
process.stdin.on('end', () => {
  const env = {}
  for (const k of Object.keys(process.env)) if (/^CLAUDE_CODE_/.test(k)) env[k] = process.env[k]
  fs.writeFileSync(path.join(__dirname, 'rec.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env, stdinLen: stdin.length }))
  process.stdout.write(JSON.stringify({ type: 'result', result: JSON.stringify({ breakingChanges: [] }) }))
})
`

beforeAll(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'fake-claude.js'), FAKE)
  if (IS_WIN) fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "%~dp0fake-claude.js" %*\r\n`)
  else fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(path.join(bin, 'fake-claude.js'))})\n`, { mode: 0o755 })
  savedPath = process.env[PATH_KEY]
  // The fake's folder ALONE: the run looks for claude.exe in every PATH folder
  // before claude.cmd, so with the machine's own PATH after it a real Claude
  // Code installed there would be the one started. The fakes name node by its
  // full path, so they need nothing else on PATH.
  process.env[PATH_KEY] = bin
})
afterAll(() => {
  process.env[PATH_KEY] = savedPath
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (path.basename(dir).startsWith(PREFIX) && path.dirname(dir) === fs.realpathSync.native(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

describe("Sentinel's Claude Code analysis argv through the real spawner (P3.9 round 2)", () => {
  it('arrives whole: --tools= and --setting-sources= are one argument each; the run is in its folder with its switches', async () => {
    const folder = path.join(dir, 'runs', 'ccc-sentinel-claude-a')
    fs.mkdirSync(folder, { recursive: true })
    const res = await spawnClaudeHeadless([...CLAUDE_ANALYSIS_ARGS], 30_000, 'the prompt', null, undefined, { cwd: folder, env: CLAUDE_ANALYSIS_ENV })
    expect(res.code, res.stderr).toBe(0)
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'bin', 'rec.json'), 'utf8')) as { argv: string[]; cwd: string; env: Record<string, string>; stdinLen: number }
    expect(rec.argv).toEqual([...CLAUDE_ANALYSIS_ARGS])
    expect(rec.argv).toContain('--tools=')
    expect(rec.argv).toContain('--setting-sources=')
    expect(fs.realpathSync.native(rec.cwd)).toBe(fs.realpathSync.native(folder))
    expect(rec.env).toMatchObject({ ...CLAUDE_ANALYSIS_ENV })
    expect(rec.stdinLen).toBe('the prompt'.length)
  }, 60_000)
})
