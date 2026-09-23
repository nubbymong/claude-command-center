// WP1.55 / WP1.66 / WP1.57: dependency-boundary enforcement, AST-based (the
// Babel TypeScript parser; the installed TypeScript 7 native port exposes no
// stable JS compiler API). The repo has no lint vehicle, so this suite IS the
// enforcement the design calls "dependency-boundary tests and lint rules".
//
// Rules, over every production source file under src/ (tests are consumers
// of internals by design and are out of scope). Each rule is a pure function
// over extracted facts so the self-test can feed it synthetic violations.
//   R1 provider core (src/shared/providers, src/main/providers/core, the
//      neutral src/main/providers/{index,types,host-color-scheme}.ts,
//      src/renderer/providers/core) reaches no concrete provider module,
//      directly or TRANSITIVELY through any re-exporting intermediary.
//   R2 the Claude and Codex packages never import each other directly; the
//      transitive reach between them through shared main modules is a
//      ratchet against a committed allowlist (the base already entangles
//      them through conductor-mcp-server).
//   R3 only the two composition roots import both packages and register
//      them: any REFERENCE to a register function outside the roots, the
//      registry definitions and the entry-point re-exports fails (aliasing,
//      member calls and indirect calls included), and boot goes through the
//      roots (main/index.ts imports the main root and calls it before its
//      first getProvider; renderer/main.tsx imports the renderer root above
//      App). A shared module importing exactly one package entry point fails.
//      R3 also pins `applyRealmEnvPatch` to the registry: it takes its policy
//      as an ARGUMENT, so any caller reaching past realmEnvForProvider can
//      hand it an empty ambient list and opt out of the D3 removal entirely.
//      The shared barrel re-exports it, so only a home list makes "the launch
//      path cannot opt out" an enforced rule rather than a comment.
//   R4 deep imports into a package (Claude, Codex or core) from outside it
//      are a ratchet: every one is in the committed allowlist with either a
//      non-retain ledger disposition or a recorded exemption; every allowlist
//      entry must still exist; at the candidate phase only owner-approved
//      exemptions may remain.
//   R5 provider-name conditionals are absent from core and the roots beyond
//      the enumerated allowlist (empty): `=== 'codex'`, template literals,
//      case clauses, .includes/.startsWith/.endsWith/.match/Object.is with a
//      provider literal, `.codexEnabled` (member, optional, computed,
//      destructured), `isCodex`.
//   R6 renderer core never touches a provider-specific IPC or preload
//      surface: `IPC.CODEX_*`, `electronAPI.codex`, through an alias, a
//      destructuring or a non-literal computed key.
//   R7 every package has its entry point; every file inside a package
//      directory is reachable from that entry point through in-package
//      imports (a consumer cannot be moved in to dodge R4) beyond a
//      committed orphan ratchet; no production alias/paths config exists
//      that would let a specifier escape the graph; every file parses
//      cleanly (a recovered parse error is a failure, not a silent hole).
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse } from '@babel/parser'
import { resolvePhase } from './phase'
type Node = { type: string; start?: number | null; end?: number | null; loc?: unknown }

const ROOT = resolve(__dirname, '..', '..')
const rel = (abs: string) => abs.replace(/\\/g, '/').slice(ROOT.replace(/\\/g, '/').length + 1)
const lower = (p: string) => p.toLowerCase()

const CORE_DIRS = ['src/shared/providers/', 'src/main/providers/core/', 'src/renderer/providers/core/']
const CORE_FILES = ['src/main/providers/index.ts', 'src/main/providers/types.ts', 'src/main/providers/host-color-scheme.ts']
const ROOTS = { main: 'src/main/providers/compose.ts', renderer: 'src/renderer/providers/index.ts' }
const ROOT_FILES = [ROOTS.main, ROOTS.renderer, 'src/renderer/providers/compose-at-load.ts']
const REGISTER_FNS = ['registerProviderPackage', 'registerRendererProvider', 'registerProvider']
// Applying a realm env patch directly bypasses the package's own policy; only
// the definition, the barrel that re-exports it and the registry wrapper may
// name it. The composition roots are NOT exempt (they compose, not launch).
const LAUNCH_ENV_FNS = ['applyRealmEnvPatch']
const LAUNCH_ENV_HOMES = ['src/shared/providers/realm-env.ts', 'src/shared/providers/index.ts', 'src/main/providers/core/registry.ts']
const REGISTER_HOMES = ['src/main/providers/core/registry.ts', 'src/main/providers/core/index.ts', 'src/main/providers/index.ts', 'src/renderer/providers/core/registry.ts', 'src/renderer/providers/core/index.ts']
const PKG_RE = /^src\/(main|renderer)\/providers\/(claude|codex|core)\//
const SHARED_CORE_RE = /^src\/shared\/providers\//
const pkgDir = (side: 'main' | 'renderer', id: string) => `src/${side}/providers/${id}/`
const CONCRETE_TARGET = /(^|\/)providers\/(claude|codex)\/|(^|\/)(codex|claude)[-\w]*\.tsx?$|codexaccountstore|account-profiles|profile-consumers|claude-account-identity|account-web\//
const OPS = new Set(['===', '!==', '==', '!='])
const NAME_LITERALS = new Set(['claude', 'codex'])
const LITERAL_CALLS = new Set(['includes', 'startsWith', 'endsWith', 'match', 'test', 'is'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(name)) out.push(p)
  }
  return out
}

function resolveSpecifier(fromAbs: string, spec: string): string | null {
  const s = spec.replace(/\\/g, '/')
  if (!s.startsWith('.')) return null // packages; production aliases are asserted absent (R7)
  const base = resolve(dirname(fromAbs), s)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, join(base, 'index.ts'), join(base, 'index.tsx'), base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return rel(c)
  return null
}

export interface FileFacts {
  path: string
  imports: string[]
  registerRefs: string[]
  launchEnvRefs: string[]
  conditionals: string[]
  providerIpc: string[]
  parseErrors: string[]
}
type AnyNode = Node & { [k: string]: unknown }
const isNode = (v: unknown): v is AnyNode => !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string'
const str = (n: unknown): string | null => {
  if (!isNode(n)) return null
  if (n.type === 'StringLiteral') return (n as { value: string }).value
  if (n.type === 'TemplateLiteral') {
    const quasis = n.quasis as Array<{ value: { cooked: string } }>
    const exprs = n.expressions as unknown[]
    if (quasis.length === 1 && exprs.length === 0) return quasis[0].value.cooked
  }
  return null
}
const providerLiteral = (n: unknown) => NAME_LITERALS.has(str(n) ?? '')

function eachChild(node: AnyNode, fn: (child: AnyNode) => void): void {
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
    const v = node[key]
    if (Array.isArray(v)) { for (const item of v) if (isNode(item)) fn(item) }
    else if (isNode(v)) fn(v)
  }
}

/** The facts the rules need, extracted from one parsed file. */
export function extractFacts(path: string, text: string, resolveFrom?: string): FileFacts {
  const facts: FileFacts = { path, imports: [], registerRefs: [], launchEnvRefs: [], conditionals: [], providerIpc: [], parseErrors: [] }
  let ast: AnyNode
  try {
    const parsed = parse(text, { sourceType: 'module', plugins: /\.[jt]sx$/.test(path) ? ['typescript', 'jsx'] : ['typescript'], errorRecovery: true, attachComment: false })
    for (const e of (parsed.errors ?? []) as Array<{ reasonCode?: string; message?: string }>) facts.parseErrors.push(`${path}: ${e.reasonCode ?? e.message}`)
    ast = parsed.program as unknown as AnyNode
  } catch (e) {
    facts.parseErrors.push(`${path}: ${(e as Error).message}`)
    return facts
  }
  const line = (n: AnyNode) => (n.loc as { start: { line: number } } | undefined)?.start.line ?? 0
  const snippet = (n: AnyNode) => text.slice(n.start ?? 0, n.end ?? 0).slice(0, 80)
  const addSpec = (spec: string | null) => { if (spec === null) return; const r = resolveFrom ? resolveSpecifier(resolveFrom, spec) : spec; if (r) facts.imports.push(r) }
  const ipcAliases = new Set<string>(['electronAPI', 'IPC'])
  const isIpcObject = (n: AnyNode): boolean => {
    const t = snippet(n)
    if (/electronAPI|\bIPC\b/.test(t)) return true
    return n.type === 'Identifier' && ipcAliases.has(n.name as string)
  }
  const visit = (n: AnyNode) => {
    switch (n.type) {
      case 'ImportDeclaration': case 'ExportNamedDeclaration': case 'ExportAllDeclaration':
        if (n.source) addSpec(str(n.source)); break
      case 'TSImportType': addSpec(str(n.argument)); break
      case 'CallExpression': case 'OptionalCallExpression': {
        const callee = n.callee as AnyNode
        const args = n.arguments as AnyNode[]
        if (callee.type === 'Import') addSpec(str(args[0]))
        else if (callee.type === 'Identifier' && callee.name === 'require') addSpec(str(args[0]))
        if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')) {
          const prop = callee.property as AnyNode
          const name = !callee.computed && prop.type === 'Identifier' ? (prop.name as string) : str(prop) ?? ''
          const obj = callee.object as AnyNode
          if (LITERAL_CALLS.has(name) && (args.some(providerLiteral) || (obj.type === 'ArrayExpression' && (obj.elements as AnyNode[]).some(providerLiteral)))) facts.conditionals.push(`${path}:${line(n)} ${snippet(n)}`)
          if (name === 'match' || name === 'test') { const re = args[0] ?? obj; if (isNode(re) && re.type === 'RegExpLiteral' && /codex|claude/i.test(re.pattern as string)) facts.conditionals.push(`${path}:${line(n)} ${snippet(n)}`) }
        }
        break
      }
      case 'Identifier':
        if (REGISTER_FNS.includes(n.name as string)) facts.registerRefs.push(n.name as string)
        if (LAUNCH_ENV_FNS.includes(n.name as string)) facts.launchEnvRefs.push(n.name as string)
        if (n.name === 'isCodex') facts.conditionals.push(`${path}:${line(n)} isCodex`)
        break
      case 'VariableDeclarator': {
        const init = n.init as AnyNode | null
        const id = n.id as AnyNode
        if (init && isIpcObject(init)) {
          if (id.type === 'Identifier') ipcAliases.add(id.name as string)
          if (id.type === 'ObjectPattern') for (const p of id.properties as AnyNode[]) {
            const key = p.key as AnyNode | undefined
            const kn = key ? (key.type === 'Identifier' ? (key.name as string) : str(key) ?? '') : ''
            if (/^CODEX_/.test(kn) || kn === 'codex' || kn === 'codexReview') facts.providerIpc.push(`${path}:${line(n)} ${snippet(n)}`)
          }
        }
        if (id.type === 'ObjectPattern') for (const p of id.properties as AnyNode[]) {
          const key = p.key as AnyNode | undefined
          if (key && ((key.type === 'Identifier' && key.name === 'codexEnabled') || str(key) === 'codexEnabled')) facts.conditionals.push(`${path}:${line(n)} { codexEnabled }`)
        }
        break
      }
      case 'BinaryExpression':
        if (OPS.has(n.operator as string) && [n.left, n.right].some(providerLiteral)) facts.conditionals.push(`${path}:${line(n)} ${snippet(n)}`)
        break
      case 'SwitchCase':
        if (providerLiteral(n.test)) facts.conditionals.push(`${path}:${line(n)} case '${str(n.test)}'`)
        break
      case 'MemberExpression': case 'OptionalMemberExpression': {
        const prop = n.property as AnyNode
        const obj = n.object as AnyNode
        const literalName = !n.computed && prop.type === 'Identifier' ? (prop.name as string) : n.computed ? str(prop) : ''
        if (literalName === 'codexEnabled') facts.conditionals.push(`${path}:${line(n)} .codexEnabled`)
        const ipcObj = isIpcObject(obj)
        if (literalName === null && n.computed && ipcObj) facts.providerIpc.push(`${path}:${line(n)} ${snippet(n)} (non-literal key)`)
        else if (literalName && (/^CODEX_/.test(literalName) || ((literalName === 'codex' || literalName === 'codexReview') && ipcObj))) facts.providerIpc.push(`${path}:${line(n)} ${snippet(n)}`)
        break
      }
    }
    eachChild(n, visit)
  }
  visit(ast)
  return facts
}

// ---------------------------------------------------------------------------
// Rules over facts (pure, so the self-test can feed synthetic violations).
// ---------------------------------------------------------------------------
export interface Allowlists {
  deepImports: Array<{ from: string; to: string; exempt?: { reason: string; decision: string } }>
  conditionals: string[]
  crossPackageReach: Array<{ from: string; via: string; to: string }>
  packageOrphans: string[]
  ledgerNonRetain: Set<string>
  phase: 'gate0' | 'candidate'
}
const isCore = (p: string) => CORE_DIRS.some((d) => lower(p).startsWith(d)) || CORE_FILES.includes(lower(p))
const packageOf = (p: string): { side: 'main' | 'renderer'; id: 'claude' | 'codex' | 'core' } | null => {
  const m = PKG_RE.exec(lower(p))
  return m ? { side: m[1] as 'main' | 'renderer', id: m[2] as 'claude' | 'codex' | 'core' } : null
}
const samePackage = (a: string, b: string) => { const x = packageOf(a), y = packageOf(b); return !!x && !!y && x.side === y.side && x.id === y.id }
// The entry point is the PACKAGE ROOT index only. Matching any nested
// index.ts let a deep import into src/main/providers/core/sub/index.ts pass
// every rule: R4 skipped it as an entry point, and R3 covers only the two
// concrete packages.
const isEntryPoint = (p: string) => {
  const pk = packageOf(p)
  return !!pk && lower(p) === `${pkgDir(pk.side, pk.id)}index.ts`
}

function graph(files: FileFacts[]): Map<string, string[]> {
  return new Map(files.map((f) => [f.path, f.imports]))
}
/** BFS from `start`; `through` decides which intermediate nodes may be expanded. */
function reachable(g: Map<string, string[]>, start: string, through: (p: string) => boolean): Map<string, string> {
  const parent = new Map<string, string>()
  const queue = [start]
  while (queue.length) {
    const cur = queue.shift()!
    for (const next of g.get(cur) ?? []) {
      if (parent.has(next) || next === start) continue
      parent.set(next, cur)
      if (through(next)) queue.push(next)
    }
  }
  return parent
}
const chain = (parent: Map<string, string>, target: string, start: string) => {
  const out = [target]
  let cur = target
  while (parent.get(cur) && parent.get(cur) !== start) { cur = parent.get(cur)!; out.unshift(cur) }
  return [start, ...out].join(' -> ')
}

export function ruleCorePurity(files: FileFacts[]): string[] {
  const g = graph(files)
  const out: string[] = []
  for (const f of files.filter((f) => isCore(f.path))) {
    const parent = reachable(g, f.path, () => true)
    for (const t of parent.keys()) if (!isCore(t) && CONCRETE_TARGET.test(lower(t))) out.push(`R1 core reaches a concrete provider: ${chain(parent, t, f.path)}`)
  }
  return out
}

export function ruleCrossPackage(files: FileFacts[], allow: Allowlists['crossPackageReach']): string[] {
  const g = graph(files)
  const out: string[] = []
  const found = new Set<string>()
  for (const f of files) {
    const own = packageOf(f.path)
    if (!own || own.id === 'core') continue
    const other = pkgDir(own.side, own.id === 'claude' ? 'codex' : 'claude')
    for (const t of f.imports) if (lower(t).startsWith(other)) out.push(`R2 direct cross-package import: ${f.path} -> ${t}`)
    const parent = reachable(g, f.path, (p) => !lower(p).startsWith(other) && !samePackage(p, f.path))
    for (const t of parent.keys()) {
      if (!lower(t).startsWith(other)) continue
      const via = parent.get(t)!
      if (samePackage(via, f.path)) continue // reported from the file that leaves the package
      found.add(`${f.path} -> ${via} -> ${t}`)
    }
  }
  const allowed = new Set(allow.map((e) => `${e.from} -> ${e.via} -> ${e.to}`))
  for (const x of [...found].sort()) if (!allowed.has(x)) out.push(`R2 new transitive cross-package reach (route through the entry point or record it): ${x}`)
  for (const x of [...allowed].sort()) if (!found.has(x)) out.push(`R2 stale cross-package allowlist entry (remove it; the list only shrinks): ${x}`)
  return out
}

export function ruleRoots(files: FileFacts[]): string[] {
  const out: string[] = []
  for (const side of ['main', 'renderer'] as const) {
    const both = files.filter((f) => f.imports.some((t) => lower(t).startsWith(pkgDir(side, 'claude'))) && f.imports.some((t) => lower(t).startsWith(pkgDir(side, 'codex')))).map((f) => f.path).sort()
    if (both.join(',') !== ROOTS[side]) out.push(`R3 files importing both ${side} packages must be exactly [${ROOTS[side]}], got [${both.join(', ')}]`)
    for (const f of files) {
      if (ROOT_FILES.includes(f.path) || packageOf(f.path)) continue
      for (const t of f.imports) {
        const p = packageOf(t)
        if (p && p.side === side && p.id !== 'core' && isEntryPoint(t)) out.push(`R3 a module other than the composition root imports a package entry point: ${f.path} -> ${t}`)
      }
    }
  }
  for (const f of files) {
    if (!f.registerRefs.length || ROOT_FILES.includes(f.path) || REGISTER_HOMES.includes(f.path)) continue
    out.push(`R3 register function referenced outside the composition roots: ${f.path} (${[...new Set(f.registerRefs)].join(',')})`)
  }
  for (const f of files) {
    if (!f.launchEnvRefs.length || LAUNCH_ENV_HOMES.includes(f.path)) continue
    out.push(`R3 realm env applied outside the registry (go through realmEnvForProvider, which takes the policy from the package): ${f.path} (${[...new Set(f.launchEnvRefs)].join(',')})`)
  }
  const main = files.find((f) => f.path === ROOTS.main)
  if (main) for (const fn of ['registerProviderPackage']) if (!main.registerRefs.includes(fn)) out.push(`R3 ${ROOTS.main} does not reference ${fn}`)
  const renderer = files.find((f) => f.path === ROOTS.renderer)
  if (renderer && !renderer.registerRefs.includes('registerRendererProvider')) out.push(`R3 ${ROOTS.renderer} does not reference registerRendererProvider`)
  return out
}

export function ruleDeepImports(files: FileFacts[], allow: Allowlists): string[] {
  const out: string[] = []
  const found = new Set<string>()
  for (const f of files) {
    for (const t of f.imports) {
      const target = packageOf(t)
      if (!target || isEntryPoint(t) || samePackage(f.path, t)) continue
      found.add(`${f.path} -> ${t}`)
    }
  }
  const allowed = new Map(allow.deepImports.map((e) => [`${e.from} -> ${e.to}`, e]))
  for (const x of [...found].sort()) if (!allowed.has(x)) out.push(`R4 new deep import (route through the package entry point): ${x}`)
  for (const [x, e] of allowed) {
    if (!found.has(x)) { out.push(`R4 stale allowlist entry (remove it; the list only shrinks): ${x}`); continue }
    const dispositioned = allow.ledgerNonRetain.has(e.from)
    if (!dispositioned && !e.exempt) out.push(`R4 allowlist entry has neither a non-retain ledger disposition nor a recorded exemption: ${x}`)
    if (allow.phase === 'candidate' && !(e.exempt && /^owner-approved/.test(e.exempt.decision))) out.push(`R4 deep import still present at the candidate without an owner-approved exemption: ${x}`)
  }
  return out
}

export function ruleConditionals(files: FileFacts[], allow: string[]): string[] {
  return files.filter((f) => isCore(f.path) || ROOT_FILES.includes(f.path)).flatMap((f) => f.conditionals).filter((h) => !allow.includes(h)).map((h) => `R5 provider-name conditional in core/root: ${h}`)
}

export function ruleProviderIpc(files: FileFacts[]): string[] {
  return files.filter((f) => isCore(f.path)).flatMap((f) => f.providerIpc).map((h) => `R6 provider-specific IPC/preload surface in core: ${h}`)
}

export function rulePackageMembership(files: FileFacts[], orphanAllow: string[]): string[] {
  const out: string[] = []
  const g = graph(files)
  const found = new Set<string>()
  for (const side of ['main', 'renderer'] as const) for (const id of ['claude', 'codex', 'core'] as const) {
    const dir = pkgDir(side, id)
    const members = files.filter((f) => lower(f.path).startsWith(dir)).map((f) => f.path)
    if (!members.length) { if (id !== 'core') out.push(`R7 package ${dir} has no files`); continue }
    const entry = members.find((p) => lower(p) === `${dir}index.ts`)
    if (!entry) { out.push(`R7 package ${dir} has no index.ts entry point`); continue }
    const parent = reachable(g, entry, (p) => lower(p).startsWith(dir))
    for (const m of members) if (m !== entry && !parent.has(m)) found.add(m)
  }
  const allowed = new Set(orphanAllow)
  for (const x of [...found].sort()) if (!allowed.has(x)) out.push(`R7 file inside a package directory is not reachable from its entry point (move it out or import it): ${x}`)
  for (const x of [...allowed].sort()) if (!found.has(x)) out.push(`R7 stale orphan allowlist entry (remove it): ${x}`)
  return out
}

export function ruleParseErrors(files: FileFacts[]): string[] {
  return files.flatMap((f) => f.parseErrors).map((e) => `R7 parse error (a file that does not parse is invisible to every rule): ${e}`)
}

// ---------------------------------------------------------------------------
// Live run.
// ---------------------------------------------------------------------------
const files = walk(resolve(ROOT, 'src')).map((abs) => extractFacts(rel(abs), readFileSync(abs, 'utf8'), abs))
const byPath = new Map(files.map((f) => [f.path, f]))
const deepImportAllowlist = JSON.parse(readFileSync(resolve(__dirname, 'deep-import-allowlist.json'), 'utf8')) as { entries: Allowlists['deepImports'] }
const conditionalAllowlist = JSON.parse(readFileSync(resolve(__dirname, 'provider-conditional-allowlist.json'), 'utf8')) as { entries: string[] }
const crossReachAllowlist = JSON.parse(readFileSync(resolve(__dirname, 'cross-package-reach-allowlist.json'), 'utf8')) as { entries: Allowlists['crossPackageReach'] }
const orphanAllowlist = JSON.parse(readFileSync(resolve(__dirname, 'package-orphans-allowlist.json'), 'utf8')) as { entries: string[] }
const ledger = JSON.parse(readFileSync(resolve(__dirname, 'legacy-codex-ledger.json'), 'utf8')) as { entries: Array<{ path: string; disposition: string }> }
const allow: Allowlists = {
  deepImports: deepImportAllowlist.entries,
  conditionals: conditionalAllowlist.entries,
  crossPackageReach: crossReachAllowlist.entries,
  packageOrphans: orphanAllowlist.entries,
  // `added` is a file WP1 created, not a legacy consumer WP1 is rebuilding:
  // the manifest groups it with `retain`, so R4 must too. Otherwise a
  // brand-new file can deep-import package internals on a bare allowlist line
  // with no recorded exemption.
  ledgerNonRetain: new Set(ledger.entries.filter((e) => e.disposition !== 'retain' && e.disposition !== 'added').map((e) => e.path)),
  phase: resolvePhase(undefined, { eager: false }),
}

describe('WP1.55 dependency boundaries (AST)', () => {
  it('analysed the production source graph cleanly', () => {
    expect(files.length).toBeGreaterThan(300)
    expect(byPath.has(ROOTS.main) && byPath.has(ROOTS.renderer)).toBe(true)
    expect(byPath.get('src/main/pty-manager.ts')!.imports.length).toBeGreaterThan(20)
    expect(ruleParseErrors(files)).toEqual([])
  })
  it('R1: provider core reaches no concrete provider module, directly or transitively', () => { const p = ruleCorePurity(files); expect(p, p.join('\n')).toEqual([]) })
  it('R2: no direct cross-package import; transitive reach only as recorded', () => { const p = ruleCrossPackage(files, allow.crossPackageReach); expect(p, p.join('\n')).toEqual([]) })
  it('R3: exactly the composition roots import both packages, reference the register functions, and are the only entry-point consumers', () => { const p = ruleRoots(files); expect(p, p.join('\n')).toEqual([]) })
  it('R4: deep imports into a package are a ratchet with a disposition or exemption per entry', () => { const p = ruleDeepImports(files, allow); expect(p, p.join('\n')).toEqual([]) })
  it('R5: no provider-name conditionals in core or the roots beyond the enumerated allowlist', () => { const p = ruleConditionals(files, allow.conditionals); expect(p, p.join('\n')).toEqual([]) })
  it('R6: renderer core touches no provider-specific IPC or preload surface', () => { const p = ruleProviderIpc(files); expect(p, p.join('\n')).toEqual([]) })
  it('R7: every package has its entry point and every file in it is reachable from that entry point (orphans only as recorded)', () => { const p = rulePackageMembership(files, allow.packageOrphans); expect(p, p.join('\n')).toEqual([]) })

  it('R3 boot wiring: main boots through the main root before its first getProvider; the renderer imports its root above App', () => {
    const main = readFileSync(resolve(ROOT, 'src/main/index.ts'), 'utf8')
    expect(byPath.get('src/main/index.ts')!.imports).toContain(ROOTS.main)
    // The first runtime consumer of the registry in boot order is the
    // statusline deploy chain; the comment above the call mentions getProvider
    // too, so anchor on the consumer expression, not the bare identifier.
    const consumer = main.indexOf("getProvider('claude').deployStatuslineScript")
    expect(consumer).toBeGreaterThan(0)
    expect(main.indexOf('composeProviders()')).toBeGreaterThan(0)
    expect(main.indexOf('composeProviders()')).toBeLessThan(consumer)
    const entry = byPath.get('src/renderer/main.tsx')!
    const rootIdx = entry.imports.indexOf('src/renderer/providers/compose-at-load.ts')
    const appIdx = entry.imports.indexOf('src/renderer/App.tsx')
    expect(rootIdx).toBeGreaterThanOrEqual(0)
    expect(appIdx).toBeGreaterThan(rootIdx)
    expect(byPath.get('src/renderer/providers/compose-at-load.ts')!.imports).toContain(ROOTS.renderer)
  })

  it('R7 no production alias or paths config can let a specifier escape the graph', () => {
    for (const cfg of ['tsconfig.node.json', 'tsconfig.web.json', 'tsconfig.bridge.json']) {
      const j = JSON.parse(readFileSync(resolve(ROOT, cfg), 'utf8').replace(/^\s*\/\/.*$/gm, ''))
      expect(j.compilerOptions?.paths, `${cfg} compilerOptions.paths`).toBeUndefined()
      expect(j.compilerOptions?.baseUrl, `${cfg} compilerOptions.baseUrl`).toBeUndefined()
    }
    expect(/\balias\b/.test(readFileSync(resolve(ROOT, 'electron.vite.config.ts'), 'utf8'))).toBe(false)
    expect(JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).imports).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Verify-the-verifier: the extractor sees every construct, and every rule
  // goes red on a synthetic violation.
  // -------------------------------------------------------------------------
  it('the extractor sees every construct the rules depend on', () => {
    const probe = [
      "import { a } from './x'", "export * from './y'", "export { b } from './b'", "const z = require('./z')", "const d = await import('./d')",
      "type T = import('./t').T", "if (p.provider === 'codex') {}", "const q = 'claude' !== r", "if (p === `codex`) {}",
      "switch (q) { case 'claude': break }", "if (['codex'].includes(p)) {}", "if (p.startsWith('codex')) {}", "if (Object.is(p, 'codex')) {}",
      "if (p.match(/^codex$/)) {}", "const e = s.codexEnabled", "const f = s?.codexEnabled", "const g = s['codexEnabled']", "const { codexEnabled } = s",
      "if (isCodex) {}", "const r1 = registerProviderPackage; r1(pkg)", "registry.registerRendererProvider(d)", "[registerProvider][0](p)",
      "applyRealmEnvPatch(base, patch, policy)", "const ap = applyRealmEnvPatch; ap(b, p2, q)",
      "window.electronAPI.codex.status()", "IPC.CODEX_LOGIN", "IPC['CODEX_LOGOUT']", "IPC[`CODEX_${x}`]", "const api = window.electronAPI; api.codex.status()",
      "const { codex } = window.electronAPI", "const { CODEX_LOGIN } = IPC", "const generic = <T,>(v: T) => v",
    ].join('\n')
    const f = extractFacts('probe.ts', probe)
    expect(f.parseErrors).toEqual([])
    expect(f.imports).toEqual(['./x', './y', './b', './z', './d', './t'])
    expect([...new Set(f.registerRefs)].sort()).toEqual(['registerProvider', 'registerProviderPackage', 'registerRendererProvider'])
    expect([...new Set(f.launchEnvRefs)]).toEqual(['applyRealmEnvPatch'])
    expect(f.conditionals.map((c) => c.replace(/^probe\.ts:\d+ /, ''))).toEqual([
      "p.provider === 'codex'", "'claude' !== r", 'p === `codex`', "case 'claude'", "['codex'].includes(p)", "p.startsWith('codex')", "Object.is(p, 'codex')", 'p.match(/^codex$/)',
      '.codexEnabled', '.codexEnabled', '.codexEnabled', '{ codexEnabled }', 'isCodex',
    ])
    expect(f.providerIpc.map((c) => c.replace(/^probe\.ts:\d+ /, ''))).toEqual([
      'window.electronAPI.codex', 'IPC.CODEX_LOGIN', "IPC['CODEX_LOGOUT']", 'IPC[`CODEX_${x}`] (non-literal key)', 'api.codex', '{ codex } = window.electronAPI', '{ CODEX_LOGIN } = IPC',
    ])
    expect(extractFacts('probe.tsx', "const j = <div>{'codex'}</div>").conditionals).toEqual([])
    expect(extractFacts('broken.ts', 'const x = {').parseErrors.length).toBeGreaterThan(0)
    expect(extractFacts('recovered.ts', 'const x = 1 +;\nimport { a } from "./a"').parseErrors.length).toBeGreaterThan(0)
  })

  it('every rule goes red on a synthetic violation', () => {
    const F = (path: string, imports: string[] = [], extra: Partial<FileFacts> = {}): FileFacts => ({ path, imports, registerRefs: [], launchEnvRefs: [], conditionals: [], providerIpc: [], parseErrors: [], ...extra })
    const base = [
      F(ROOTS.main, ['src/main/providers/claude/index.ts', 'src/main/providers/codex/index.ts'], { registerRefs: ['registerProviderPackage'] }),
      F(ROOTS.renderer, ['src/renderer/providers/claude/index.ts', 'src/renderer/providers/codex/index.ts'], { registerRefs: ['registerRendererProvider'] }),
      F('src/main/providers/claude/index.ts', ['src/main/providers/claude/spawn.ts']), F('src/main/providers/claude/spawn.ts'),
      F('src/main/providers/codex/index.ts', ['src/main/providers/codex/spawn.ts']), F('src/main/providers/codex/spawn.ts'),
      F('src/main/providers/core/index.ts', ['src/main/providers/core/registry.ts']), F('src/main/providers/core/registry.ts'),
      F('src/renderer/providers/claude/index.ts'), F('src/renderer/providers/codex/index.ts'),
      F('src/renderer/providers/core/index.ts', ['src/renderer/providers/core/registry.ts']), F('src/renderer/providers/core/registry.ts'),
      F('src/main/neutral.ts', ['src/main/providers/claude/index.ts']),
    ]
    const empty: Allowlists = { deepImports: [], conditionals: [], crossPackageReach: [], packageOrphans: [], ledgerNonRetain: new Set(), phase: 'gate0' }
    // R1 direct and via a laundering hop.
    expect(ruleCorePurity([...base, F('src/main/providers/core/x.ts', ['src/main/providers/claude/spawn.ts'])])[0]).toMatch(/^R1 .*core\/x\.ts -> src\/main\/providers\/claude\/spawn\.ts/)
    expect(ruleCorePurity([...base, F('src/main/providers/core/x.ts', ['src/main/neutral.ts'])])[0]).toMatch(/^R1 .*core\/x\.ts -> src\/main\/neutral\.ts -> src\/main\/providers\/claude\/index\.ts/)
    expect(ruleCorePurity([...base, F('src/shared/providers/y.ts', ['src/main/account-profiles.ts']), F('src/main/account-profiles.ts')])[0]).toMatch(/^R1/)
    expect(ruleCorePurity(base)).toEqual([])
    // R2 direct, transitive-new, transitive-stale, case-insensitive.
    expect(ruleCrossPackage([...base, F('src/main/providers/claude/z.ts', ['src/main/providers/codex/spawn.ts'])], [])[0]).toMatch(/^R2 direct/)
    expect(ruleCrossPackage([...base, F('src/main/providers/claude/z.ts', ['src/main/hub.ts']), F('src/main/hub.ts', ['src/main/providers/codex/spawn.ts'])], [])[0]).toMatch(/^R2 new transitive .*claude\/z\.ts -> src\/main\/hub\.ts -> src\/main\/providers\/codex\/spawn\.ts/)
    expect(ruleCrossPackage([...base, F('src/main/providers/claude/z.ts', ['src/main/hub.ts']), F('src/main/hub.ts', ['src/main/providers/codex/spawn.ts'])], [{ from: 'src/main/providers/claude/z.ts', via: 'src/main/hub.ts', to: 'src/main/providers/codex/spawn.ts' }])).toEqual([])
    expect(ruleCrossPackage(base, [{ from: 'a', via: 'b', to: 'c' }])[0]).toMatch(/^R2 stale/)
    expect(ruleCrossPackage([...base, F('src/main/providers/claude/z.ts', ['src/main/providers/Codex/spawn.ts'])], [])[0]).toMatch(/^R2 direct/)
    // R3 a second both-importer, a stray reference, a single entry-point consumer, a root that does not register.
    expect(ruleRoots([...base, F('src/main/rogue.ts', ['src/main/providers/claude/index.ts', 'src/main/providers/codex/index.ts'])])[0]).toMatch(/^R3 files importing both main packages/)
    expect(ruleRoots([...base, F('src/main/rogue.ts', [], { registerRefs: ['registerProviderPackage'] })]).some((p) => /^R3 register function referenced outside/.test(p))).toBe(true)
    expect(ruleRoots(base).some((p) => /^R3 a module other than the composition root imports a package entry point: src\/main\/neutral\.ts/.test(p))).toBe(true)
    expect(ruleRoots(base.filter((f) => f.path !== 'src/main/neutral.ts'))).toEqual([])
    expect(ruleRoots(base.map((f) => (f.path === ROOTS.main ? { ...f, registerRefs: [] } : f))).some((p) => /does not reference registerProviderPackage/.test(p))).toBe(true)
    // R3 realm-env home list: a launch path (and even a composition root) that
    // applies a patch itself can hand applyRealmEnvPatch any policy it likes.
    expect(ruleRoots([...base, F('src/main/pty-manager.ts', [], { launchEnvRefs: ['applyRealmEnvPatch'] })]).some((p) => /^R3 realm env applied outside the registry/.test(p))).toBe(true)
    expect(ruleRoots(base.map((f) => (f.path === ROOTS.main ? { ...f, launchEnvRefs: ['applyRealmEnvPatch'] } : f))).some((p) => /^R3 realm env applied outside the registry/.test(p))).toBe(true)
    expect(ruleRoots([...base.filter((f) => f.path !== 'src/main/neutral.ts'), F('src/main/providers/core/registry.ts', [], { launchEnvRefs: ['applyRealmEnvPatch'] })])).toEqual([])
    // R4 new, stale, undispositioned, candidate-phase, core-internal exemption, case-insensitive, and same-package internal imports allowed.
    const deep = [...base, F('src/main/consumer.ts', ['src/main/providers/codex/spawn.ts'])]
    expect(ruleDeepImports(deep, empty)[0]).toMatch(/^R4 new deep import \(.*\): src\/main\/consumer\.ts -> src\/main\/providers\/codex\/spawn\.ts/)
    const entry = { from: 'src/main/consumer.ts', to: 'src/main/providers/codex/spawn.ts' }
    expect(ruleDeepImports(deep, { ...empty, deepImports: [entry] })[0]).toMatch(/^R4 allowlist entry has neither/)
    expect(ruleDeepImports(deep, { ...empty, deepImports: [entry], ledgerNonRetain: new Set(['src/main/consumer.ts']) })).toEqual([])
    expect(ruleDeepImports(deep, { ...empty, deepImports: [{ ...entry, exempt: { reason: 'r', decision: 'pending-owner' } }] })).toEqual([])
    expect(ruleDeepImports(deep, { ...empty, phase: 'candidate', deepImports: [{ ...entry, exempt: { reason: 'r', decision: 'pending-owner' } }] })[0]).toMatch(/^R4 deep import still present at the candidate/)
    expect(ruleDeepImports(deep, { ...empty, phase: 'candidate', deepImports: [{ ...entry, exempt: { reason: 'r', decision: 'owner-approved 2026-09-20' } }] })).toEqual([])
    expect(ruleDeepImports(base, { ...empty, deepImports: [entry] })[0]).toMatch(/^R4 stale/)
    expect(ruleDeepImports([...base, F('src/main/x.ts', ['src/main/providers/core/registry.ts'])], empty)[0]).toMatch(/^R4 new deep import \(.*\): src\/main\/x\.ts -> src\/main\/providers\/core\/registry\.ts/)
    expect(ruleDeepImports([...base, F('src/main/x.ts', ['src/main/providers/Codex/spawn.ts'])], empty)[0]).toMatch(/^R4 new deep import/)
    // A NESTED index.ts is not an entry point: laundering a deep import
    // through one used to be invisible to every rule.
    expect(ruleDeepImports([...base, F('src/main/x.ts', ['src/main/providers/core/sub/index.ts'])], empty)[0]).toMatch(/^R4 new deep import .*core\/sub\/index\.ts/)
    expect(ruleDeepImports([...base, F('src/main/x.ts', ['src/main/providers/codex/sub/index.ts'])], empty)[0]).toMatch(/^R4 new deep import .*codex\/sub\/index\.ts/)
    // The package ROOT index stays an entry point.
    expect(ruleDeepImports([...base, F('src/main/x.ts', ['src/main/providers/codex/index.ts'])], empty)).toEqual([])
    expect(ruleDeepImports(base, empty)).toEqual([])
    // R5 / R6 hits and allowlist.
    expect(ruleConditionals([F('src/main/providers/core/a.ts', [], { conditionals: ['src/main/providers/core/a.ts:3 x === \'codex\''] })], [])[0]).toMatch(/^R5/)
    expect(ruleConditionals([F('src/main/providers/core/a.ts', [], { conditionals: ['src/main/providers/core/a.ts:3 x === \'codex\''] })], ['src/main/providers/core/a.ts:3 x === \'codex\''])).toEqual([])
    expect(ruleConditionals([F('src/main/elsewhere.ts', [], { conditionals: ['src/main/elsewhere.ts:3 x === \'codex\''] })], [])).toEqual([])
    expect(ruleProviderIpc([F('src/renderer/providers/core/a.ts', [], { providerIpc: ['src/renderer/providers/core/a.ts:3 IPC.CODEX_LOGIN'] })])[0]).toMatch(/^R6/)
    // R7 orphan, stale orphan entry, missing entry point, parse error.
    expect(rulePackageMembership([...base, F('src/main/providers/codex/orphan.ts')], [])[0]).toMatch(/^R7 file inside a package directory is not reachable .*codex\/orphan\.ts/)
    expect(rulePackageMembership([...base, F('src/main/providers/codex/orphan.ts')], ['src/main/providers/codex/orphan.ts'])).toEqual([])
    expect(rulePackageMembership(base, ['src/main/providers/codex/gone.ts'])[0]).toMatch(/^R7 stale orphan/)
    expect(rulePackageMembership(base.filter((f) => f.path !== 'src/main/providers/codex/index.ts'), [])[0]).toMatch(/^R7 package src\/main\/providers\/codex\/ has no index\.ts/)
    expect(ruleParseErrors([F('src/main/b.ts', [], { parseErrors: ['src/main/b.ts: Unexpected token'] })])[0]).toMatch(/^R7 parse error/)
  })
})
