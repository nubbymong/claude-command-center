// Every place the app starts a program is a reviewed one. The main process and
// the scripts the app ships (package.json build.files) are parsed, and every
// call that starts a process is listed: a child_process function by its own
// name or by any name a file gives it (an import alias, a promisified or
// injected copy), a `.spawn` / `.execFile` / `.fork` call on any object
// (node-pty, Electron's utilityProcess, an injected port), and `.exec` on the
// child_process module by any name a file gives it, with the expression it
// starts; and each place one of those functions is used as a value (handed to
// a call, or kept as an object's property), where no name follows it any
// further. spawn-site-inventory.json holds the reviewed list:
// each site with how its program is found on Windows and why that holds.
// A site that is not in the list, one whose count changed, and an entry no
// longer found all fail: a new process start is reviewed before it merges.
// A program the Feature Guide promises to look for on Windows only in the
// folders PATH names in full (read from that promise, app-knowledge.ts) is
// never reviewed as started by a bare name there.
// Reads files only; nothing is started.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { parse } from '@babel/parser'

const ROOT = resolve(__dirname, '..', '..', '..')

/** How a site's program is found on Windows, as reviewed. */
const HOW = new Set([
  'full-path', // a full path the app found or was given: PATH's fully qualified folders, a validated install or browser path
  'system-folder', // a Windows tool from the system folder (systemTool, or the validated SystemRoot)
  'app-path', // the app's own executable or a file the app itself put in place (Node's own path, Electron's utility process, a downloaded installer)
  'by-name', // a bare name the system looks up; `programs` names what it starts (never one the Windows lookup promise names), and the reason says why that is accepted
  'not-windows', // runs only on macOS or Linux
  'not-a-process', // the scan's match is not a process start (a method of the app's own named spawn, or a function handed on whose calls are listed sites of their own)
])

const BASE_NAMES = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'execSync', 'exec', 'fork']
const MEMBER_NAMES = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'execSync', 'fork'])
const CHILD_PROCESS = new Set(['child_process', 'node:child_process'])

type Node = { type: string; start: number; end: number; [k: string]: unknown }
const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && typeof (v as Node).type === 'string'
function each(node: unknown, fn: (n: Node) => void): void {
  if (Array.isArray(node)) { for (const c of node) each(c, fn); return }
  if (!isNode(node)) return
  fn(node)
  for (const [k, v] of Object.entries(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k.endsWith('Comments')) continue
    if (v && typeof v === 'object') each(v, fn)
  }
}
const text = (code: string, n: Node | undefined): string =>
  n ? code.slice(n.start, n.end).replace(/\s+/g, ' ').trim().slice(0, 120) : ''

/** The process-start sites in one source file, one string per call:
 *  `<file> :: <callee>(<first argument>`. */
function sitesIn(rel: string, code: string): string[] {
  const ast = parse(code, {
    sourceType: 'unambiguous', plugins: /\.tsx?$/.test(rel) ? ['typescript'] : [],
    allowReturnOutsideFunction: true, errorRecovery: false, attachComment: false,
  })
  // The names this file gives a process-start function, and the names it
  // gives the child_process module itself (a namespace or default import, a
  // plain require), whose `.exec` starts a process too.
  const names = new Set(BASE_NAMES)
  const modules = new Set<string>()
  const requiresChildProcess = (v: unknown): boolean => isNode(v) && v.type === 'CallExpression'
    && (v.callee as { name?: string }).name === 'require'
    && CHILD_PROCESS.has(((v.arguments as Node[])[0] as { value?: string })?.value ?? '')
  each(ast, (n) => {
    if (n.type === 'ImportDeclaration' && CHILD_PROCESS.has((n.source as { value: string }).value)) {
      for (const s of n.specifiers as Node[]) {
        if (s.type === 'ImportSpecifier') names.add((s.local as { name: string }).name)
        else modules.add((s.local as { name: string }).name)
      }
    }
    if (n.type === 'VariableDeclarator' && (n.id as Node).type === 'Identifier' && requiresChildProcess(n.init)) {
      modules.add((n.id as { name: string }).name)
    }
    if (n.type === 'VariableDeclarator' && (n.id as Node).type === 'ObjectPattern' && isNode(n.init)
      && (n.init as Node).type === 'CallExpression' && ((n.init as Node).callee as { name?: string }).name === 'require'
      && CHILD_PROCESS.has((((n.init as Node).arguments as Node[])[0] as { value?: string })?.value ?? '')) {
      for (const p of (n.id as { properties: Node[] }).properties) {
        if (p.type === 'ObjectProperty' && (p.value as Node).type === 'Identifier') names.add((p.value as { name: string }).name)
      }
    }
  })
  // A name bound to an expression that names one of them (a promisified or
  // injected copy: `promisify(execFile)`, `deps.execFile ?? nodeExecFile`).
  // Only a reference to the function counts: not a call's result (a called
  // name), a property's name (`re.exec`, `{ spawn: ... }`), or a type.
  const refers = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(refers)
    if (!isNode(node) || node.type.startsWith('TS') && node.type !== 'TSAsExpression' && node.type !== 'TSNonNullExpression' && node.type !== 'TSSatisfiesExpression') return false
    if (node.type === 'Identifier') return names.has((node as unknown as { name: string }).name)
    for (const [k, v] of Object.entries(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k.endsWith('Comments')) continue
      if (k === 'typeAnnotation' || k === 'returnType' || k === 'typeParameters' || k === 'typeArguments') continue
      if (k === 'callee' && isNode(v) && v.type === 'Identifier') continue
      if (k === 'property' && !node.computed && (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression')) continue
      if (k === 'key' && !node.computed && (node.type === 'ObjectProperty' || node.type === 'ObjectMethod' || node.type === 'ClassMethod' || node.type === 'ClassProperty')) continue
      if (v && typeof v === 'object' && refers(v)) return true
    }
    return false
  }
  for (let grew = true; grew;) {
    grew = false
    each(ast, (n) => {
      if (n.type !== 'VariableDeclarator' || (n.id as Node).type !== 'Identifier' || !isNode(n.init)) return
      const id = (n.id as { name: string }).name
      if (!names.has(id) && refers(n.init)) { names.add(id); grew = true }
    })
  }
  // One of them used as a value -- handed to a call as an argument, or kept as
  // an object's property -- goes where the names above cannot follow it
  // (`run({ go: execFile })`, `const tools = { go: execFile }; tools.go(...)`),
  // so that use is a site of its own, to be reviewed like a call.
  const valueName = (v: unknown): string | null => {
    let x = v
    while (isNode(x) && (x.type === 'TSAsExpression' || x.type === 'TSNonNullExpression' || x.type === 'TSSatisfiesExpression' || x.type === 'ParenthesizedExpression')) x = x.expression
    return isNode(x) && x.type === 'Identifier' && names.has((x as unknown as { name: string }).name) ? (x as unknown as { name: string }).name : null
  }
  const sites: string[] = []
  each(ast, (n) => {
    if (n.type === 'ObjectExpression') {
      for (const p of n.properties as Node[]) {
        const name = p.type === 'ObjectProperty' ? valueName(p.value) : null
        if (name) sites.push(`${rel} :: ${name} kept as the ${p.computed ? `[${text(code, p.key as Node)}]` : text(code, p.key as Node)} property`)
      }
      return
    }
    if (n.type !== 'CallExpression' && n.type !== 'OptionalCallExpression' && n.type !== 'NewExpression') return
    const callee = n.callee as Node
    for (const a of n.arguments as Node[]) {
      const name = valueName(a)
      if (name) sites.push(`${rel} :: ${name} handed to ${text(code, callee)}(`)
    }
    const first = text(code, (n.arguments as Node[])[0])
    if (callee.type === 'Identifier' && names.has((callee as { name: string }).name)) {
      sites.push(`${rel} :: ${(callee as { name: string }).name}(${first}`)
    } else if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && !callee.computed) {
      const property = (callee.property as { name?: string }).name ?? ''
      const object = callee.object as Node
      const onModule = requiresChildProcess(object) || (object.type === 'Identifier' && modules.has((object as unknown as { name: string }).name))
      if (MEMBER_NAMES.has(property) || (property === 'exec' && onModule)) sites.push(`${rel} :: ${text(code, object)}.${property}(${first}`)
    }
  })
  return sites
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
  }
  return out
}
/** The main process's sources and every script the app ships. */
function scopeFiles(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { build: { files: string[] } }
  const shipped = pkg.build.files.filter((f) => /^scripts\/.+\.(js|cjs|mjs)$/.test(f))
  const main = walk(join(ROOT, 'src', 'main')).map((a) => relative(ROOT, a).split(sep).join('/'))
  return [...main, ...shipped].sort()
}
function scan(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const rel of scopeFiles()) {
    for (const s of sitesIn(rel, readFileSync(join(ROOT, rel), 'utf8'))) counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  return counts
}

/** `programs`: what a by-name site starts, as the review read it. */
type Entry = { count: number; how: string; programs?: string[]; reason: string }
const INVENTORY = (JSON.parse(readFileSync(join(__dirname, 'spawn-site-inventory.json'), 'utf8')) as { sites: Record<string, Entry> }).sites
const FOUND = scan()

/** The programs the app promises to look for on Windows only in the folders
 *  PATH names in full, never in the current folder, read from that promise in
 *  the Feature Guide (src/shared/app-knowledge.ts): a program added to it is
 *  guarded here at once. Claude Code starts as `claude`. Empty when the
 *  sentence is gone (a case below fails then). */
const PROMISE_RE = /On Windows the app looks for (.+?) only in the folders that PATH names with a full path, never in the current folder\./
function promisedPrograms(): string[] {
  const m = PROMISE_RE.exec(readFileSync(join(ROOT, 'src', 'shared', 'app-knowledge.ts'), 'utf8'))
  if (!m) return []
  return m[1].split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean)
    .map((s) => (s === 'Claude Code' ? 'claude' : s.toLowerCase()))
}
const PROMISED = promisedPrograms()
/** A program's name without the extension Windows tries for it. */
const programName = (s: string): string => s.toLowerCase().replace(/\.(exe|com|cmd|bat)$/, '')
/** The program a site names by a bare string as its first argument, if any. */
function bareProgram(site: string): string | null {
  const m = /\(\s*['"`]([^'"`\\/]+)['"`]\s*$/.exec(site)
  return m ? programName(m[1]) : null
}
/** Whether a reason names one of the promised programs. */
function namesPromised(text: string): boolean {
  return PROMISED.some((p) => new RegExp(`\\b(${p === 'claude' ? 'claude|Claude Code' : p})\\b`, 'i').test(text))
}
/** Why a reviewed list lets a promised program start by a bare name on
 *  Windows: one line per problem, none when it does not. A site naming one by
 *  a bare string runs off Windows only; a by-name site says which programs it
 *  starts (`programs`, the bare string's among them), none promised, and its
 *  reason names none. */
function promiseViolations(sites: Record<string, Entry>): string[] {
  const out: string[] = []
  for (const [site, e] of Object.entries(sites)) {
    const bare = bareProgram(site)
    if (bare && PROMISED.includes(bare) && e.how !== 'not-windows') out.push(`${site}: ${bare} by a bare name is reviewed as ${e.how}`)
    if (e.how !== 'by-name') continue
    const programs = Array.isArray(e.programs) ? e.programs.map(programName) : []
    if (programs.length === 0) out.push(`${site}: a by-name site names no programs`)
    for (const p of programs) if (PROMISED.includes(p)) out.push(`${site}: ${p} is a promised program`)
    if (bare && !programs.includes(bare)) out.push(`${site}: its programs leave out ${bare}`)
    if (namesPromised(e.reason)) out.push(`${site}: a by-name reason names a promised program`)
  }
  return out
}

describe('every process the app starts is a reviewed site', () => {
  it('the scan reads the shipped scripts as well as the main process', () => {
    const files = scopeFiles()
    for (const f of ['scripts/resume-picker.js', 'src/main/pty-manager.ts']) {
      expect(files, f).toContain(f)
    }
    expect(FOUND.size).toBeGreaterThan(40)
  })

  it('no site is missing from the reviewed list, and none is there more often than reviewed', () => {
    const unreviewed = [...FOUND].filter(([site, n]) => INVENTORY[site]?.count !== n).map(([site, n]) => `${n}x ${site} (reviewed: ${INVENTORY[site]?.count ?? 'none'})`)
    expect(unreviewed, 'review each new or changed site, then add it to spawn-site-inventory.json with how its program is found on Windows and why').toEqual([])
  })

  it('every reviewed site is still there', () => {
    expect(Object.keys(INVENTORY).filter((site) => !FOUND.has(site))).toEqual([])
  })

  it('every reviewed site says how its program is found on Windows, and why that holds', () => {
    for (const [site, e] of Object.entries(INVENTORY)) {
      expect(HOW.has(e.how), `${site}: how=${e.how}`).toBe(true)
      expect(e.reason.length, `${site}: reason`).toBeGreaterThan(30)
    }
  })

  it('a program named by a bare string with no folder in it runs only off Windows, or is reviewed as found by name', () => {
    for (const [site, e] of Object.entries(INVENTORY)) {
      if (/\(\s*['"`][^'"`\\/]+['"`]\s*$/.test(site)) expect(['not-windows', 'by-name'], site).toContain(e.how)
    }
  })

  it('the Feature Guide still makes the Windows lookup promise this list is checked against', () => {
    expect(PROMISED).toEqual(expect.arrayContaining(['claude', 'node', 'git', 'gh', 'npm']))
  })

  it('a program the Windows lookup promise names is never started by a bare name on Windows', () => {
    expect(promiseViolations(INVENTORY)).toEqual([])
  })

  it('the promise check refuses a bare-name start of a promised program, however it is reviewed', () => {
    // The update check's gh entry as it was reviewed before it moved to the
    // full-path start: a by-name site whose reason read the promise narrower
    // than the Feature Guide does.
    const old = "The GitHub CLI by name (gh), as the user's own terminal runs it, for the update check's optional token and private-release fallback. Not one of the programs the full-path rule names (node, git, Claude Code and its helper tools)."
    expect(promiseViolations({ "src/main/github-update.ts :: execFileAsync('gh'": { count: 4, how: 'by-name', reason: old } })).toEqual([
      "src/main/github-update.ts :: execFileAsync('gh': gh by a bare name is reviewed as by-name",
      "src/main/github-update.ts :: execFileAsync('gh': a by-name site names no programs",
      "src/main/github-update.ts :: execFileAsync('gh': its programs leave out gh",
      "src/main/github-update.ts :: execFileAsync('gh': a by-name reason names a promised program",
    ])
    expect(promiseViolations({ "x.ts :: execFile('git.exe'": { count: 1, how: 'full-path', reason: 'r' } })).toEqual(["x.ts :: execFile('git.exe': git by a bare name is reviewed as full-path"])
    expect(promiseViolations({ "x.ts :: spawn('npm'": { count: 1, how: 'not-windows', reason: 'r' } })).toEqual([])
    // A start through a variable: what the review says it starts is checked.
    expect(promiseViolations({ 'x.ts :: spawn(bin': { count: 1, how: 'by-name', programs: ['node.exe'], reason: 'a tool by its name' } })).toEqual(['x.ts :: spawn(bin: node is a promised program'])
    expect(promiseViolations({ 'x.ts :: spawn(bin': { count: 1, how: 'by-name', programs: ['ssh'], reason: 'ssh, or else Claude Code' } })).toEqual(['x.ts :: spawn(bin: a by-name reason names a promised program'])
    expect(promiseViolations({ 'x.ts :: spawn(bin': { count: 1, how: 'by-name', programs: ['ssh'], reason: 'ssh for the GitHub host' } })).toEqual([])
  })
})

describe('the scan finds every way a file can start a process', () => {
  const found = (code: string, rel = 'src/main/x.ts') => sitesIn(rel, code).map((s) => s.slice(`${rel} :: `.length))
  it('a child_process function by its own name, an alias, a promisified or injected copy, a member call', () => {
    const code = [
      "import { spawn as nodeSpawn, execFile } from 'node:child_process'",
      "import * as cp from 'child_process'",
      "import { promisify } from 'util'",
      'const execFileAsync = promisify(execFile)',
      'const run = deps.execFile ?? execFile',
      "nodeSpawn('git', ['status'])",
      "await execFileAsync('gh', ['auth'])",
      "run(tool, [])",
      "cp.execFileSync('node', ['-v'])",
      "pty.spawn(shell, [], {})",
      "utilityProcess.fork(entry)",
      "require('child_process').spawnSync(bin)",
      "spawn(file)",
      'const child = execFile(bin, [])',
      'child.on("exit", () => {})',
    ].join('\n')
    expect(found(code).sort()).toEqual([
      "cp.execFileSync('node'", "execFile(bin", "execFileAsync('gh'", "nodeSpawn('git'", 'pty.spawn(shell',
      "require('child_process').spawnSync(bin", 'run(tool', 'spawn(file', 'utilityProcess.fork(entry',
      'execFile handed to promisify(',
    ].sort())
  })
  it('a CommonJS script\'s destructured require, and nothing in a string or a comment', () => {
    const code = [
      "const { spawnSync: run2, spawn } = require('child_process')",
      "run2('git', [])",
      "// spawn('commented')",
      "const s = \"spawn('in a string')\"",
      'const t = `execFile(${x})`',
      "spawn(first.file, args)",
    ].join('\n')
    expect(found(code, 'scripts/x.js').sort()).toEqual(["run2('git'", 'spawn(first.file'].sort())
  })
  it('exec called on the child_process module by any name a file gives it, and never a pattern\'s or another object\'s exec', () => {
    const code = [
      "import * as cp from 'child_process'",
      "import childProcess from 'node:child_process'",
      "const cpr = require('child_process')",
      "cp.exec('a')",
      "childProcess.exec('b')",
      "cpr?.exec('c')",
      "require('node:child_process').exec('d')",
      'const m = /x/.exec(s)',
      're.exec(s)',
      "other.exec('e')",
    ].join('\n')
    expect(found(code).sort()).toEqual(["childProcess.exec('b'", "cp.exec('a'", "cpr.exec('c'", "require('node:child_process').exec('d'"].sort())
  })
  it('a child_process function used as a value: handed to a call, or kept as an object\'s property, under any name the file gives it', () => {
    const code = [
      "import { execFile, spawn as nodeSpawn } from 'node:child_process'",
      "import { promisify } from 'util'",
      'const tools = { go: execFile }',
      "tools.go('git', ['status'])",
      'useRunner(nodeSpawn)',
      'new Port(execFile!)',
      'const run = promisify(execFile)',
      'register({ run })',
      'const port = { nodeSpawn, [key]: execFile as never }',
      'const other = { spawn: pty.spawn, re: /x/.exec, n: execFile(bin) }',
      'const { spawn: s } = deps',
    ].join('\n')
    expect(found(code).filter((s) => / kept as the | handed to /.test(s)).sort()).toEqual([
      'execFile kept as the go property', 'nodeSpawn handed to useRunner(', 'execFile handed to Port(', 'execFile handed to promisify(',
      'run kept as the run property', 'nodeSpawn kept as the nodeSpawn property', 'execFile kept as the [key] property',
    ].sort())
  })
})
