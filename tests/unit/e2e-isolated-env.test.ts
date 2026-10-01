/**
 * P3.16 (M7): every e2e app instance runs with a home of its own, inside its
 * own mkdtemp data dir, so nothing the app writes under the user's home (a
 * Claude session's `~/.claude/settings-<id>.json`, placed by os.homedir() and
 * removed only when the session's process exits, which a tree-killed test app
 * never reports) lands in the runner's real home. The e2e harness cannot run
 * here, so this pins the environment builder it uses (tests/e2e/helpers/
 * isolated-env.ts, which imports no Playwright) and reads the e2e files as text
 * to pin that every Electron launch in them goes through it.
 *
 * Writes only inside a folder this file makes (its own prefix, directly in the
 * temp folder), removed by that prefix and parent alone.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { basename, dirname, join, relative, resolve } from 'path'
import { tmpdir } from 'os'
import { isolatedHomeDir, isolatedLaunchEnv } from '../e2e/helpers/isolated-env'

const PREFIX = 'ccc-test-e2e-env-'
const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) if (dirname(d) === tmpdir() && basename(d).startsWith(PREFIX)) rmSync(d, { recursive: true, force: true })
})
const dataDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), PREFIX))
  made.push(d)
  return d
}
const keysNamed = (env: Record<string, string>, name: string): string[] => Object.keys(env).filter((k) => k.toLowerCase() === name.toLowerCase())

describe('the e2e launch environment (P3.16, M7)', () => {
  it('the home is a folder inside the instance\'s own data dir, made with its .claude folder', () => {
    const d = dataDir()
    const env = isolatedLaunchEnv(d, {}, { USERPROFILE: 'C:\\Users\\runner', HOME: '/home/runner', PATH: 'x' })
    const home = isolatedHomeDir(d)
    expect(env.USERPROFILE).toBe(home)
    expect(env.HOME).toBe(home)
    expect(relative(d, home)).toBe('home')
    expect(statSync(join(home, '.claude')).isDirectory()).toBe(true)
    expect(env.CCC_E2E_DATA_DIR).toBe(d)
    expect(env.NODE_ENV).toBe('test')
    expect(env.E2E_HEADLESS).toBe('1')
    expect(env.CCC_FORCE_SPLASH).toBe('0')
    expect(env.PATH).toBe('x')
  })

  it('the runner\'s own home, Claude config folder and Codex home go, whatever their case', () => {
    const d = dataDir()
    const env = isolatedLaunchEnv(d, {}, { UserProfile: 'C:\\Users\\runner', home: '/home/runner', Claude_Config_Dir: 'C:\\Users\\runner\\.claude', codex_home: 'C:\\Users\\runner\\.codex', CCC_FORCE_SPLASH: '1', node_env: 'production' })
    for (const name of ['USERPROFILE', 'HOME', 'CCC_FORCE_SPLASH', 'NODE_ENV']) expect(keysNamed(env, name), name).toHaveLength(1)
    expect(keysNamed(env, 'CLAUDE_CONFIG_DIR')).toEqual([])
    expect(keysNamed(env, 'CODEX_HOME')).toEqual([])
    expect(env.USERPROFILE).toBe(isolatedHomeDir(d))
    expect(Object.values(env).some((v) => v.includes('runner'))).toBe(false)
  })

  it('a spec\'s own entries win, whatever their case, and undefined removes one', () => {
    const d = dataDir()
    const env = isolatedLaunchEnv(d, { CODEX_HOME: join(d, 'codex-home'), path: 'y', E2E_HEADLESS: undefined }, { Path: 'x', E2E_HEADLESS: '1' })
    expect(env.CODEX_HOME).toBe(join(d, 'codex-home'))
    expect(keysNamed(env, 'PATH')).toEqual(['path'])
    expect(env.path).toBe('y')
    expect(keysNamed(env, 'E2E_HEADLESS')).toEqual([])
  })
})

/** Every .ts file under tests/e2e. */
function e2eFiles(dir = resolve(__dirname, '../e2e')): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...e2eFiles(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('every Electron launch in the e2e suite runs with the isolated environment (P3.16, M7)', () => {
  const files = e2eFiles()
  it('finds the e2e files', () => {
    expect(files.length).toBeGreaterThan(10)
    expect(existsSync(resolve(__dirname, '../e2e/helpers/isolated-env.ts'))).toBe(true)
  })

  it('each electron.launch passes env: isolatedLaunchEnv(...), and no file spreads the runner\'s environment into one', () => {
    let launches = 0
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const calls = text.split('electron.launch(').slice(1)
      for (const call of calls) {
        launches++
        // The call's own argument: up to the first line that closes it.
        const arg = call.slice(0, call.search(/\n\s*\}\)/) + 1 || undefined)
        expect(arg, relative(resolve(__dirname, '..'), file)).toMatch(/\benv:\s*isolatedLaunchEnv\(/)
      }
      if (!file.endsWith('isolated-env.ts')) expect(text, relative(resolve(__dirname, '..'), file)).not.toMatch(/\.\.\.process\.env\b/)
    }
    // The helper's launch and the three specs that launch on their own.
    expect(launches).toBeGreaterThanOrEqual(4)
  })
})
