// P3.10 round 3b: on macOS and Linux a Codex session's launch environment
// keeps only absolute PATH entries in every case, whether or not the login
// shell answered (the hook command there is `node '<script>'`, hooks.ts
// codexHookCommand). The session's launch is built on codexOperationBaseEnv
// (auth-operations prepareLaunch, deps.baseEnv).
// No login shell is started here: child_process is replaced.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const OPEN = '__CCC_CODEX_PATH_BEGIN__'
const CLOSE = '__CCC_CODEX_PATH_END__'
let shellAnswer: { err: Error | null; stdout: string } = { err: new Error('no login shell'), stdout: '' }
const started: string[] = []
vi.mock('node:child_process', () => ({
  execFile: (file: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    started.push(file)
    cb(shellAnswer.err, shellAnswer.stdout)
  },
}))

const { codexOperationBaseEnv } = await import('../../../../src/main/providers/codex/process-env')

beforeEach(() => {
  started.length = 0
  shellAnswer = { err: new Error('no login shell'), stdout: '' }
})

describe('the launch environment\'s PATH on macOS and Linux (P3.10 round 3b)', () => {
  it('without the login shell\'s answer, the inherited PATH keeps only its absolute entries', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const env = await codexOperationBaseEnv({ PATH: '/usr/bin::.:bin:./tools:/opt/x/bin:', HOME: '/home/u', SHELL: '/bin/zsh' }, platform)
      expect(env.PATH, platform).toBe('/usr/bin:/opt/x/bin')
      expect(env.HOME).toBe('/home/u')
    }
    expect(started).toEqual(['/bin/zsh', '/bin/zsh'])
  })

  it('an inherited PATH with no absolute entry is dropped, not kept', async () => {
    const env = await codexOperationBaseEnv({ PATH: '.:bin::', HOME: '/home/u', SHELL: '/bin/bash' }, 'linux')
    expect('PATH' in env).toBe(false)
  })

  it('the login shell\'s PATH, when it answers, keeps only its absolute entries (as before)', async () => {
    shellAnswer = { err: null, stdout: `banner\n${OPEN}/opt/homebrew/bin:.::/usr/bin${CLOSE}` }
    const env = await codexOperationBaseEnv({ PATH: '.:/inherited', HOME: '/Users/u', SHELL: '/bin/zsh' }, 'darwin')
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('Windows: a PATH of fully qualified folders is kept as it is, and no shell is asked', async () => {
    for (const key of ['PATH', 'Path']) {
      const env = await codexOperationBaseEnv({ [key]: 'C:\\Windows\\System32;C:\\Program Files\\nodejs' }, 'win32')
      expect(env[key], key).toBe('C:\\Windows\\System32;C:\\Program Files\\nodejs')
    }
    expect(started).toEqual([])
  })
})

// On Windows a Codex session's PATH keeps only fully qualified folders (a
// drive or a share), as it does on macOS and Linux. Synthetic environments
// only.
describe('the launch environment\'s PATH on Windows', () => {
  const MIXED = [
    'C:\\Windows\\System32', 'relative\\bin', '.', '', '.\\tools', '"C:\\Program Files\\nodejs"', '\\\\?\\C:\\dev',
    '\\\\.\\pipe\\x', 'C:rel', '\\rooted', '\\\\srv\\share\\bin', ' D:\\spaced ', '%SystemRoot%\\x', '..',
  ].join(';')
  const KEPT = 'C:\\Windows\\System32;C:\\Program Files\\nodejs;\\\\srv\\share\\bin;D:\\spaced'

  it('a windows launch keeps only fully qualified PATH folders, under the spelling it came in', async () => {
    const env = await codexOperationBaseEnv({ Path: MIXED, SystemRoot: 'C:\\Windows' }, 'win32')
    expect(env.Path).toBe(KEPT)
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path'])
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(started).toEqual([])
  })

  it('with only relative entries the variable is dropped, in any spelling', async () => {
    for (const key of ['PATH', 'Path', 'pAtH']) {
      const env = await codexOperationBaseEnv({ [key]: '.;bin;;.\\node_modules\\.bin', HOME: 'h' }, 'win32')
      expect(Object.keys(env).some((k) => k.toUpperCase() === 'PATH'), key).toBe(false)
    }
  })

  it('every spelling a copied environment holds is narrowed', async () => {
    const env = await codexOperationBaseEnv({ Path: 'C:\\a;rel', PATH: '.;D:\\b' }, 'win32')
    expect(env.Path).toBe('C:\\a')
    expect(env.PATH).toBe('D:\\b')
  })

  it('every PATH filter applies the same folder rule (the session\'s, the CLI operations\', the PATH walk\'s, a Claude launch\'s)', async () => {
    const { codexCliEnv, absolutePathValue } = await import('../../../../src/main/providers/codex/cli-env')
    const { windowsPathFolderIsFullyQualified } = await import('../../../../src/main/providers/windows-path-names')
    const { withFullyQualifiedProgramLookup } = await import('../../../../src/main/windows-programs')
    const session = await codexOperationBaseEnv({ Path: MIXED }, 'win32')
    expect(codexCliEnv({ Path: MIXED }, 'C:\\r', 'win32').Path).toBe(session.Path)
    expect(withFullyQualifiedProgramLookup({ Path: MIXED }).Path).toBe(session.Path)
    for (const entry of MIXED.split(';')) {
      expect(withFullyQualifiedProgramLookup({ Path: entry }).Path ?? null, JSON.stringify(entry)).toBe(absolutePathValue(entry, true))
    }
    expect(String(session.Path).split(';').every((dir) => windowsPathFolderIsFullyQualified(dir))).toBe(true)
  })
})
