// WP2 commit 5b (plan "Commit 5b", owner decision 2): the change under review,
// produced by the MAIN process and sent to the reviewer in its prompt. The
// Claude reviewer runs `--restricted` with no shell, so it cannot run git
// itself.
//
// This is git run by the app, unsandboxed, in a folder an agent works in --
// and an agent that can write the folder can write a `.git` there (a gitfile
// pointing at a git dir of its own included), so the repository's own
// configuration is untrusted. Nothing it says may make this run anything but
// git, or read outside the project:
//   - Mode `working` (the work tree against HEAD, which reads work-tree files
//     and so would run a configured clean filter or fsmonitor hook) diffs
//     through a PRIVATE git dir this module writes in a temp folder: its own
//     minimal config, HEAD as a commit id, the repository's objects through
//     an alternates entry and its index through GIT_INDEX_FILE. The diffing
//     git reads no repository configuration -- only the user's global and
//     system configuration and this one -- so there is no window in which a
//     repository could add a filter between a check and the diff. Of the
//     repository's own settings only the value-only ones that decide how the
//     work tree compares (file mode, symlinks, line endings...) are carried
//     over, each checked against the key's own tokens.
//   - Mode `range` is a real range (`A..B`, `A...B`): tree against tree,
//     which reads no work-tree file, so no filter or fsmonitor can run.
//   - Every run: git by absolute path; `--work-tree=<project>` (a
//     repository's core.worktree cannot point it elsewhere); `--no-pager`,
//     `-c core.fsmonitor=false`, `-c core.pager=cat`, `-c diff.external=`,
//     `-c protocol.allow=never` (no transport: a partial clone would fetch a
//     missing object); `--no-ext-diff --no-textconv --no-color
//     --ignore-submodules=all`; every filter driver the user's own
//     configuration defines emptied too; no GIT_* variable inherited, no
//     optional index lock, no prompt, no lazy fetch.
//   - A range is revisions only, after `--end-of-options`, so it can never be
//     read as an option (`--output=<file>` writes a file).
//   - The output is bounded and REFUSED past the bound, never cut: a review of
//     half a change reads as a review of the change.
// Mode `paths` needs no diff: the reviewer reads the named files itself.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The largest change sent in a prompt. */
export const REVIEW_DIFF_MAX_BYTES = 512 * 1024
export const REVIEW_DIFF_TIMEOUT_MS = 30_000
/** Bound on the small reads (rev-parse, config). */
const SMALL = 64 * 1024

/** One side of a range: refs, hashes and `~ ^ @{...}`. No option (a leading
 *  `-`), no whitespace, no `:` (a path inside a revision), no `=`, no `.`
 *  run (the range separator), nothing a shell or git reads. */
const SIDE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/~^@{}-]{1,200}$/

/** `A..B` or `A...B` (either side may be empty: HEAD). */
export function parseReviewRange(range: string): { from: string; to: string; op: '..' | '...' } | null {
  if (typeof range !== 'string' || range.length > 401) return null
  const op = range.includes('...') ? '...' : range.includes('..') ? '..' : null
  if (!op) return null
  const i = range.indexOf(op)
  const from = range.slice(0, i)
  const to = range.slice(i + op.length)
  if (!from && !to) return null
  for (const side of [from, to]) if (side && !SIDE.test(side)) return null
  return { from, to, op }
}

export function isReviewRange(range: string): boolean {
  return parseReviewRange(range) !== null
}

/** A filter driver name git would read from `filter.<name>.<key>`. */
const FILTER_NAME = /^[A-Za-z0-9._-]{1,100}$/

/** The switches every git run here carries (before the subcommand). */
export const GIT_HARDENING: readonly string[] = Object.freeze([
  '--no-pager',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  '-c', 'protocol.allow=never',
])

/** The diff's own switches (after `diff`). */
export const DIFF_HARDENING: readonly string[] = Object.freeze([
  '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all',
])

/** The empty tree, which git always has: the base for a repository with no
 *  commit yet. */
const EMPTY_TREE: Readonly<Record<string, string>> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
}

export interface GitRun { code: number | null; stdout: Buffer; stderr: string; tooLarge?: boolean; timedOut?: boolean; cancelled?: boolean; error?: string }

export interface GitRunOptions { cwd: string; env: Record<string, string>; maxBytes: number; timeoutMs: number; signal?: AbortSignal }

/** What the private git dir needs of the filesystem. */
export interface PrivateGitDirFs {
  /** A fresh, empty, private temp folder. */
  makeTemp(): string
  mkdir(dir: string): void
  write(file: string, text: string): void
  /** Names in a folder ([] when it cannot be read). */
  list(dir: string): string[]
  copy(from: string, to: string): void
  /** Remove a temp folder this module made. Never throws. */
  remove(dir: string): void
}

export interface ReviewDiffDeps {
  /** The absolute git executable, or null. */
  git(): string | null
  run(git: string, args: readonly string[], opts: GitRunOptions): Promise<GitRun>
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  fs: PrivateGitDirFs
}

export type ReviewDiffResult = { ok: true; diff: string } | { ok: false; message: string }

/** git's environment: this process's, less every GIT_* variable (in any
 *  spelling on Windows), with no optional index lock, no prompt and no lazy
 *  fetch. */
export function gitEnv(source: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    if (typeof v !== 'string') continue
    if ((platform === 'win32' ? k.toUpperCase() : k).startsWith('GIT_')) continue
    out[k] = v
  }
  out.GIT_OPTIONAL_LOCKS = '0'
  out.GIT_TERMINAL_PROMPT = '0'
  out.GIT_NO_LAZY_FETCH = '1'
  return out
}

/** `-c filter.<name>.<key>=` for every configured filter driver, so no clean
 *  or smudge command runs; null when a driver's name is not one it can be
 *  safely named by (the diff is then refused). */
export function filterOverrides(configLines: string): string[] | null {
  const names = new Set<string>()
  for (const line of configLines.split(/\r?\n/)) {
    const key = line.split(/\s/, 1)[0] ?? ''
    if (!/^filter\./i.test(key)) continue
    const dot = key.lastIndexOf('.')
    const name = key.slice('filter.'.length, dot)
    if (dot <= 'filter.'.length || !FILTER_NAME.test(name)) return null
    names.add(name)
  }
  const out: string[] = []
  for (const n of names) out.push('-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`)
  return out
}

/** The settings that decide how git compares the work tree with the index --
 *  values only, none of which runs anything -- carried from the repository
 *  into the private git dir, so the diff reads as the user's own `git diff`
 *  does (no mode change on a Windows checkout, no symlink or line-ending
 *  noise). Keys as git prints them from `config --get-regexp` (lowercase). */
const BOOL = /^(true|false|yes|no|on|off|1|0)$/i
const WORK_TREE_KEYS: Readonly<Record<string, RegExp>> = {
  'core.filemode': BOOL,
  'core.symlinks': BOOL,
  'core.ignorecase': BOOL,
  'core.precomposeunicode': BOOL,
  'core.trustctime': BOOL,
  'core.autocrlf': /^(true|false|input|yes|no|on|off|1|0)$/i,
  'core.safecrlf': /^(true|false|warn|yes|no|on|off|1|0)$/i,
  'core.eol': /^(lf|crlf|native)$/i,
  'core.checkstat': /^(default|minimal)$/i,
}
export const WORK_TREE_KEYS_PATTERN = '^core[.](filemode|symlinks|ignorecase|precomposeunicode|trustctime|autocrlf|safecrlf|eol|checkstat)$'

/** `config --get-regexp` output to the private config's lines: the last
 *  value of each key (git prints scopes lowest first), and only a value that
 *  is one of the key's own tokens -- anything else is dropped. */
export function carriedWorkTreeConfig(configLines: string): string {
  const last = new Map<string, string>()
  for (const line of configLines.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s*$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const valid = WORK_TREE_KEYS[key]
    if (valid && valid.test(m[2])) last.set(key, m[2].toLowerCase())
  }
  return [...last].map(([k, v]) => `\t${k.slice('core.'.length)} = ${v}\n`).join('')
}

/** git's refusal, bounded and on one line. */
function gitFailure(r: GitRun): string {
  if (r.cancelled) return 'the review was cancelled'
  if (r.timedOut) return `git did not finish within ${REVIEW_DIFF_TIMEOUT_MS / 1000} seconds`
  if (r.error) return 'git could not be run'
  const first = r.stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? `exit code ${r.code}`
  return first.length > 200 ? `${first.slice(0, 200)} [...]` : first
}

const lines = (b: Buffer) => b.toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

/** The change for mode `working` (tracked files, staged and not, against
 *  HEAD) or `range`. */
export async function produceReviewDiff(
  input: { cwd: string; mode: 'working' | 'range'; range?: string; signal?: AbortSignal },
  deps: ReviewDiffDeps = defaultReviewDiffDeps(),
): Promise<ReviewDiffResult> {
  const range = input.mode === 'range' ? parseReviewRange(input.range ?? '') : null
  if (input.mode === 'range' && !range) {
    return { ok: false, message: 'the range must be two revisions joined by ".." or "..." (for example HEAD~1..HEAD): no spaces, no leading "-", no ":"' }
  }
  const git = deps.git()
  if (!git) return { ok: false, message: 'git was not found' }
  const env = gitEnv(deps.env, deps.platform)
  const workTree = `--work-tree=${input.cwd}`
  const opts = (maxBytes: number, over: Partial<GitRunOptions> = {}): GitRunOptions => ({
    cwd: input.cwd, env, maxBytes, timeoutMs: REVIEW_DIFF_TIMEOUT_MS, ...(input.signal ? { signal: input.signal } : {}), ...over,
  })
  const tooLarge = { ok: false as const, message: `the change is larger than ${REVIEW_DIFF_MAX_BYTES / 1024} KB; review a narrower range, or name files with mode "paths"` }

  if (range) {
    // Tree against tree: no work-tree file is read, so nothing the repository
    // configures for the work tree can run.
    const r = await deps.run(git, [...GIT_HARDENING, workTree, 'diff', ...DIFF_HARDENING, '--end-of-options', `${range.from}${range.op}${range.to}`, '--'], opts(REVIEW_DIFF_MAX_BYTES))
    if (r.tooLarge) return tooLarge
    if (r.code !== 0) return { ok: false, message: gitFailure(r) }
    return { ok: true, diff: r.stdout.toString('utf8') }
  }

  // Where the repository keeps its index and objects, and what HEAD is.
  // Reading these runs nothing the repository configures.
  const where = await deps.run(git, [...GIT_HARDENING, workTree, 'rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-object-format'], opts(SMALL))
  const at = lines(where.stdout)
  if (where.code !== 0 || at.length !== 3) return { ok: false, message: gitFailure(where) }
  const pathApi = deps.platform === 'win32' ? path.win32 : path.posix
  const gitDir = at[0]
  const commonDir = pathApi.resolve(input.cwd, at[1])
  const format = at[2]
  if (!EMPTY_TREE[format]) return { ok: false, message: `the repository's object format (${format.slice(0, 20)}) is not one this app reads` }
  const head = await deps.run(git, [...GIT_HARDENING, workTree, 'rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'], opts(SMALL))
  if (head.cancelled || head.timedOut || head.error) return { ok: false, message: gitFailure(head) }
  const headId = head.code === 0 ? lines(head.stdout)[0] ?? '' : ''
  if (head.code === 0 && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headId)) return { ok: false, message: 'HEAD could not be read' }
  if (!headId) {
    // No commit yet only when HEAD names nothing at all; a HEAD that names
    // something other than a commit is refused, never diffed as all-new.
    const any = await deps.run(git, [...GIT_HARDENING, workTree, 'rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD'], opts(SMALL))
    if (any.cancelled || any.timedOut || any.error) return { ok: false, message: gitFailure(any) }
    if (any.code === 0) return { ok: false, message: 'HEAD is not a commit' }
  }
  const base = headId || EMPTY_TREE[format]
  // How the user's git compares the work tree (see WORK_TREE_KEYS).
  const wt = await deps.run(git, [...GIT_HARDENING, workTree, 'config', '--get-regexp', WORK_TREE_KEYS_PATTERN], opts(SMALL))
  if (wt.cancelled || wt.timedOut || wt.error || (wt.code !== 0 && wt.code !== 1)) return { ok: false, message: gitFailure(wt) }
  const carried = carriedWorkTreeConfig(wt.code === 0 ? wt.stdout.toString('utf8') : '')

  let temp: string | null = null
  try {
    temp = deps.fs.makeTemp()
    const own = pathApi.join(temp, 'git')
    deps.fs.mkdir(own)
    deps.fs.mkdir(pathApi.join(own, 'refs'))
    deps.fs.mkdir(pathApi.join(own, 'objects'))
    deps.fs.mkdir(pathApi.join(own, 'objects', 'info'))
    deps.fs.write(pathApi.join(own, 'HEAD'), headId ? `${headId}\n` : 'ref: refs/heads/unborn\n')
    deps.fs.write(pathApi.join(own, 'config'), format === 'sha1'
      ? `[core]\n\trepositoryformatversion = 0\n\tbare = false\n${carried}`
      : `[core]\n\trepositoryformatversion = 1\n\tbare = false\n${carried}[extensions]\n\tobjectformat = ${format}\n`)
    deps.fs.write(pathApi.join(own, 'objects', 'info', 'alternates'), `${pathApi.join(commonDir, 'objects').replace(/\\/g, '/')}\n`)
    // A split index names its shared part, which git looks for in its own dir.
    for (const name of deps.fs.list(gitDir)) if (/^sharedindex\.[0-9a-f]{40,64}$/.test(name)) deps.fs.copy(pathApi.join(gitDir, name), pathApi.join(own, name))
    const ownEnv = { ...env, GIT_INDEX_FILE: pathApi.join(gitDir, 'index') }
    const gitDirArg = `--git-dir=${own}`
    // The user's own configuration may still name filter drivers (git-lfs):
    // those are emptied too, so no filter runs at all.
    const cfg = await deps.run(git, [...GIT_HARDENING, gitDirArg, 'config', '--get-regexp', '^filter\\.'], opts(SMALL, { cwd: temp, env: ownEnv }))
    if (cfg.cancelled || cfg.timedOut || cfg.error || (cfg.code !== 0 && cfg.code !== 1)) return { ok: false, message: gitFailure(cfg) }
    const filters = filterOverrides(cfg.code === 0 ? cfg.stdout.toString('utf8') : '')
    if (!filters) return { ok: false, message: 'your git configuration names a filter driver this app does not pass to git' }
    const r = await deps.run(git, [...GIT_HARDENING, ...filters, gitDirArg, workTree, 'diff', ...DIFF_HARDENING, '--end-of-options', base, '--'], opts(REVIEW_DIFF_MAX_BYTES, { env: ownEnv }))
    if (r.tooLarge) return tooLarge
    if (r.code !== 0) return { ok: false, message: gitFailure(r) }
    return { ok: true, diff: r.stdout.toString('utf8') }
  } catch {
    return { ok: false, message: 'the change could not be prepared' }
  } finally {
    if (temp) deps.fs.remove(temp)
  }
}

/** An absolute `git` on this process's PATH (absolute entries only), or null. */
export function findGit(pathVar: string | undefined, platform: NodeJS.Platform, isFile: (p: string) => boolean): string | null {
  const win = platform === 'win32'
  const api = win ? path.win32 : path.posix
  const dirs = (pathVar ?? '').split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '' && !d.includes('%') && (win ? /^([A-Za-z]:[\\/]|\\\\[^\\?.])/.test(d) : d.startsWith('/')))
  for (const dir of dirs) {
    const candidate = api.join(dir, win ? 'git.exe' : 'git')
    try { if (isFile(candidate)) return candidate } catch { /* not there */ }
  }
  return null
}

export function defaultReviewDiffDeps(): ReviewDiffDeps {
  const platform = process.platform
  const pathVar = Object.keys(process.env).find((k) => (platform === 'win32' ? k.toUpperCase() : k) === 'PATH')
  return {
    git: () => findGit(pathVar ? process.env[pathVar] : undefined, platform, (p) => fs.statSync(p).isFile()),
    run: (git, args, opts) => new Promise<GitRun>((resolve) => {
      try {
        execFile(git, [...args], {
          cwd: opts.cwd, env: opts.env, encoding: 'buffer', maxBuffer: opts.maxBytes, timeout: opts.timeoutMs, windowsHide: true,
          ...(opts.signal ? { signal: opts.signal } : {}),
        }, (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean }) | null
          const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')
          const empty = Buffer.alloc(0)
          if (e && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { resolve({ code: null, stdout: empty, stderr: '', tooLarge: true }); return }
          if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) { resolve({ code: null, stdout: empty, stderr: '', cancelled: true }); return }
          if (e && e.killed) { resolve({ code: null, stdout: empty, stderr: errText, timedOut: true }); return }
          if (e && typeof e.code === 'string') { resolve({ code: null, stdout: empty, stderr: errText, error: e.code }); return }
          resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? '')), stderr: errText })
        })
      } catch (err) {
        resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', error: (err as Error)?.message ?? 'spawn failed' })
      }
    }),
    env: process.env,
    platform,
    fs: {
      makeTemp: () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-review-diff-')),
      mkdir: (dir) => fs.mkdirSync(dir),
      write: (file, text) => fs.writeFileSync(file, text),
      list: (dir) => { try { return fs.readdirSync(dir) } catch { return [] } },
      copy: (from, to) => fs.copyFileSync(from, to),
      remove: (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* a temp folder left behind is harmless */ } },
    },
  }
}
