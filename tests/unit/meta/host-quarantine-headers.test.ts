import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * Suites that plant links, change ACLs or start real processes run in CI and on
 * the test VM only, never on the owner's machine. Host runs pick explicit files
 * and drop every file that carries the quarantine marker, so a suite of that
 * kind without the header is one a host run will happily start. This test finds
 * those suites by reading their source, and fails when one lacks the header in
 * its first 4,000 characters:
 *
 *   // <MARKER>: <what it does>. [CI] [VM] only -- never run on the owner's machine.
 *
 * It only reads files. MARKER is assembled at runtime, so this file never
 * carries it and stays runnable on the host.
 *
 * What it flags, read from the source with comments removed:
 *   links      a symlink or hard-link call that reaches the real fs (fs is not
 *              mocked, or its mock hands the original back) plus a real temp folder
 *   processes  child_process imported and called with no mock, or with a mock that
 *              hands the original back; or node-pty imported with no node-pty mock
 *   acls       any mention of icacls, setCaseSensitiveInfo or takeown, comments
 *              included: an ACL tool is never worth guessing about
 *
 * A text scan cannot see a link, an ACL change or a process reached through app
 * code: a suite that writes the app's config or makes an account folder runs
 * the app's own ACL tool on Windows, and one that prepares a managed launch may
 * ask a real CLI its version. Those suites are named one by one in
 * `headerRequired`, each with what a run of it on the test VM was recorded
 * starting, and this test holds each of them to the header.
 *
 * Exceptions live in host-quarantine-allowlist.json beside this file, each with
 * a reason: `hostSafe` (flagged, safe on the host by design) and
 * `headerRequired` (not flagged, kept off the host anyway).
 */

const ROOT = resolve(__dirname, '..', '..', '..')
const SCOPES = ['tests/unit', 'tests/integration', 'tests/wp1']
const SELF = 'tests/unit/meta/host-quarantine-headers.test.ts'
const HEAD_CHARS = 4000
const MARKER = ['HOST', 'QUARANTINE'].join(' ')
const HEADER = new RegExp(`^// ${MARKER}: \\S`, 'm')
const CODE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/

type Entry = { path: string; reason: string }
type Allowlist = { hostSafe: Entry[]; headerRequired: Entry[] }
const allowlist = JSON.parse(readFileSync(join(__dirname, 'host-quarantine-allowlist.json'), 'utf8')) as Allowlist

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(p, out) }
    else if (CODE_FILE.test(entry.name)) out.push(p)
  }
  return out
}

const hasHeader = (src: string): boolean => HEADER.test(src.slice(0, HEAD_CHARS))

/** The source without comments, so prose about a call is not taken for the call. */
function stripComments(src: string): string {
  return src.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** The full text of every vi.mock / vi.doMock call for `mod` (a regex source), by paren matching. */
function mockCalls(code: string, mod: string): string[] {
  const out: string[] = []
  const re = new RegExp(`vi\\.(?:do)?[mM]ock\\(\\s*['"](?:node:)?(?:${mod})['"]`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    let depth = 0
    let end = m.index + m[0].length
    for (; end < code.length; end++) {
      if (code[end] === '(') depth++
      else if (code[end] === ')') { if (depth === 0) break; depth-- }
    }
    out.push(code.slice(m.index, end + 1))
  }
  return out
}

/** A mock that hands the original back -- a factory parameter (importOriginal),
 *  importActual, a re-import of the module, or { spy: true } -- leaves every
 *  call it does not replace real. */
function passesOriginal(call: string): boolean {
  return /^vi\.(?:do)?[mM]ock\(\s*['"][^'"]+['"]\s*,\s*(?:async\s*)?(?:\(\s*[A-Za-z_$]|[A-Za-z_$][\w$]*\s*=>|\{\s*spy\s*:\s*true)/.test(call) ||
    /importOriginal|importActual|requireActual|import\(\s*['"](?:node:)?(?:fs|child_process|node-pty)/.test(call)
}

/** Every mock of `mod` replaces it outright, and nothing else in the file reaches the original. */
function fullyMocked(code: string, mod: string): boolean {
  const calls = mockCalls(code, mod)
  if (calls.length === 0 || calls.some(passesOriginal)) return false
  return !new RegExp(`(?:importActual|requireActual)\\s*(?:<[^>]*>)?\\s*\\(\\s*['"](?:node:)?(?:${mod})['"]`).test(code)
}

/** What a suite does that keeps it off the host: any of 'links', 'processes', 'acls'. */
function classify(src: string): string[] {
  const code = stripComments(src)
  const outsideMocks = mockCalls(code, '[^\'"]+').reduce((rest, call) => rest.replace(call, ''), code)
  const why: string[] = []

  const linkCall = /\b(?:symlinkSync|symlink|linkSync)\s*\(/.test(code) ||
    /\b\w*(?:fs|fsp|promises)\.link\s*\(/i.test(code) ||
    (/import\s*\{[^}]*\blink\b[^}]*\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/.test(code) && /(?<![.\w$])link\s*\(/.test(code))
  const realTemp = /\bmkdtemp(?:Sync)?\b|\btmpdir\s*\(\s*\)|\b(?:TEST_TMP_ROOT|MOCK_RESOURCES|MOCK_USERDATA|useTestDataDirectory|pinTestDataDirectory)\b/.test(code)
  const fsMocked = fullyMocked(code, 'fs|fs/promises') || /\bmemfs\b/.test(code)
  if (linkCall && realTemp && !fsMocked) why.push('links')

  // Imported for use: a value import, require, import() or importActual -- not
  // a type (`import type`, `typeof import(...)`), and not a mock factory's own.
  // One import statement holds one `from`, so the match stops at the first: in a
  // file written without semicolons it never runs on into the next import.
  const imported = (mod: string): boolean =>
    new RegExp(`^\\s*import\\s+(?!type\\b)(?:(?!\\bfrom\\b)[^;])*?\\bfrom\\s*['"](?:node:)?${mod}['"]`, 'm').test(outsideMocks) ||
    new RegExp(`(?:\\brequire|(?<!typeof\\s+)\\bimport|importActual|requireActual)\\s*(?:<[^>]*>)?\\s*\\(\\s*['"](?:node:)?${mod}['"]\\s*\\)`).test(outsideMocks)
  const cpImported = imported('child_process')
  const cpCalled = /\b(?:spawnSync|execFileSync|execSync|spawn|execFile|fork)\s*\(|(?<![.\w$])exec\s*\(|promisify\(\s*(?:exec|execFile)\s*\)/.test(code)
  const ptyImported = imported('node-pty')
  if ((cpImported && cpCalled && !fullyMocked(code, 'child_process')) || (ptyImported && mockCalls(code, 'node-pty').length === 0)) why.push('processes')

  if (/\b(?:icacls|setCaseSensitiveInfo|takeown)\b/i.test(src)) why.push('acls')
  return why
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** An allowlist path, where `*` stands for part of one path segment. */
const pathPattern = (p: string): RegExp => new RegExp('^' + p.split('*').map(escapeRegExp).join('[^/]*') + '$')

const files = SCOPES.flatMap((s) => walk(join(ROOT, s)))
  .map((abs) => relative(ROOT, abs).split(sep).join('/'))
  .filter((p) => p !== SELF)
  .sort()
const sources = new Map(files.map((p) => [p, readFileSync(join(ROOT, p), 'utf8')]))
const flagged = new Map<string, string[]>()
for (const p of files) {
  const why = classify(sources.get(p)!)
  if (why.length > 0) flagged.set(p, why)
}
const matches = (e: Entry): string[] => files.filter((p) => pathPattern(e.path).test(p))
const hostSafe = new Set(allowlist.hostSafe.flatMap(matches))

describe('every suite that plants links, changes acls or starts processes is marked host quarantine', () => {
  it('scans a real tree (a wrong root or a broken rule would make every check below vacuous)', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(flagged.size).toBeGreaterThan(20)
    for (const kind of ['links', 'processes', 'acls']) {
      expect([...flagged.values()].some((why) => why.includes(kind)), `no suite flagged for ${kind}`).toBe(true)
    }
  })

  it('each flagged suite carries the header in its first 4,000 characters, unless the allowlist says it is host-safe', () => {
    const unmarked = [...flagged]
      .filter(([p]) => !hasHeader(sources.get(p)!) && !hostSafe.has(p))
      .map(([p, why]) => `${p} (${why.join(', ')})`)
    expect(unmarked, `start each of these with "// ${MARKER}: <what it does>. [CI] [VM] only -- never run on the owner's machine."` +
      ` or, if it is safe on the host by design, add it to host-quarantine-allowlist.json with the reason:\n${unmarked.join('\n')}`).toEqual([])
  })

  it('each headerRequired suite carries the header', () => {
    const unmarked = allowlist.headerRequired.flatMap(matches).filter((p) => !hasHeader(sources.get(p)!))
    expect(unmarked).toEqual([])
  })

  it('the allowlist is current: every entry gives a reason and names exactly one file that still needs the exception', () => {
    const problems: string[] = []
    for (const e of [...allowlist.hostSafe, ...allowlist.headerRequired]) {
      if (typeof e.reason !== 'string' || e.reason.trim().length < 20) problems.push(`${e.path}: no reason given`)
      const hit = matches(e)
      if (hit.length !== 1) problems.push(`${e.path}: matches ${hit.length} files, not 1`)
    }
    for (const e of allowlist.hostSafe) for (const p of matches(e)) {
      if (!flagged.has(p)) problems.push(`${p}: no longer flagged; drop it from hostSafe`)
      if (hasHeader(sources.get(p)!)) problems.push(`${p}: carries the header and is listed host-safe; keep one`)
    }
    for (const e of allowlist.headerRequired) for (const p of matches(e)) {
      if (flagged.has(p)) problems.push(`${p}: the rules flag it now; drop it from headerRequired`)
    }
    expect(problems).toEqual([])
  })
})

describe('the host quarantine rules (verify the verifier)', () => {
  const temp = `import { mkdtempSync, symlinkSync } from 'node:fs'\nconst d = mkdtempSync('x')\n`

  it('flags a link planted in a real temp folder, unless fs is replaced outright', () => {
    expect(classify(`${temp}symlinkSync(a, b, 'junction')`)).toEqual(['links'])
    expect(classify(`${temp}fs.linkSync(a, b)`)).toEqual(['links'])
    expect(classify(`${temp}await fsp.link(a, b)`)).toEqual(['links'])
    expect(classify(`vi.mock('fs')\n${temp}symlinkSync(a, b)`)).toEqual([])
    expect(classify(`vi.mock('node:fs', () => fake)\n${temp}symlinkSync(a, b)`)).toEqual([])
    // A fake folder object's own link() is not the fs, and no temp folder means no real link.
    expect(classify(`${temp}fakeRoot.link(a)`)).toEqual([])
    expect(classify(`import { symlinkSync } from 'node:fs'\nsymlinkSync(a, b)`)).toEqual([])
  })

  it('treats a mock that hands the original back as no mock at all', () => {
    expect(classify(`vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal()), x: 1 }))\n${temp}symlinkSync(a, b)`)).toEqual(['links'])
    expect(classify(`vi.mock('fs', async (orig) => ({ ...(await orig()) }))\n${temp}symlinkSync(a, b)`)).toEqual(['links'])
    expect(classify(`vi.mock('fs')\nconst real = await vi.importActual('fs')\n${temp}real.symlinkSync(a, b)`)).toEqual(['links'])
    const keepsSpawnSync = `import { spawnSync } from 'node:child_process'\nvi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal()), execFile: vi.fn() }))\nspawnSync('sh')`
    expect(classify(keepsSpawnSync)).toEqual(['processes'])
  })

  it('flags a real process start, and not a type-only import, a full mock or a mock factory\'s own import', () => {
    expect(classify(`import { execFileSync } from 'node:child_process'\nexecFileSync('git', ['status'])`)).toEqual(['processes'])
    expect(classify(`const { spawnSync } = await import('node:child_process')\nspawnSync('node')`)).toEqual(['processes'])
    expect(classify(`import { spawn } from 'node-pty'\nspawn('pwsh', [], {})`)).toEqual(['processes'])
    expect(classify(`vi.mock('node:child_process', () => ({}))\nconst real = await vi.importActual<typeof import('node:child_process')>('node:child_process')\nreal.execFile('cmd')`)).toEqual(['processes'])
    expect(classify(`import type { ChildProcess } from 'node:child_process'\nconst m = re.exec(s)`)).toEqual([])
    expect(classify(`let cp: typeof import('node:child_process')\nfakePty.spawn('x')`)).toEqual([])
    expect(classify(`import { execFileSync } from 'node:child_process'\nvi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))\nexecFileSync('git')`)).toEqual([])
    expect(classify(`vi.mock('child_process', async () => ({ ...(await import('child_process')) }))\nconst p = fake.spawn(x)`)).toEqual([])
    expect(classify(`import { spawn } from 'node-pty'\nvi.mock('node-pty', () => ({ spawn: vi.fn() }))`)).toEqual([])
  })

  it('reads each import statement on its own, with or without semicolons', () => {
    // A type-only import after a value import, and a local function named like a
    // process call, in a file with no semicolons: nothing is imported for use.
    const typeAfterValue = `import { EventEmitter } from 'node:events'\nimport type { ChildProcess } from 'node:child_process'\nfunction exec(step) { return step() }\nexec(() => 1)`
    expect(classify(typeAfterValue)).toEqual([])
    // A value import written over several lines still counts, with or without semicolons.
    expect(classify(`import { x } from 'y'\nimport {\n  execFileSync,\n} from 'node:child_process'\nexecFileSync('git')`)).toEqual(['processes'])
    expect(classify(`import { x } from 'y';\nimport {\n  execFileSync,\n} from 'node:child_process';\nexecFileSync('git');`)).toEqual(['processes'])
  })

  it('flags any ACL tool, even one named only in a comment', () => {
    expect(classify(`execFileSync('icacls', [dir])`)).toEqual(['acls'])
    expect(classify(`// runs TAKEOWN on the folder`)).toEqual(['acls'])
    expect(classify(`// fsutil file setCaseSensitiveInfo`)).toEqual(['acls'])
  })

  it('ignores link and process calls that appear only in comments', () => {
    expect(classify(`${temp}// symlinkSync(a, b) would plant a link here`)).toEqual([])
    expect(classify(`import { execSync } from 'child_process'\n/* execSync('rm') is what we avoid */`)).toEqual([])
    // A // inside a string is not a comment: the call after it still counts.
    expect(classify(`import { execSync } from 'child_process'\nconst u = 'https://example.test/x'; execSync('git')`)).toEqual(['processes'])
  })

  it('accepts the header only as a line comment, in its exact case, within the first 4,000 characters', () => {
    const line = `// ${MARKER}: plants hard links. [CI] [VM] only -- never run on the owner's machine.`
    expect(hasHeader(`${line}\nimport x from 'y'`)).toBe(true)
    expect(hasHeader(`// a note\n${line}\n`)).toBe(true)
    expect(hasHeader(`${'x'.repeat(HEAD_CHARS)}\n${line}`)).toBe(false)
    expect(hasHeader(line.toLowerCase())).toBe(false)
    expect(hasHeader(`const s = '${line}'`)).toBe(false)
    expect(hasHeader(`// ${MARKER}:\n`)).toBe(false)
  })

  it('matches an allowlist pattern within one path segment only', () => {
    expect(pathPattern('tests/wp1/a-*-gate.test.ts').test('tests/wp1/a-b-gate.test.ts')).toBe(true)
    expect(pathPattern('tests/wp1/a-*-gate.test.ts').test('tests/wp1/a-b/c-gate.test.ts')).toBe(false)
    expect(pathPattern('tests/unit/x.test.ts').test('tests/unit/xytest.ts')).toBe(false)
  })
})
