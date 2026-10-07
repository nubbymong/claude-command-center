// [host] WP2 PR 4 (ADR-009 delta, review L3): on Windows the Codex executable
// discovery proves, and the one the pre-use check accepts, is never at a path
// with a folder or file name ending in a dot or a space. Node reads such a
// name as it is spelled, while Windows' own path handling, which starts the
// program, drops the dot or space and reaches another file, so the proof
// would be of a different file from the one that runs. The resources folder
// follows the same rule (realm-folders.ts). Ports only: no file is read and
// no process is started.
import { describe, it, expect } from 'vitest'
import { discoverCodex, verifyCodexExecutable, windowsPathHasTrailingDotOrSpace } from '../../../../src/main/providers/codex/discovery'
import type { CodexDiscoveryDeps, CodexExecutableIdentity } from '../../../../src/main/providers/codex/discovery'

function deps(canonical: string, platform: NodeJS.Platform = 'win32') {
  const runs: unknown[] = []
  const d: CodexDiscoveryDeps = {
    resolve: () => 'C:\\npm\\codex.exe',
    realpath: () => canonical,
    stat: () => ({ size: 100, mtimeMs: 5, ctimeMs: 6, dev: '1', ino: '2', isFile: true }),
    run: async (cmd) => { runs.push(cmd); return { exitCode: 0, stdout: 'codex-cli 0.155.1\n', stderr: '', timedOut: false, truncated: false } },
    env: { PATH: 'C:\\npm', SystemRoot: 'C:\\Windows' },
    platform,
    versionHome: () => ({ home: 'C:\\tmp\\ccc-codex-version-0', dispose: () => {} }),
    now: () => 1,
  }
  return { d, runs }
}
const recorded = (p: string): CodexExecutableIdentity => ({ path: p, size: 100, mtimeMs: 5, ctimeMs: 6, dev: '1', ino: '2' })

describe('a Windows path Node and Windows read differently', () => {
  it.each([
    ['a folder ending in a dot', 'C:\\T.\\codex.exe'],
    ['a folder ending in a space', 'C:\\tools \\codex.exe'],
    ['a file ending in a dot', 'C:\\npm\\codex.exe.'],
    ['a share path with such a folder', '\\\\server\\share\\T.\\codex.exe'],
  ])('[host] discovery refuses it and runs nothing: %s', async (_name, canonical) => {
    const { d, runs } = deps(canonical)
    const out = await discoverCodex(d)
    expect(out.state).toBe('invalid')
    expect(out).not.toHaveProperty('version')
    expect(runs).toEqual([])
  })

  it.each([
    ['a folder ending in a dot', 'C:\\T.\\codex.exe'],
    ['a file ending in a dot', 'C:\\npm\\codex.exe.'],
  ])('[host] the pre-use check refuses it, even when it is the path recorded: %s', (_name, canonical) => {
    const { d } = deps(canonical)
    const check = verifyCodexExecutable(recorded(canonical), d)
    expect(check.ok).toBe(false)
  })

  it('[host] a plain path is proved and accepted as before', async () => {
    const { d, runs } = deps('C:\\npm\\codex.exe')
    expect(await discoverCodex(d)).toMatchObject({ state: 'found', executable: 'C:\\npm\\codex.exe', version: '0.155.1' })
    expect(runs).toHaveLength(1)
    expect(verifyCodexExecutable(recorded('C:\\npm\\codex.exe'), d)).toEqual({ ok: true, executable: 'C:\\npm\\codex.exe' })
  })

  it('[host] off Windows such a name is an ordinary name: unchanged', async () => {
    const { d } = deps('/opt/T./codex', 'linux')
    expect(verifyCodexExecutable(recorded('/opt/T./codex'), d)).toEqual({ ok: true, executable: '/opt/T./codex' })
  })

  it.each([
    ['C:\\T.\\codex.exe', true],
    ['C:\\a \\b', true],
    ['C:\\a\\.\\b', true],
    ['C:\\a\\..\\b', true],
    ['C:\\npm\\codex.exe.', true],
    ['C:\\npm\\codex.cmd', false],
    ['C:\\Program Files\\codex', false],
    ['C:\\npm\\', false],
    ['\\\\server\\share\\npm\\codex.exe', false],
  ])('[host] the rule: %s -> %s', (p, want) => {
    expect(windowsPathHasTrailingDotOrSpace(p)).toBe(want)
  })
})
