// WP1.57 -- WP2 commit 6g: the singleton Codex sign-in path is retired end to
// end. Source-level and AST-based (the Babel TypeScript parser, as in
// dependency-boundaries.test.ts), over every production source file under
// src/ and the app's own scripts (scripts/wp1 is gate tooling, not the app).
// What it checks, exactly:
//
//   - the retired modules are gone from disk and no relative import names
//     them (static, re-export, dynamic, require or type import);
//   - no identifier or property key is one of the four retired channel keys
//     (CODEX_STATUS, CODEX_LOGIN, CODEX_LOGOUT, CODEX_TEST_CONNECTION), and no
//     string names one of the four retired channels: a literal, a template or
//     a + chain whose parts are all constant is folded first; a template or
//     + chain that starts with the constant text "codex:" and then adds
//     anything not constant is refused outright (a channel built at run
//     time). A channel spelled from values held in other variables is not
//     traced;
//   - src/preload/index.ts and src/renderer/types/electron.d.ts have no
//     `codex` key, and nothing reads `.codex` (or `['codex']`, or
//     destructures `codex`) off `electronAPI`: reached directly, through
//     parentheses or TS casts, or through a local `const x =` alias of it;
//     and the unit-test electronAPI fake carries no `codex` key;
//   - the retired symbols are declared or referenced nowhere;
//   - no production string names auth.json (folded as above) except
//     realm-folders.ts's one CODEX_AUTH_FILE constant, and that constant is
//     used only as the direct argument of `isAbsent(...)`, or as an argument
//     of a path join that is itself `isAbsent`'s direct argument: asking
//     whether the file is there, never opening it (design 9.2).
//
// Comments are not code: an AST sees none of them. Every rule is a pure
// function over extracted facts, and the self-test at the end feeds each one
// a synthetic violation (verify the verifier).
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { parse } from '@babel/parser'

const ROOT = resolve(__dirname, '..', '..')
const rel = (abs: string) => abs.replace(/\\/g, '/').slice(ROOT.replace(/\\/g, '/').length + 1)

export const RETIRED_MODULES = [
  'src/main/codex-spawn-identity.ts',
  'src/main/ipc/codex-handlers.ts',
  'src/main/providers/codex/auth.ts',
  'src/renderer/components/codex/CodexSettingsTab.tsx',
  'src/renderer/onboarding/CodexSignInStep.tsx',
  'src/renderer/onboarding/CodexStep.tsx',
  'src/renderer/stores/codexAccountStore.ts',
] as const
const RETIRED_CHANNEL_KEYS = new Set(['CODEX_STATUS', 'CODEX_LOGIN', 'CODEX_LOGOUT', 'CODEX_TEST_CONNECTION'])
const RETIRED_CHANNELS = new Set(['codex:status', 'codex:login', 'codex:logout', 'codex:testConnection'])
const RETIRED_SYMBOLS = new Set([
  'readCodexAuthStatus', 'parseChatgptPlanFromJwt', 'CodexAuthStatus', 'readCodexAccountEmail',
  'captureCodexSpawnIdentity', 'clearCodexSpawnIdentity', 'getCodexSpawnIdentityMap', 'registerCodexHandlers',
  'useCodexAccountStore', 'codexLoginWithApiKey', 'codexLoginChatgpt', 'codexLoginDeviceAuth', 'codexLogout',
  'codexTestConnection', 'runCodexProcess', 'CodexSettingsTab', 'CodexSignInStep', 'CodexStep',
])
const BRIDGE_FILES = new Set(['src/preload/index.ts', 'src/renderer/types/electron.d.ts'])
const AUTH_FILE_HOME = 'src/main/providers/codex/realm-folders.ts'
const AUTH_FILE_CONST = 'CODEX_AUTH_FILE'
const AUTH_FILE_PROBE = 'isAbsent'
const CHANNEL_PREFIX = 'codex:'

type AnyNode = { type: string; [k: string]: unknown }
const isNode = (v: unknown): v is AnyNode => !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string'

export interface RetiredFacts {
  path: string
  specifiers: string[]
  identifiers: string[]
  /** Every literal, and every template or + chain folded where all its parts are constant. */
  strings: string[]
  /** Templates and + chains that start with "codex:" and then add something not constant. */
  builtChannels: string[]
  keys: string[]
  codexBridgeReads: string[]
  /** Uses of CODEX_AUTH_FILE, other than its declaration, that are not an absence probe's path. */
  authFileOpens: string[]
  parseErrors: string[]
}

const WRAPPERS = new Set(['TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'])
/** An expression without the parentheses and TS casts around it. */
const unwrap = (n: unknown): unknown => {
  let x = n
  while (isNode(x) && WRAPPERS.has(x.type)) x = x.expression
  return x
}

const keyName = (k: unknown): string | null => {
  if (!isNode(k)) return null
  if (k.type === 'Identifier') return k.name as string
  if (k.type === 'StringLiteral') return k.value as string
  return null
}

/** The string a constant expression always has: a literal, a template whose
 *  parts are all constant, or a + chain of those; null otherwise. */
export const constString = (n: unknown): string | null => {
  const x = unwrap(n)
  if (!isNode(x)) return null
  if (x.type === 'StringLiteral') return x.value as string
  if (x.type === 'TemplateLiteral') {
    const quasis = x.quasis as Array<{ value: { cooked: string | null; raw: string } }>
    const exprs = x.expressions as unknown[]
    let out = ''
    for (let i = 0; i < quasis.length; i++) {
      out += quasis[i].value.cooked ?? quasis[i].value.raw
      if (i < exprs.length) {
        const e = constString(exprs[i])
        if (e === null) return null
        out += e
      }
    }
    return out
  }
  if (x.type === 'BinaryExpression' && x.operator === '+') {
    const l = constString(x.left)
    const r = constString(x.right)
    return l !== null && r !== null ? l + r : null
  }
  return null
}

/** The constant text a string expression starts with, however it goes on. */
const constPrefix = (n: unknown): string => {
  const x = unwrap(n)
  if (!isNode(x)) return ''
  const whole = constString(x)
  if (whole !== null) return whole
  if (x.type === 'TemplateLiteral') {
    const quasis = x.quasis as Array<{ value: { cooked: string | null; raw: string } }>
    const exprs = x.expressions as unknown[]
    let out = quasis[0].value.cooked ?? quasis[0].value.raw
    for (let i = 0; i < exprs.length; i++) {
      const e = constString(exprs[i])
      if (e === null) return out + constPrefix(exprs[i])
      out += e + (quasis[i + 1].value.cooked ?? quasis[i + 1].value.raw)
    }
    return out
  }
  if (x.type === 'BinaryExpression' && x.operator === '+') {
    const l = constString(x.left)
    return l === null ? constPrefix(x.left) : l + constPrefix(x.right)
  }
  return ''
}

/** The source text of a member chain (`window.electronAPI`), through
 *  parentheses, TS casts and constant computed keys; null otherwise. */
const chain = (n: unknown): string | null => {
  const x = unwrap(n)
  if (!isNode(x)) return null
  if (x.type === 'Identifier') return x.name as string
  if (x.type === 'ThisExpression') return 'this'
  if (x.type === 'MemberExpression' || x.type === 'OptionalMemberExpression') {
    const o = chain(x.object)
    const p = x.computed ? constString(x.property) : keyName(x.property)
    return o && p ? `${o}.${p}` : null
  }
  return null
}
const isBridge = (c: string | null, aliases: Set<string>) => !!c && (/(^|\.)electronAPI$/.test(c) || aliases.has(c))

const isJoinCall = (n: unknown): boolean => {
  if (!isNode(n) || n.type !== 'CallExpression') return false
  const callee = unwrap(n.callee)
  if (!isNode(callee)) return false
  if (callee.type === 'Identifier') return callee.name === 'join'
  return (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && keyName(callee.property) === 'join' && !callee.computed
}
const isProbeCall = (n: unknown, arg: unknown): boolean => {
  if (!isNode(n) || n.type !== 'CallExpression') return false
  const callee = unwrap(n.callee)
  return isNode(callee) && callee.type === 'Identifier' && callee.name === AUTH_FILE_PROBE && (n.arguments as unknown[]).some((a) => unwrap(a) === arg)
}

type Visitor = (n: AnyNode, ancestors: AnyNode[]) => void
function walkAst(root: AnyNode, fn: Visitor): void {
  const visit = (n: AnyNode, ancestors: AnyNode[]): void => {
    fn(n, ancestors)
    const next = [...ancestors, n]
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue
      const v = n[key]
      if (Array.isArray(v)) { for (const c of v) if (isNode(c)) visit(c, next) }
      else if (isNode(v)) visit(v, next)
    }
  }
  visit(root, [])
}

export function extractRetiredFacts(path: string, text: string): RetiredFacts {
  const f: RetiredFacts = { path, specifiers: [], identifiers: [], strings: [], builtChannels: [], keys: [], codexBridgeReads: [], authFileOpens: [], parseErrors: [] }
  let program: AnyNode
  try {
    const parsed = parse(text, { sourceType: 'module', plugins: /\.[jt]sx$/.test(path) ? ['typescript', 'jsx'] : ['typescript'], errorRecovery: true })
    for (const e of (parsed.errors ?? []) as Array<{ reasonCode?: string; message?: string }>) f.parseErrors.push(`${path}: ${e.reasonCode ?? e.message}`)
    program = parsed.program as unknown as AnyNode
  } catch (e) {
    f.parseErrors.push(`${path}: ${(e as Error).message}`)
    return f
  }
  const line = (n: AnyNode) => (n.loc as { start: { line: number } } | undefined)?.start.line ?? 0

  // Pass 1: local names bound to the bridge (`const api = window.electronAPI`).
  const aliases = new Set<string>()
  walkAst(program, (n) => {
    if (n.type === 'VariableDeclarator' && isNode(n.id) && n.id.type === 'Identifier' && isBridge(chain(n.init), aliases)) aliases.add(n.id.name as string)
  })

  walkAst(program, (n, ancestors) => {
    const parent = ancestors[ancestors.length - 1]
    switch (n.type) {
      case 'ImportDeclaration': case 'ExportNamedDeclaration': case 'ExportAllDeclaration': {
        const s = n.source as AnyNode | null
        if (s && s.type === 'StringLiteral') f.specifiers.push(s.value as string)
        break
      }
      case 'TSImportType': {
        const a = (n.argument ?? n.parameter) as AnyNode | undefined
        const lit = a && a.type === 'TSLiteralType' ? (a.literal as AnyNode) : a
        if (lit && lit.type === 'StringLiteral') f.specifiers.push(lit.value as string)
        break
      }
      case 'ImportExpression': {
        const s = n.source as AnyNode
        if (s && s.type === 'StringLiteral') f.specifiers.push(s.value as string)
        break
      }
      case 'CallExpression': {
        const callee = n.callee as AnyNode
        const args = n.arguments as AnyNode[]
        if ((callee.type === 'Import' || (callee.type === 'Identifier' && callee.name === 'require')) && args[0]?.type === 'StringLiteral') f.specifiers.push(args[0].value as string)
        break
      }
      case 'Identifier': case 'JSXIdentifier': {
        const name = n.name as string
        f.identifiers.push(name)
        if (name === AUTH_FILE_CONST) {
          const isDeclaration = parent?.type === 'VariableDeclarator' && parent.id === n
          const grand = ancestors[ancestors.length - 2]
          const probed = isProbeCall(parent, n) || (isJoinCall(parent) && (parent.arguments as unknown[]).some((a) => unwrap(a) === n) && isProbeCall(grand, parent))
          if (!isDeclaration && !probed) f.authFileOpens.push(`${path}:${line(n)}`)
        }
        break
      }
      case 'StringLiteral': f.strings.push(n.value as string); break
      case 'TemplateLiteral': case 'BinaryExpression': {
        if (n.type === 'BinaryExpression' && n.operator !== '+') break
        // A + chain is judged whole, once, at its top.
        const inner = parent && parent.type === 'BinaryExpression' && parent.operator === '+'
        if (n.type === 'BinaryExpression' && inner) break
        const whole = constString(n)
        if (whole !== null) f.strings.push(whole)
        else {
          if (n.type === 'TemplateLiteral') for (const q of n.quasis as Array<{ value: { cooked: string | null; raw: string } }>) f.strings.push(q.value.cooked ?? q.value.raw)
          if (constPrefix(n).startsWith(CHANNEL_PREFIX)) f.builtChannels.push(`${path}:${line(n)}`)
        }
        break
      }
      case 'ObjectProperty': case 'ObjectMethod': case 'ClassProperty': case 'TSPropertySignature': case 'TSMethodSignature': {
        const k = keyName(n.key)
        if (k) f.keys.push(k)
        break
      }
      case 'MemberExpression': case 'OptionalMemberExpression': {
        const p = n.computed ? constString(n.property) : keyName(n.property)
        const o = chain(n.object)
        if (p === 'codex' && isBridge(o, aliases)) f.codexBridgeReads.push(`${path}:${line(n)} ${o}.codex`)
        break
      }
      case 'VariableDeclarator': {
        // const { codex } = window.electronAPI (or an alias of it)
        const id = n.id as AnyNode
        const init = chain(n.init)
        if (id.type === 'ObjectPattern' && isBridge(init, aliases)) {
          for (const p of id.properties as AnyNode[]) if (p.type === 'ObjectProperty' && keyName(p.key) === 'codex') f.codexBridgeReads.push(`${path}:${line(n)} { codex } = ${init}`)
        }
        break
      }
    }
  })
  return f
}

const stripExt = (p: string) => p.replace(/\.(d\.ts|tsx?|jsx?|mjs|cjs)$/, '')
const RETIRED_STEMS = new Set(RETIRED_MODULES.map(stripExt))

/** Rules, pure over facts. Each returns the problems it finds. */
export function ruleImports(files: RetiredFacts[]): string[] {
  const out: string[] = []
  for (const f of files) {
    for (const spec of f.specifiers) {
      if (!spec.startsWith('.')) continue
      const target = stripExt(posix.normalize(posix.join(posix.dirname(f.path), spec.replace(/\\/g, '/'))))
      if (RETIRED_STEMS.has(target)) out.push(`import of a retired module: ${f.path} -> ${spec}`)
    }
  }
  return out
}
export function ruleChannels(files: RetiredFacts[]): string[] {
  const out: string[] = []
  for (const f of files) {
    for (const id of new Set([...f.identifiers, ...f.keys])) if (RETIRED_CHANNEL_KEYS.has(id)) out.push(`retired channel key ${id} in ${f.path}`)
    for (const s of new Set(f.strings)) if (RETIRED_CHANNELS.has(s)) out.push(`retired channel '${s}' in ${f.path}`)
    for (const b of f.builtChannels) out.push(`a codex: channel built at run time: ${b}`)
  }
  return out
}
export function ruleBridge(files: RetiredFacts[]): string[] {
  const out: string[] = []
  for (const f of files) {
    if (BRIDGE_FILES.has(f.path) && f.keys.includes('codex')) out.push(`a codex block in the bridge: ${f.path}`)
    out.push(...f.codexBridgeReads.map((r) => `electronAPI.codex read: ${r}`))
  }
  return out
}
export function ruleSymbols(files: RetiredFacts[]): string[] {
  const out: string[] = []
  for (const f of files) {
    for (const id of new Set([...f.identifiers, ...f.keys])) if (RETIRED_SYMBOLS.has(id)) out.push(`retired symbol ${id} in ${f.path}`)
  }
  return out
}
export function ruleAuthJson(files: RetiredFacts[]): string[] {
  const out: string[] = []
  for (const f of files) {
    if (f.strings.some((s) => /auth\.json/i.test(s)) && f.path !== AUTH_FILE_HOME) out.push(`names auth.json: ${f.path}`)
    if (f.path === AUTH_FILE_HOME) {
      const named = f.strings.filter((s) => /auth\.json/i.test(s))
      if (named.length !== 1 || named[0] !== 'auth.json') out.push(`${AUTH_FILE_HOME} names auth.json other than as its one CODEX_AUTH_FILE constant`)
    }
    out.push(...f.authFileOpens.map((o) => `${AUTH_FILE_CONST} used other than as an absence probe's path: ${o}`))
  }
  return out
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(name)) out.push(p)
  }
  return out
}
const appFiles = [...walk(resolve(ROOT, 'src')), ...walk(resolve(ROOT, 'scripts')).filter((p) => !rel(p).startsWith('scripts/wp1/'))]
const facts = appFiles.map((abs) => extractRetiredFacts(rel(abs), readFileSync(abs, 'utf8')))
const byPath = new Map(facts.map((f) => [f.path, f]))

describe('WP1.57 the singleton Codex sign-in path is retired end to end (WP2 commit 6g)', () => {
  it('analysed the app source cleanly, bridge and channel files included', () => {
    expect(facts.length).toBeGreaterThan(300)
    for (const p of ['src/shared/ipc-channels.ts', 'src/preload/index.ts', 'src/renderer/types/electron.d.ts', 'src/main/index.ts', AUTH_FILE_HOME]) expect(byPath.has(p), p).toBe(true)
    expect(facts.flatMap((f) => f.parseErrors)).toEqual([])
  })

  it('the retired modules are gone from disk and nothing imports them', () => {
    expect(RETIRED_MODULES.filter((m) => existsSync(resolve(ROOT, m)))).toEqual([])
    const p = ruleImports(facts)
    expect(p, p.join('\n')).toEqual([])
  })

  it('the four retired channels are named nowhere (keys, folded strings), and no codex: channel is built at run time', () => {
    const p = ruleChannels(facts)
    expect(p, p.join('\n')).toEqual([])
    // The channel table still has its other Codex entries (the review usage
    // channels), so the check above is looking at the right file.
    expect(byPath.get('src/shared/ipc-channels.ts')!.keys).toContain('CODEX_REVIEW_USAGE_GET')
  })

  it('the preload bridge and its typing expose no codex block, and nothing reads electronAPI.codex', () => {
    const p = ruleBridge(facts)
    expect(p, p.join('\n')).toEqual([])
    for (const b of BRIDGE_FILES) expect(byPath.get(b)!.keys, b).toContain('codexReview') // the retained sibling block
    // The unit-test electronAPI fake (tests/unit/setup.ts) mirrors the bridge:
    // a codex block there would let a regression pass unit tests.
    const setup = extractRetiredFacts('tests/unit/setup.ts', readFileSync(resolve(ROOT, 'tests/unit/setup.ts'), 'utf8'))
    expect(setup.parseErrors).toEqual([])
    expect(setup.keys).toContain('insights') // the fake's block next to where codex was
    expect(setup.keys).not.toContain('codex')
  })

  it('the retired symbols are declared or referenced nowhere', () => {
    const p = ruleSymbols(facts)
    expect(p, p.join('\n')).toEqual([])
  })

  it("no app code reads Codex's auth.json: only realm-folders.ts names it, and only as an absence probe's path", () => {
    const p = ruleAuthJson(facts)
    expect(p, p.join('\n')).toEqual([])
    // The probe is really there (the rule would pass vacuously without it).
    expect(byPath.get(AUTH_FILE_HOME)!.identifiers.filter((i) => i === AUTH_FILE_CONST).length).toBeGreaterThanOrEqual(2)
  })

  it('every rule can fail (synthetic violations)', () => {
    const F = (path: string, text: string) => extractRetiredFacts(path, text)
    // Imports: static, re-export, dynamic, require, type import; extension or not.
    for (const src of [
      "import { useCodexAccountStore } from '../stores/codexAccountStore'",
      "export { captureCodexSpawnIdentity } from '../../main/codex-spawn-identity'",
      "const m = await import('../stores/codexAccountStore.ts')",
      "const m = require('../stores/codexAccountStore')",
      "type T = import('../stores/codexAccountStore').X",
    ]) expect(ruleImports([F('src/renderer/components/probe.tsx', src)]).length, src).toBe(1)
    expect(ruleImports([F('src/main/probe.ts', "import { registerCodexHandlers } from './ipc/codex-handlers'")]).length).toBe(1)
    expect(ruleImports([F('src/main/providers/codex/telemetry.ts', "import { getCodexHome } from './auth'")]).length).toBe(1)
    expect(ruleImports([F('src/main/probe.ts', "import { x } from './ipc/codex-review-handlers'")])).toEqual([])
    // Channels: a key, a member use, a string, a template string; a comment is not code.
    expect(ruleChannels([F('src/shared/ipc-channels.ts', "export const IPC = { CODEX_STATUS: 'codex:status' }")]).length).toBe(2)
    expect(ruleChannels([F('src/main/probe.ts', 'ipcMain.handle(IPC.CODEX_LOGIN, h)')]).length).toBe(1)
    expect(ruleChannels([F('src/preload/probe.ts', "ipcRenderer.invoke('codex:logout')")]).length).toBe(1)
    expect(ruleChannels([F('src/preload/probe.ts', 'ipcRenderer.invoke(`codex:testConnection`)')]).length).toBe(1)
    expect(ruleChannels([F('src/main/probe.ts', "// IPC.CODEX_STATUS 'codex:status' used to live here\nconst a = 1")])).toEqual([])
    // ...folded: concatenation and constant-only templates.
    expect(ruleChannels([F('src/preload/probe.ts', "ipcRenderer.invoke('codex:' + 'status')")]).length).toBe(1)
    expect(ruleChannels([F('src/preload/probe.ts', "ipcRenderer.invoke(('co' + 'dex:') + `log${'out'}`)")]).length).toBe(1)
    expect(ruleChannels([F('src/preload/probe.ts', "ipcRenderer.invoke(`codex:${'login'}`)")]).length).toBe(1)
    // ...built at run time from a codex: head.
    expect(ruleChannels([F('src/preload/probe.ts', 'ipcRenderer.invoke(`codex:${op}`)')]).length).toBe(1)
    expect(ruleChannels([F('src/preload/probe.ts', "ipcRenderer.invoke('codex:' + op)")]).length).toBe(1)
    expect(ruleChannels([F('src/preload/probe.ts', "ipcRenderer.invoke('codex-review:' + op)")])).toEqual([])
    expect(ruleChannels([F('src/preload/probe.ts', 'const k = `${provider}:${cap}`')])).toEqual([])
    // Bridge: a codex block in either bridge file, and any electronAPI.codex read.
    expect(ruleBridge([F('src/preload/index.ts', 'const api = { codex: { status: () => 1 } }')]).length).toBe(1)
    expect(ruleBridge([F('src/renderer/types/electron.d.ts', 'interface ElectronAPI { codex: { status: () => void } }')]).length).toBe(1)
    expect(ruleBridge([F('src/renderer/x.ts', 'window.electronAPI.codex.status()')]).length).toBe(1)
    expect(ruleBridge([F('src/renderer/x.ts', "window.electronAPI['codex'].status()")]).length).toBe(1)
    expect(ruleBridge([F('src/renderer/x.ts', "window.electronAPI['co' + 'dex'].status()")]).length).toBe(1)
    expect(ruleBridge([F('src/renderer/x.ts', 'const { codex } = window.electronAPI')]).length).toBe(1)
    // ...through TS casts and parentheses, and through a local alias.
    expect(ruleBridge([F('src/renderer/x.ts', '(window as any).electronAPI.codex.status()')]).length).toBe(1)
    expect(ruleBridge([F('src/renderer/x.ts', '((window as any).electronAPI as Api)!.codex.status()')]).length).toBe(1)
    expect(ruleBridge([F('src/renderer/x.ts', 'const api = window.electronAPI; api.codex.status()')]).length).toBe(1)
    expect(ruleBridge([F('src/renderer/x.ts', 'const api = (window as any).electronAPI\nconst { codex } = api')]).length).toBe(1)
    expect(ruleBridge([F('src/renderer/x.ts', 'window.electronAPI.codexReview.getUsage(s)')])).toEqual([])
    expect(ruleBridge([F('src/main/x.ts', "const m = { codex: 'tok' }")])).toEqual([]) // a codex key outside the bridge is fine
    expect(ruleBridge([F('src/main/x.ts', 'const api = other.thing; api.codex')])).toEqual([])
    // Symbols: a reference, a declaration, a JSX element.
    expect(ruleSymbols([F('src/main/x.ts', 'export async function readCodexAuthStatus() {}')]).length).toBe(1)
    expect(ruleSymbols([F('src/renderer/x.tsx', 'const a = <CodexSettingsTab />')]).length).toBe(1)
    expect(ruleSymbols([F('src/renderer/x.tsx', 'const a = <HelloCodexStep />')])).toEqual([])
    // auth.json: named anywhere else (folded too), a second name in the home, a read of the constant.
    expect(ruleAuthJson([F('src/main/x.ts', "const p = join(homedir(), '.codex', 'auth.json')")]).length).toBe(1)
    expect(ruleAuthJson([F('src/main/x.ts', 'const p = `${home}/auth.json`')]).length).toBe(1)
    expect(ruleAuthJson([F('src/main/x.ts', "const p = join(home, 'auth' + '.json')")]).length).toBe(1)
    expect(ruleAuthJson([F('src/main/x.ts', "const p = join(home, `auth${'.json'}`)")]).length).toBe(1)
    expect(ruleAuthJson([F('src/main/x.ts', '// reads ~/.codex/auth.json\nconst a = 1')])).toEqual([])
    const home = (body: string) => F(AUTH_FILE_HOME, `const CODEX_AUTH_FILE = 'auth.json'\n${body}`)
    expect(ruleAuthJson([home('const gone = isAbsent(pathApi.join(h, CODEX_AUTH_FILE))')])).toEqual([])
    expect(ruleAuthJson([home('const gone = isAbsent(join(h, CODEX_AUTH_FILE))')])).toEqual([])
    expect(ruleAuthJson([home('const gone = isAbsent(CODEX_AUTH_FILE)')])).toEqual([])
    expect(ruleAuthJson([home('const t = readFileSync(pathApi.join(h, CODEX_AUTH_FILE))')]).length).toBe(1)
    expect(ruleAuthJson([home("const t = readFileSync(pathApi.join(h, 'auth.json'))")]).length).toBe(1)
    // A read wrapped inside the probe's argument is not a probe.
    expect(ruleAuthJson([home('const gone = isAbsent(readFileSync(pathApi.join(h, CODEX_AUTH_FILE)))')]).length).toBe(1)
    expect(ruleAuthJson([home('const gone = isAbsent(pathApi.join(h, String(readFileSync(CODEX_AUTH_FILE))))')]).length).toBe(1)
    expect(ruleAuthJson([home('const p = pathApi.join(h, CODEX_AUTH_FILE); const gone = isAbsent(p)')]).length).toBe(1)
  })
})
