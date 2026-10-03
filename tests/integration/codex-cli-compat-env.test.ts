// [host] PR 4 VM checkpoint (F4): codex-cli-compat.test.ts runs the PATH
// `codex` (CI and the VM; its file is never run on the owner's workstation).
// On the VM it ran with no CODEX_HOME, so Codex wrote its scratch folder into
// the VM user's own ~/.codex. Every run there now gets a fresh, empty Codex
// folder of its own, under the app's own allowlisted Codex environment
// (codexCliEnv: no CODEX_* or OPENAI_* variable of the caller's reaches it),
// removed after the run by its own temp-folder prefix. Checked here without
// starting anything: the environment it builds, the folder's life, and the
// file's one spawn of codex (read as text, never imported or run).
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { compatProbeEnv, withCompatHome, removeCompatHome, COMPAT_HOME_PREFIX } from './codex-cli-compat-env'

const REAL = path.join('/home', 'someone', '.codex')

describe('the environment the compat probe runs codex under', () => {
  it.each(['linux', 'win32', 'darwin'] as NodeJS.Platform[])('%s: CODEX_HOME is the fresh folder, and no other Codex or OpenAI variable of the caller reaches it', (platform) => {
    const fresh = path.join(os.tmpdir(), `${COMPAT_HOME_PREFIX}abc`)
    const env = compatProbeEnv({
      PATH: platform === 'win32' ? 'C:\\nodejs;C:\\npm' : '/usr/bin:/bin',
      CODEX_HOME: REAL, codex_home: REAL, CODEX_SQLITE_HOME: REAL, OPENAI_API_KEY: 'sk-test', CODEX_API_KEY: 'k', HOME: '/home/someone',
    }, fresh, platform)
    expect(env.CODEX_HOME).toBe(fresh)
    const codexOrOpenAi = Object.keys(env).filter((k) => /^(CODEX|OPENAI)_/i.test(k))
    expect(codexOrOpenAi).toEqual(['CODEX_HOME'])
    expect(Object.values(env)).not.toContain(REAL)
    expect(env.PATH ?? env.Path).toBeTruthy()
  })

  it('refuses to build one without a folder', () => {
    expect(() => compatProbeEnv({ PATH: '/usr/bin' }, '', 'linux')).toThrow()
  })
})

describe('the fresh Codex folder of one run', () => {
  it('is an empty folder of its own prefix directly in the temp folder, removed after the run', () => {
    let seen = ''
    withCompatHome((home) => {
      seen = home
      expect(path.dirname(home)).toBe(os.tmpdir())
      expect(path.basename(home).startsWith(COMPAT_HOME_PREFIX)).toBe(true)
      expect(fs.readdirSync(home)).toEqual([])
      fs.mkdirSync(path.join(home, 'tmp', 'arg0'), { recursive: true })
    })
    expect(seen).not.toBe('')
    expect(fs.existsSync(seen)).toBe(false)
  })

  it('is removed when the run throws too', () => {
    let seen = ''
    expect(() => withCompatHome((home) => { seen = home; throw new Error('the run failed') })).toThrow(/the run failed/)
    expect(fs.existsSync(seen)).toBe(false)
  })

  it('removes only a folder of its own prefix directly in the temp folder', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-cli-compat-other-'))
    try {
      expect(removeCompatHome(other)).toBe(false)
      expect(fs.existsSync(other)).toBe(true)
      expect(removeCompatHome(path.join(other, `${COMPAT_HOME_PREFIX}x`))).toBe(false)
      expect(removeCompatHome(path.join(os.homedir(), '.codex'))).toBe(false)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('codex-cli-compat.test.ts starts codex only through it (source wiring)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'codex-cli-compat.test.ts'), 'utf8')

  it('its one spawn of codex runs inside a fresh folder, with the probe environment', () => {
    expect(src.match(/spawnSync\(/g)).toHaveLength(1)
    expect(src).toMatch(/withCompatHome\(\(home\)(: HelpResult)? => \{[\s\S]*?spawnSync\('codex', \['exec', '--help'\], \{[^}]*\benv: compatProbeEnv\(process\.env, home\)/)
    expect(src).not.toMatch(/\bspawn\(|\bexec\(|execSync\(|execFileSync\(\s*'codex'/)
  })
})
