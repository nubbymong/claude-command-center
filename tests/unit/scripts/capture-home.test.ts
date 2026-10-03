/**
 * [host] P4.11 (the inventory's blocker for the recapture): the training
 * screenshot tool renamed the running user's REAL `~/.claude/projects` and
 * `~/.codex/sessions` to hide them, and launched the app on the real home.
 * It now gives the app, and every path it seeds, a home of its own inside its
 * throwaway data root: the e2e harness's isolated home (isolated-env.ts),
 * with the capture's own switches. The tool itself launches the app, so it
 * never runs here: this pins the environment builder and reads the script as
 * text to pin that it resolves no path from the real home.
 *
 * Writes only inside a folder this file makes (its own prefix, directly in the
 * temp folder), removed by that prefix and parent alone.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { basename, dirname, join, relative, resolve, isAbsolute } from 'path'
import { tmpdir } from 'os'
import { captureHomeDir, captureLaunchEnv } from '../../../scripts/capture-env'

const PREFIX = 'ccc-test-capture-home-'
const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) if (dirname(d) === tmpdir() && basename(d).startsWith(PREFIX)) rmSync(d, { recursive: true, force: true })
})
const root = (): string => {
  const d = mkdtempSync(join(tmpdir(), PREFIX))
  made.push(d)
  return d
}
const inside = (child: string, parent: string): boolean => {
  const r = relative(parent, child)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}

describe('the capture tool\'s home', () => {
  it('[host] is a folder inside the throwaway data root', () => {
    const r = root()
    expect(inside(captureHomeDir(r), r)).toBe(true)
  })

  it('[host] the launch environment points every home at it, drops the real Claude and Codex folders, and keeps the capture\'s switches', () => {
    const r = root()
    const real = 'C:\\Users\\someone'
    const env = captureLaunchEnv(r, {
      Path: 'x', USERPROFILE: real, HOME: real, userprofile: real,
      CODEX_HOME: join(real, '.codex'), CLAUDE_CONFIG_DIR: join(real, '.claude'), E2E_HEADLESS: '1', NODE_ENV: 'development',
    })
    const home = captureHomeDir(r)
    const named = (n: string) => Object.keys(env).filter((k) => k.toLowerCase() === n.toLowerCase())
    expect(named('USERPROFILE')).toEqual(['USERPROFILE'])
    expect(env.USERPROFILE).toBe(home)
    expect(env.HOME).toBe(home)
    expect(named('CODEX_HOME')).toEqual([])
    expect(named('CLAUDE_CONFIG_DIR')).toEqual([])
    expect(named('E2E_HEADLESS')).toEqual([])
    expect(env.NODE_ENV).toBe('production')
    expect(env.CCC_E2E_DATA_DIR).toBe(r)
    expect(env.CCC_FORCE_SPLASH).toBe('0')
    expect(env.Path).toBe('x')
    expect(existsSync(join(home, '.claude'))).toBe(true)
  })

  it('[host] the script resolves no path from the real home and launches the app with that environment', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', '..', 'scripts', 'capture-training-screenshots.ts'), 'utf8')
    expect(src).not.toMatch(/os\.homedir\(/)
    expect(src).not.toMatch(/process\.env\.(USERPROFILE|HOME)\b/)
    expect(src).toMatch(/const CAPTURE_HOME = captureHomeDir\(CAPTURE_DATA_ROOT\)/)
    expect(src).toMatch(/path\.join\(CAPTURE_HOME, '\.claude', 'projects'\)/)
    expect(src).toMatch(/path\.join\(CAPTURE_HOME, '\.codex', 'sessions'\)/)
    expect(src).toMatch(/env: captureLaunchEnv\(dataRoot\)/)
    expect(src).not.toMatch(/env: \{ \.\.\.process\.env/)
  })
})
