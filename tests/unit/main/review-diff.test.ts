// WP2 commit 5b (owner decision 2): the change a Claude review reads is
// produced by the main process with a hardened git. PURE: git and the
// filesystem are injected here; the real-process proof (repositories whose
// fsmonitor hook, clean filter, textconv, external diff, pager and
// core.worktree would each act, one reached through a planted `.git` file)
// is in tests/wp1/fake-cli.test.ts, which runs on CI and the VM.
import { describe, it, expect, vi } from 'vitest'
import {
  produceReviewDiff, isReviewRange, parseReviewRange, filterOverrides, gitEnv, findGit, carriedWorkTreeConfig, WORK_TREE_KEYS_PATTERN,
  GIT_HARDENING, DIFF_HARDENING, REVIEW_DIFF_MAX_BYTES, REVIEW_DIFF_TIMEOUT_MS,
} from '../../../src/main/review-diff'
import type { ReviewDiffDeps, GitRun, PrivateGitDirFs } from '../../../src/main/review-diff'

const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe'
const CWD = 'C:\\proj'
const GITDIR = 'C:/proj/.git'
const HEAD = 'a'.repeat(40)
const ok = (stdout = '', code = 0): GitRun => ({ code, stdout: Buffer.from(stdout), stderr: '' })

interface Call { args: readonly string[]; opts: Parameters<ReviewDiffDeps['run']>[2] }
/** git answering the three plumbing questions, then `diff`. */
function script(over: Partial<Record<'where' | 'head' | 'anyHead' | 'workTree' | 'config' | 'diff', GitRun>> = {}) {
  return (args: readonly string[]): GitRun => {
    if (args.includes('--absolute-git-dir')) return over.where ?? ok(`${GITDIR}\n.git\nsha1\n`)
    if (args.includes('HEAD^{commit}')) return over.head ?? ok(`${HEAD}\n`)
    if (args.includes('--verify')) return over.anyHead ?? { code: 1, stdout: Buffer.alloc(0), stderr: '' }
    if (args.includes(WORK_TREE_KEYS_PATTERN)) return over.workTree ?? ok('', 1)
    if (args.includes('config')) return over.config ?? ok('', 1)
    return over.diff ?? ok('diff --git a/x b/x\n+1\n')
  }
}
function memFs(sharedIndex: string[] = []) {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const removed: string[] = []
  const copies: Array<[string, string]> = []
  const f: PrivateGitDirFs = {
    makeTemp: () => { dirs.add('T'); return 'T' },
    mkdir: (d) => { dirs.add(d) },
    write: (p, t) => { files.set(p.replace(/\\/g, '/'), t) },
    list: (d) => (d === GITDIR ? ['index', 'config', 'HEAD', ...sharedIndex] : []),
    copy: (a, b) => { copies.push([a.replace(/\\/g, '/'), b.replace(/\\/g, '/')]) },
    remove: (d) => { removed.push(d) },
  }
  return { f, files, dirs, removed, copies }
}
function deps(run: (args: readonly string[]) => GitRun = script(), over: Partial<ReviewDiffDeps> = {}) {
  const calls: Call[] = []
  const m = memFs()
  const d: ReviewDiffDeps = {
    git: () => GIT,
    run: vi.fn(async (_g, args, opts) => { calls.push({ args, opts }); return run(args) }),
    env: { PATH: 'C:\\Windows', GIT_DIR: 'C:\\evil', git_external_diff: 'evil.exe', GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='evil'", Git_Pager: 'evil', GIT_INDEX_FILE: 'C:\\evil\\index', HOME: 'C:\\Users\\u' },
    platform: 'win32',
    fs: m.f,
    ...over,
  }
  return { d, calls, m }
}
const diffCall = (calls: Call[]) => calls.find((c) => c.args.includes('diff'))!

describe('the review diff, mode working: through a private git dir the repository cannot configure', () => {
  it('the diffing git reads its own git dir -- HEAD as a commit id, the objects by alternates, the index by GIT_INDEX_FILE -- and the project as its work tree', async () => {
    const t = deps()
    expect(await produceReviewDiff({ cwd: CWD, mode: 'working' }, t.d)).toEqual({ ok: true, diff: 'diff --git a/x b/x\n+1\n' })
    const own = 'T/git'
    expect(t.m.files.get(`${own}/HEAD`)).toBe(`${HEAD}\n`)
    expect(t.m.files.get(`${own}/config`)).toBe('[core]\n\trepositoryformatversion = 0\n\tbare = false\n')
    expect(t.m.files.get(`${own}/objects/info/alternates`)).toBe('C:/proj/.git/objects\n')
    const args = diffCall(t.calls).args
    expect(args).toEqual([...GIT_HARDENING, `--git-dir=${'T\\git'}`, `--work-tree=${CWD}`, 'diff', ...DIFF_HARDENING, '--end-of-options', HEAD, '--'])
    expect(diffCall(t.calls).opts.env.GIT_INDEX_FILE).toBe('C:\\proj\\.git\\index')
    expect(diffCall(t.calls).opts.cwd).toBe(CWD)
    expect(t.m.removed).toEqual(['T'])
  })

  it('the repository is only read by plumbing that runs nothing it configures, each with the work tree pinned', async () => {
    const t = deps()
    await produceReviewDiff({ cwd: CWD, mode: 'working' }, t.d)
    const inRepo = t.calls.filter((c) => !c.args.some((a) => a.startsWith('--git-dir=')))
    expect(inRepo.map((c) => c.args.slice(GIT_HARDENING.length))).toEqual([
      [`--work-tree=${CWD}`, 'rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-object-format'],
      [`--work-tree=${CWD}`, 'rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'],
      [`--work-tree=${CWD}`, 'config', '--get-regexp', WORK_TREE_KEYS_PATTERN],
    ])
    for (const c of t.calls) expect(c.args.slice(0, GIT_HARDENING.length)).toEqual([...GIT_HARDENING])
  })

  it('carries the repository\'s value-only work-tree settings (the last value of each), only as the key\'s own tokens', async () => {
    const t = deps(script({ workTree: ok('core.filemode true\ncore.autocrlf input\ncore.filemode false\ncore.eol !sh -c pwn\ncore.checkstat minimal\ncore.symlinks maybe\n') }))
    await produceReviewDiff({ cwd: CWD, mode: 'working' }, t.d)
    expect(t.m.files.get('T/git/config')).toBe('[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = false\n\tautocrlf = input\n\tcheckstat = minimal\n')
    expect(carriedWorkTreeConfig('core.worktree /elsewhere\ncore.fsmonitor x\ncore.EOL CRLF\n')).toBe('\teol = crlf\n')
    const broken = deps(script({ workTree: { code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: bad config' } }))
    expect(await produceReviewDiff({ cwd: CWD, mode: 'working' }, broken.d)).toEqual({ ok: false, message: 'fatal: bad config' })
  })

  it('a HEAD that names something other than a commit is refused, not diffed as all-new', async () => {
    const t = deps(script({ head: { code: 1, stdout: Buffer.alloc(0), stderr: '' }, anyHead: ok(`${'d'.repeat(40)}\n`) }))
    expect(await produceReviewDiff({ cwd: CWD, mode: 'working' }, t.d)).toEqual({ ok: false, message: 'HEAD is not a commit' })
    expect(t.calls.some((c) => c.args.includes('diff'))).toBe(false)
  })

  it('filter drivers the user\'s own configuration names are emptied too, read in the private git dir', async () => {
    const t = deps(script({ config: ok('filter.lfs.clean git-lfs clean -- %f\nfilter.lfs.smudge git-lfs smudge -- %f\nfilter.Two.process x\n') }))
    await produceReviewDiff({ cwd: CWD, mode: 'working' }, t.d)
    const cfg = t.calls.find((c) => c.args.some((a) => a.startsWith('--git-dir=')) && c.args.includes('config'))!
    expect(cfg.args).toEqual([...GIT_HARDENING, `--git-dir=${'T\\git'}`, 'config', '--get-regexp', '^filter\\.'])
    expect(cfg.opts.cwd).toBe('T')
    const args = diffCall(t.calls).args
    for (const n of ['lfs', 'Two']) {
      for (const k of ['clean', 'smudge', 'process']) expect(args).toContain(`filter.${n}.${k}=`)
      expect(args).toContain(`filter.${n}.required=false`)
    }
    expect(args.indexOf('filter.Two.process=')).toBeLessThan(args.indexOf('diff'))
    const bad = deps(script({ config: ok('filter.a;b.clean x\n') }))
    expect(await produceReviewDiff({ cwd: CWD, mode: 'working' }, bad.d)).toMatchObject({ ok: false })
    expect(bad.calls.some((c) => c.args.includes('diff'))).toBe(false)
    expect(bad.m.removed).toEqual(['T'])
  })

  it('a repository with no commit yet is diffed against the empty tree; sha256 is declared; a split index\'s shared part is copied', async () => {
    const unborn = deps(script({ head: { code: 1, stdout: Buffer.alloc(0), stderr: '' } }))
    await produceReviewDiff({ cwd: CWD, mode: 'working' }, unborn.d)
    expect(diffCall(unborn.calls).args.slice(-2)).toEqual(['4b825dc642cb6eb9a060e54bf8d69288fbee4904', '--'])
    expect(unborn.m.files.get('T/git/HEAD')).toBe('ref: refs/heads/unborn\n')
    const s256 = deps(script({ where: ok(`${GITDIR}\n.git\nsha256\n`), head: ok(`${'b'.repeat(64)}\n`) }))
    await produceReviewDiff({ cwd: CWD, mode: 'working' }, s256.d)
    expect(s256.m.files.get('T/git/config')).toContain('objectformat = sha256')
    expect(s256.m.files.get('T/git/config')).toContain('repositoryformatversion = 1')
    const split = deps()
    const m = memFs([`sharedindex.${'c'.repeat(40)}`, 'sharedindex.evil'])
    split.d.fs = m.f
    await produceReviewDiff({ cwd: CWD, mode: 'working' }, split.d)
    expect(m.copies).toEqual([[`C:/proj/.git/sharedindex.${'c'.repeat(40)}`, `T/git/sharedindex.${'c'.repeat(40)}`]])
    const weird = deps(script({ where: ok(`${GITDIR}\n.git\nmd5\n`) }))
    expect(await produceReviewDiff({ cwd: CWD, mode: 'working' }, weird.d)).toMatchObject({ ok: false })
    const badHead = deps(script({ head: ok('not-a-hash\n') }))
    expect(await produceReviewDiff({ cwd: CWD, mode: 'working' }, badHead.d)).toEqual({ ok: false, message: 'HEAD could not be read' })
  })

  it('a linked worktree: the objects are the COMMON dir\'s, the index and a split index\'s shared part are the worktree\'s own', async () => {
    const wtDir = 'C:/main/.git/worktrees/wt'
    const t = deps(script({ where: ok(`${wtDir}\nC:/main/.git\nsha1\n`) }))
    const m = memFs()
    m.f.list = (d) => (d === wtDir ? ['index', `sharedindex.${'e'.repeat(40)}`] : [])
    t.d.fs = m.f
    expect(await produceReviewDiff({ cwd: CWD, mode: 'working' }, t.d)).toMatchObject({ ok: true })
    expect(m.files.get('T/git/objects/info/alternates')).toBe('C:/main/.git/objects\n')
    expect(diffCall(t.calls).opts.env.GIT_INDEX_FILE).toBe('C:\\main\\.git\\worktrees\\wt\\index')
    expect(m.copies).toEqual([[`C:/main/.git/worktrees/wt/sharedindex.${'e'.repeat(40)}`, `T/git/sharedindex.${'e'.repeat(40)}`]])
  })

  it('the temp git dir goes whatever happens, a throw included', async () => {
    const t = deps()
    t.d.fs = { ...t.m.f, write: () => { throw new Error('disk') } }
    expect(await produceReviewDiff({ cwd: CWD, mode: 'working' }, t.d)).toEqual({ ok: false, message: 'the change could not be prepared' })
    expect(t.m.removed).toEqual(['T'])
  })
})

describe('the review diff, mode range: tree against tree', () => {
  it('a real range only, diffed in the repository with the work tree pinned, the range after --end-of-options', async () => {
    const t = deps()
    expect(await produceReviewDiff({ cwd: CWD, mode: 'range', range: 'HEAD~2..HEAD' }, t.d)).toMatchObject({ ok: true })
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].args).toEqual([...GIT_HARDENING, `--work-tree=${CWD}`, 'diff', ...DIFF_HARDENING, '--end-of-options', 'HEAD~2..HEAD', '--'])
    expect(t.m.dirs.size).toBe(0)
  })

  it('a single revision (which git would diff against the WORK TREE), an option, a space, a path or a shell character is refused before git runs', () => {
    for (const good of ['HEAD~1..HEAD', 'main...feature/x', '..HEAD', 'abc123^..', '@{u}..HEAD', 'v1.2.3..v1.2.4', 'HEAD@{1}..HEAD']) expect(isReviewRange(good), good).toBe(true)
    expect(parseReviewRange('main...feature/x')).toEqual({ from: 'main', to: 'feature/x', op: '...' })
    for (const bad of ['HEAD~1', 'HEAD', '..', '...', '--output=C:\\x..HEAD', '-p..HEAD', 'HEAD..--output=x', 'HEAD --output=x..a', 'HEAD:secret.txt..HEAD', 'a;b..c', '$(x)..a', 'a b..c', '', 'a..b..c', 'x'.repeat(201) + '..a']) {
      expect(isReviewRange(bad), bad).toBe(false)
    }
  })

  it('refuses a bad range without running git', async () => {
    const t = deps()
    expect(await produceReviewDiff({ cwd: CWD, mode: 'range', range: 'HEAD~1' }, t.d)).toMatchObject({ ok: false, message: expect.stringContaining('joined by') })
    expect(t.d.run).not.toHaveBeenCalled()
  })
})

describe('every git run', () => {
  it('inherits no GIT_* variable in any spelling, takes no optional lock, prompts for nothing, fetches nothing', async () => {
    const t = deps()
    await produceReviewDiff({ cwd: CWD, mode: 'working' }, t.d)
    for (const c of t.calls) {
      const names = Object.keys(c.opts.env).filter((k) => k.toUpperCase().startsWith('GIT_')).sort()
      expect(names.filter((n) => n !== 'GIT_INDEX_FILE')).toEqual(['GIT_NO_LAZY_FETCH', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT'])
      expect(c.opts.env.GIT_INDEX_FILE === undefined || c.opts.env.GIT_INDEX_FILE === 'C:\\proj\\.git\\index').toBe(true)
      expect(c.opts.env.HOME).toBe('C:\\Users\\u')
      expect(c.opts.timeoutMs).toBe(REVIEW_DIFF_TIMEOUT_MS)
    }
    expect(GIT_HARDENING).toEqual(['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'protocol.allow=never'])
    expect(DIFF_HARDENING).toEqual(['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all'])
    expect(Object.keys(gitEnv({ git_dir: 'x', GIT_DIR: 'y' }, 'linux'))).toContain('git_dir')
  })

  it('carries the cancel: a cancelled run says so and nothing more runs', async () => {
    const ac = new AbortController()
    const t = deps((args) => (args.includes('--absolute-git-dir') ? { code: null, stdout: Buffer.alloc(0), stderr: '', cancelled: true } : ok()))
    expect(await produceReviewDiff({ cwd: CWD, mode: 'working', signal: ac.signal }, t.d)).toEqual({ ok: false, message: 'the review was cancelled' })
    expect(t.calls[0].opts.signal).toBe(ac.signal)
    expect(t.calls).toHaveLength(1)
  })

  it('a change past the bound is refused, never cut; a timeout or git\'s own refusal is one bounded line', async () => {
    const big = deps(script({ diff: { code: null, stdout: Buffer.alloc(0), stderr: '', tooLarge: true } }))
    expect(await produceReviewDiff({ cwd: CWD, mode: 'working' }, big.d)).toMatchObject({ ok: false, message: expect.stringContaining('larger than 512 KB') })
    expect(diffCall(big.calls).opts.maxBytes).toBe(REVIEW_DIFF_MAX_BYTES)
    const slow = deps(script({ diff: { code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: true } }))
    expect(await produceReviewDiff({ cwd: CWD, mode: 'working' }, slow.d)).toMatchObject({ ok: false, message: expect.stringContaining('did not finish') })
    const long = 'fatal: ' + 'x'.repeat(400)
    const refused = deps(script({ where: { code: 128, stdout: Buffer.alloc(0), stderr: `${long}\nmore\n` } }))
    expect(await produceReviewDiff({ cwd: CWD, mode: 'working' }, refused.d)).toEqual({ ok: false, message: `${long.slice(0, 200)} [...]` })
    expect(await produceReviewDiff({ cwd: CWD, mode: 'working' }, deps(undefined, { git: () => null }).d)).toEqual({ ok: false, message: 'git was not found' })
  })

  it('filter driver names it cannot name safely are refused', () => {
    expect(filterOverrides('filter.a b.clean x\n')).toBeNull()
    expect(filterOverrides('filter..clean x\n')).toBeNull()
    expect(filterOverrides('filter.x=y.clean z\n')).toBeNull()
    expect(filterOverrides('')).toEqual([])
  })

  it('finds git by absolute PATH entries only, never a relative or unexpanded one', () => {
    const files = new Set(['C:\\Program Files\\Git\\cmd\\git.exe', 'rel\\git.exe', '/usr/bin/git'])
    const isFile = (p: string) => files.has(p)
    expect(findGit('rel;%X%\\bin;"C:\\Program Files\\Git\\cmd"', 'win32', isFile)).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(findGit('rel;.', 'win32', isFile)).toBeNull()
    expect(findGit('bin:/usr/bin', 'linux', isFile)).toBe('/usr/bin/git')
    expect(findGit(undefined, 'linux', isFile)).toBeNull()
  })
})
