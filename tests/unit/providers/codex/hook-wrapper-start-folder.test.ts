// P3.10 round 3b: the Codex hook wrapper (scripts/ccc-codex-hook.cmd)
// resolves node from the PATH the same way from any start folder.
//
// HOST QUARANTINE: this suite writes a temp directory and starts processes
// (cmd.exe and node). It runs in CI and on the VM, never on the owner's
// workstation. It starts no Codex and no Claude Code.
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const IS_WIN = process.platform === 'win32'
const PREFIX = 'ccc-hook-wrapper-folder-'
const made: string[] = []

afterAll(() => {
  // TEST CLEANUP GUARD: only this suite's own folders, by their prefix and parent.
  const tmpReal = fs.realpathSync.native(os.tmpdir())
  for (const d of made.splice(0)) {
    if (path.basename(d).startsWith(PREFIX) && path.dirname(d) === tmpReal) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
})

/** Run the shipped wrapper from a start folder that holds `<name>.cmd`. */
function runFrom(name: 'node' | 'where'): { top: string; work: string; status: number | null; output: string } {
  const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  made.push(top)
  const scripts = path.join(top, 'scripts')
  const work = path.join(top, 'work')
  fs.mkdirSync(scripts)
  fs.mkdirSync(work)
  fs.copyFileSync(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'ccc-codex-hook.cmd'), path.join(scripts, 'ccc-codex-hook.cmd'))
  // The stand-in forwarder: records which node ran it, in the suite's own folder.
  fs.writeFileSync(
    path.join(scripts, 'ccc-codex-hook.js'),
    "require('fs').writeFileSync(require('path').join(__dirname, '..', 'forwarder-ran'), process.execPath)\n",
  )
  // The file in the start folder: leaves a marker there when it runs.
  fs.writeFileSync(path.join(work, `${name}.cmd`), `@echo off\r\necho ran> "%~dp0${name}-marker"\r\nexit /b 0\r\n`)
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue
    // Not in the environment here: the wrapper sets it itself. No hook file
    // and no session either, and the PATH is set below.
    if (/^(NoDefaultCurrentDirectoryInExePath|CCC_CODEX_HOOK_FILE|CLAUDE_MULTI_SESSION_ID|PATH)$/i.test(k)) continue
    env[k] = v
  }
  env.PATH = [path.dirname(process.execPath), path.join(systemRoot, 'System32')].join(';')
  const r = spawnSync(path.join(systemRoot, 'System32', 'cmd.exe'), ['/d', '/c', path.join(scripts, 'ccc-codex-hook.cmd')], {
    cwd: work, env, encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { top, work, status: r.status, output: `${r.stdout}\n${r.stderr}` }
}

describe.runIf(IS_WIN)('the wrapper resolves node the same way from any start folder (P3.10 round 3b)', () => {
  for (const name of ['node', 'where'] as const) {
    it(`resolves node from the PATH with a ${name}.cmd in its start folder`, () => {
      const r = runFrom(name)
      expect(r.status, r.output).toBe(0)
      expect(fs.existsSync(path.join(r.work, `${name}-marker`)), `the start folder's ${name}.cmd ran`).toBe(false)
      expect(fs.existsSync(path.join(r.top, 'forwarder-ran')), 'the forwarder did not run').toBe(true)
      expect(fs.readFileSync(path.join(r.top, 'forwarder-ran'), 'utf8').toLowerCase()).toBe(process.execPath.toLowerCase())
    })
  }
})
