// WP1.69 -- the fake Codex CLI's versioned oracle (tests/wp1/fake-cli/oracle.json)
// and the self-tests that compare it with both sides. The oracle records what
// the app relies on the Codex CLI doing, for the minimum and pinned versions
// cli-contract.ts names. Every claim rests on the CLI itself: P3.1's sanitised
// real captures (tests/fixtures/codex/cli/<version>/, ANONYMISED.txt there), the
// app-server schema the CLI generated, a recorded real run, or the upstream
// source at the release tag (tests/wp1/fixtures/codex-cli-source.json: tag,
// commit, file sha256 and verbatim lines). What the app's own code or plans say
// is an app assumption: it must agree, and it never backs a claim alone.
//   (a) the real side: every entry holds against its captures and schemas; every
//       upstream citation is the fixture's lines verbatim, and exits, prints and
//       streams as the entry says; every other citation is in its file;
//   (b) the fake side: each fake answers every entry it claims as the oracle says.
// The fakes are the FAKE script of tests/wp1/fake-cli.test.ts (read as text:
// that suite starts processes, so it never runs on a host) and the script installFakeCodex writes
// (tests/e2e/helpers/fake-codex.ts). Every case is [host] and pure: a fake
// script runs in a node:vm context with an in-memory file system and a require
// that refuses child_process, so no process starts and nothing is written; the
// e2e helper's own writes are caught in memory under a virtual root holding a
// NUL character, a path the real file system refuses outright.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import nodePath from 'node:path'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { CODEX_MIN_SUPPORTED_VERSION, CODEX_PINNED_CLI_VERSION } from '../../src/main/providers/codex/cli-contract'
import { codexCommandLine } from '../../src/main/providers/codex/cli-runner'
import type { CodexCliOperation } from '../../src/main/providers/codex/cli-runner'
import { codexAgentArgs } from '../../src/main/providers/codex/agent-run'
import { appServerMessages } from '../../src/main/providers/codex/app-server-client'
import { parseCapture } from '../integration/codex-conformance-lib'
import { installFakeCodex, signInFakeRealm } from '../e2e/helpers/fake-codex'

const ROOT = nodePath.resolve(__dirname, '..', '..')
const ORACLE_FILE = 'tests/wp1/fake-cli/oracle.json'
const SOURCE_FILE = 'tests/wp1/fixtures/codex-cli-source.json'
const readRepo = (p: string): string | null => {
  try { return fs.readFileSync(nodePath.resolve(ROOT, p), 'utf8') } catch { return null }
}

// ---------------------------------------------------------------- the oracle's shape

interface FieldSpec {
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array'
  equals?: unknown
  regex?: string
  sameFolderAsEnv?: string
  minItems?: number
  each?: Record<string, FieldSpec>
}
type LineMatcher =
  | { exact: string }
  | { regex: string }
  | { rpcResult: { id: number; schema: string; fields: Record<string, FieldSpec> } }
  | { json: Record<string, FieldSpec> }
type Stream = 'stdout' | 'stderr'
interface StreamSpec { stream: Stream; appReads?: Stream[]; mode: 'exactly' | 'inOrder' | 'document'; lines: LineMatcher[] }
interface ExpectSpec { exitCode?: number; streams: StreamSpec[]; afterwards?: string }
interface Excerpt { line: number; text: string }
type Kind = 'upstream' | 'observation' | 'app-assumption'
interface Citation {
  kind: Kind; path: string; versions: string[]; backs?: string[]
  quote?: string; role?: string; excerpt?: Excerpt[]
  exitCode?: number | null; stream?: Stream; afterwards?: string; samples?: string[]
}
interface Entry {
  id: string; versions: string[]; argv: string[]
  app: { operation?: string; agentSandbox?: string; stdin?: string }
  preconditions: string[]; stdinLines?: string[]; expect: ExpectSpec
  sources: {
    captures?: Array<{ version: string; path: string; format: 'exit-stdout-stderr' | 'stdout-jsonl' | 'json-document' }>
    schemas?: Array<{ version: string; path: string }>
    citations?: Citation[]
  }
  fakes: string[]
}
interface Divergence { fake: string; entry: string; field: 'exitCode'; fakeAnswers: number; why: string }
interface Oracle {
  schema: string; item: string; cli: string; upstreamSource: string
  versions: { minimum: string; pinned: string; source: string }
  fakes: Record<string, { file: string; symbol: string; versions: string[] }>
  preconditions: Record<string, { means: string; citations: Citation[] }>
  entries: Entry[]
  knownDivergences?: Divergence[]
}
interface SourceFixture {
  versions: Array<{
    version: string; tag: string; tagObjectSha: string; commitSha: string
    sources: Array<{ role: string; path: string; sha256: string; blobSha: string; excerpt: Excerpt[] }>
  }>
}

const ORACLE_TEXT = readRepo(ORACLE_FILE) ?? ''
const ORACLE = JSON.parse(ORACLE_TEXT || '{}') as Oracle
const SOURCE_TEXT = readRepo(SOURCE_FILE) ?? ''
const SOURCE = JSON.parse(SOURCE_TEXT || '{"versions":[]}') as SourceFixture
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T
const entryOf = (o: Oracle, id: string): Entry => {
  const e = o.entries.find((x) => x.id === id)
  if (!e) throw new Error(`no oracle entry ${id}`)
  return e
}

// ---------------------------------------------------------------- matching

interface Outcome { exitCode: number | null | undefined; stdout: string | null; stderr: string | null }
interface Ctx { version: string; env?: Record<string, string> }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const subst = (s: string, v: string) => s.split('{version}').join(v)
const substRe = (s: string, v: string) => s.split('{version}').join(escapeRe(v))
const linesOf = (s: string) => s.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '')
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const parseJson = (s: string): unknown => { try { return JSON.parse(s) } catch { return undefined } }

function typeOk(t: FieldSpec['type'], v: unknown): boolean {
  switch (t) {
    case undefined: return true
    case 'string': return typeof v === 'string'
    case 'integer': return Number.isInteger(v)
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'boolean': return typeof v === 'boolean'
    case 'object': return isPlain(v)
    case 'array': return Array.isArray(v)
  }
}

function fieldsOk(obj: unknown, fields: Record<string, FieldSpec>, ctx: Ctx): boolean {
  if (!isPlain(obj)) return false
  return Object.entries(fields).every(([k, spec]) => {
    const v = Object.hasOwn(obj, k) ? obj[k] : undefined
    if (v === undefined || !typeOk(spec.type, v)) return false
    if (spec.equals !== undefined && JSON.stringify(v) !== JSON.stringify(spec.equals)) return false
    if (spec.regex !== undefined && !(typeof v === 'string' && new RegExp(substRe(spec.regex, ctx.version)).test(v))) return false
    // The fakes' virtual homes are already canonical, so the folder is compared exactly.
    if (spec.sameFolderAsEnv !== undefined && ctx.env && v !== ctx.env[spec.sameFolderAsEnv]) return false
    if (spec.minItems !== undefined && !(Array.isArray(v) && v.length >= spec.minItems)) return false
    if (spec.each !== undefined && !(Array.isArray(v) && v.every((item) => fieldsOk(item, spec.each!, ctx)))) return false
    return true
  })
}

function lineMatches(m: LineMatcher, line: string, ctx: Ctx): boolean {
  if ('exact' in m) return line === subst(m.exact, ctx.version)
  if ('regex' in m) return new RegExp(substRe(m.regex, ctx.version)).test(line)
  if ('rpcResult' in m) {
    const msg = parseJson(line)
    return isPlain(msg) && msg.id === m.rpcResult.id && fieldsOk(msg.result, m.rpcResult.fields, ctx)
  }
  return fieldsOk(parseJson(line), m.json, ctx)
}

function streamMatches(spec: StreamSpec, text: string, ctx: Ctx): boolean {
  if (spec.mode === 'document') return spec.lines.length === 1 && 'json' in spec.lines[0] && lineMatches(spec.lines[0], text.trim(), ctx)
  const ls = linesOf(text)
  if (spec.mode === 'exactly') return ls.length === spec.lines.length && ls.every((l, i) => lineMatches(spec.lines[i], l, ctx))
  let i = 0
  for (const l of ls) if (i < spec.lines.length && lineMatches(spec.lines[i], l, ctx)) i++
  return i === spec.lines.length
}

/** What does not hold of `out`; an unknown exit code or stream (a capture
 *  that does not record it) is not checked. */
function outcomeProblems(x: ExpectSpec, out: Outcome, ctx: Ctx): string[] {
  const problems: string[] = []
  if (x.exitCode !== undefined && out.exitCode !== undefined && out.exitCode !== x.exitCode) problems.push(`exit code ${out.exitCode}, the oracle says ${x.exitCode}`)
  for (const s of x.streams) {
    const text = s.stream === 'stdout' ? out.stdout : out.stderr
    if (text === null) continue
    if (!streamMatches(s, text, ctx)) problems.push(`${s.stream} (${s.mode}) does not hold: got ${JSON.stringify(text.slice(0, 400))}`)
  }
  return problems
}

// ---------------------------------------------------------------- (a) the real side

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

type SchemaNode = { type?: string | string[]; $ref?: string; allOf?: SchemaNode[]; anyOf?: SchemaNode[] }
interface SchemaPart { definitions?: Record<string, SchemaNode>; message?: { required?: string[]; properties?: Record<string, SchemaNode> } }
function schemaTypes(defs: Record<string, SchemaNode>, node: SchemaNode | undefined, depth = 0): string[] {
  if (!node || depth > 8) return []
  if (node.type !== undefined) return Array.isArray(node.type) ? node.type : [node.type]
  if (node.$ref) return schemaTypes(defs, defs[node.$ref.replace('#/definitions/', '')], depth + 1)
  return [...(node.allOf ?? []), ...(node.anyOf ?? [])].flatMap((n) => schemaTypes(defs, n, depth + 1))
}

/** A Rust format string as an anchored pattern: `{}` or an unknown `{name}` is
 *  any text, a `{NAME}` of a `const NAME: &str` in the same excerpt its value. */
function formatPattern(fmt: string, consts: Map<string, string>): RegExp {
  let re = ''
  for (const part of fmt.split(/(\{\{|\}\}|\{[^{}]*\})/)) {
    if (part === '{{') re += '\\{'
    else if (part === '}}') re += '\\}'
    else if (/^\{[^{}]*\}$/.test(part)) {
      const name = part.slice(1, -1).split(':')[0]
      re += consts.has(name) ? escapeRe(consts.get(name)!) : '.+'
    } else re += escapeRe(part)
  }
  return new RegExp(`^${re}$`)
}
const unrust = (s: string) => s.replace(/\\(["\\])/g, '$1')

/** What upstream lines show: the streams they write to, the lines they print,
 *  and the exit codes they end with -- `std::process::exit(N)`, or 0 for a
 *  command that returns Ok through `fn main() -> anyhow::Result<()>`. */
function excerptShows(lines: readonly string[]): { streams: Set<Stream>; prints: RegExp[]; exits: Set<number> } {
  const consts = new Map<string, string>()
  for (const l of lines) {
    const m = /\bconst (\w+): &str = "((?:[^"\\]|\\.)*)";/.exec(l)
    if (m) consts.set(m[1], unrust(m[2]))
  }
  const streams = new Set<Stream>()
  const prints: RegExp[] = []
  const exits = new Set<number>()
  for (const l of lines) {
    if (/\beprint(?:ln)?!\(|\bio::stderr\(\)/.test(l)) streams.add('stderr')
    if (/\bprint(?:ln)?!\(|\bio::stdout\(\)/.test(l)) streams.add('stdout')
    const f = /\be?print(?:ln)?!\(\s*"((?:[^"\\]|\\.)*)"/.exec(l)
    if (f) prints.push(formatPattern(unrust(f[1]), consts))
    const x = /std::process::exit\((\d+)\)/.exec(l)
    if (x) exits.add(Number(x[1]))
  }
  if (lines.some((l) => l.trim() === 'fn main() -> anyhow::Result<()> {') && lines.some((l) => l.trim() === 'Ok(())')) exits.add(0)
  return { streams, prints, exits }
}

function upstreamProblems(where: string, c: Citation): string[] {
  if (!c.role || !c.excerpt || c.excerpt.length === 0) return [`${where}: an upstream citation of ${c.path} names no role or lines`]
  const problems: string[] = []
  for (const v of c.versions) {
    const src = SOURCE.versions.find((x) => x.version === v)?.sources.find((s) => s.role === c.role && s.path === c.path)
    if (!src) { problems.push(`${where} ${v}: the upstream fixture has no ${c.role} in ${c.path}`); continue }
    for (const e of c.excerpt) {
      const f = src.excerpt.find((x) => x.line === e.line)
      if (!f || f.text !== e.text) problems.push(`${where} ${v}: ${c.path}:${e.line} is not that line in the upstream fixture`)
    }
  }
  const shows = excerptShows(c.excerpt.map((e) => e.text))
  const backs = c.backs ?? []
  if (backs.includes('exitCode')) {
    if (shows.exits.size === 0) problems.push(`${where}: ${c.path} backs an exit code its lines do not show`)
    else if ([...shows.exits].some((x) => x !== c.exitCode)) problems.push(`${where}: ${c.path} exits ${[...shows.exits].join('/')}, the citation says ${c.exitCode}`)
  }
  if (backs.includes('stream')) {
    if (shows.streams.size === 0) problems.push(`${where}: ${c.path} backs a stream its lines do not write to`)
    else if ([...shows.streams].some((s) => s !== c.stream)) problems.push(`${where}: ${c.path} writes to ${[...shows.streams].join('/')}, the citation says ${c.stream}`)
  }
  for (const s of c.samples ?? []) if (!shows.prints.some((p) => p.test(s))) problems.push(`${where}: ${c.path} prints no line like the sample ${JSON.stringify(s)}`)
  return problems
}

/** The app's own source and plans are assumptions, whatever a citation calls them. */
const APP_PATH = /^src\/|^docs\/wp2\/(plan|completion-plan|parity-checklist)\.md$/
const OBSERVATION_PATH = /^docs\/wp2\/evidence\/|^tests\/fixtures\/codex\//

function citationProblems(where: string, c: Citation, read: (p: string) => string | null): string[] {
  if (c.kind === 'upstream') return /^codex-rs\//.test(c.path) ? upstreamProblems(where, c) : [`${where}: an upstream citation of ${c.path}, which is not upstream source`]
  if (c.kind !== 'observation' && c.kind !== 'app-assumption') return [`${where}: ${c.path} has no known kind`]
  if (APP_PATH.test(c.path) && c.kind !== 'app-assumption') return [`${where}: ${c.path} is the app's own, so an app assumption`]
  if (c.kind === 'observation' && !OBSERVATION_PATH.test(c.path)) return [`${where}: ${c.path} is not a capture or a recorded run`]
  const text = read(c.path)
  if (text === null) return [`${where}: ${c.path} is missing`]
  if (!c.quote || !squash(text).includes(squash(c.quote))) return [`${where}: ${c.path} does not contain ${JSON.stringify(c.quote)}`]
  return (c.samples ?? []).filter((s) => !squash(c.quote!).includes(squash(s))).map((s) => `${where}: the sample ${JSON.stringify(s)} is not in its quote`)
}

function realSideProblems(o: Oracle, read: (p: string) => string | null): string[] {
  const problems: string[] = []
  for (const [name, pre] of Object.entries(o.preconditions)) {
    for (const c of pre.citations) problems.push(...citationProblems(`precondition ${name}`, c, read))
  }
  for (const e of o.entries) {
    const cites = e.sources.citations ?? []
    for (const c of cites) problems.push(...citationProblems(e.id, c, read))
    const lineMatchers = e.expect.streams.flatMap((s) => s.lines)
    const textMatchers = lineMatchers.filter((m) => 'exact' in m || 'regex' in m)
    const valueConstraints = lineMatchers.some((m) => 'rpcResult' in m && Object.values(m.rpcResult.fields).some((f) => f.regex !== undefined || f.sameFolderAsEnv !== undefined || f.equals !== undefined))
    for (const v of e.versions) {
      const ctx: Ctx = { version: v }
      const caps = (e.sources.captures ?? []).filter((c) => c.version === v)
      const schemas = (e.sources.schemas ?? []).filter((s) => s.version === v)
      const backing = (what: string) => cites.filter((c) => c.versions.includes(v) && (c.backs ?? []).includes(what))
      // What the CLI itself shows: an app assumption never backs a claim alone.
      const support = (what: string) => backing(what).filter((c) => c.kind !== 'app-assumption')
      const only = (what: string) => (backing(what).length > 0 ? 'only an app assumption backs' : 'nothing backs')
      // The captures: each must hold the entry.
      for (const cap of caps) {
        const raw = read(cap.path)
        if (raw === null) { problems.push(`${e.id} ${v}: capture ${cap.path} is missing`); continue }
        const out: Outcome | null = cap.format === 'exit-stdout-stderr'
          ? (() => { const p = parseCapture(raw); return p ? { exitCode: p.exit, stdout: p.stdout, stderr: p.stderr } : null })()
          : { exitCode: undefined, stdout: raw, stderr: null }
        if (!out) { problems.push(`${e.id} ${v}: capture ${cap.path} is not in the exit/stdout/stderr form`); continue }
        problems.push(...outcomeProblems(e.expect, out, ctx).map((p) => `${e.id} ${v} against ${cap.path}: ${p}`))
      }
      // The schemas: each rpcResult field is required there, with its type.
      for (const s of schemas) {
        const doc = parseJson(read(s.path) ?? '')
        if (!isPlain(doc)) { problems.push(`${e.id} ${v}: schema ${s.path} is missing or not JSON`); continue }
        if (doc.codexVersion !== v) problems.push(`${e.id} ${v}: schema ${s.path} is for ${String(doc.codexVersion)}`)
        for (const m of lineMatchers) {
          if (!('rpcResult' in m)) continue
          const part = doc[m.rpcResult.schema] as SchemaPart | undefined
          if (!part?.message) { problems.push(`${e.id} ${v}: ${s.path} has no ${m.rpcResult.schema}`); continue }
          for (const [k, f] of Object.entries(m.rpcResult.fields)) {
            if (!(part.message.required ?? []).includes(k)) problems.push(`${e.id} ${v}: ${m.rpcResult.schema} does not require ${k}`)
            const types = schemaTypes(part.definitions ?? {}, part.message.properties?.[k])
            if (f.type && !types.includes(f.type)) problems.push(`${e.id} ${v}: ${m.rpcResult.schema}.${k} is ${JSON.stringify(types)}, the oracle says ${f.type}`)
          }
        }
      }
      // The exit code: asserted, the CLI must show it; not asserted, a citation says why.
      if (e.expect.exitCode !== undefined) {
        if (!caps.some((c) => c.format === 'exit-stdout-stderr') && support('exitCode').length === 0) problems.push(`${e.id} ${v}: ${only('exitCode')} its exit code`)
      } else if (backing('exitCode').length === 0) problems.push(`${e.id} ${v}: nothing says why its exit code is not asserted`)
      for (const c of backing('exitCode')) {
        if ((c.exitCode ?? null) !== (e.expect.exitCode ?? null)) problems.push(`${e.id} ${v}: ${c.path} backs exit code ${c.exitCode}, the entry says ${e.expect.exitCode}`)
      }
      // The lines.
      if (lineMatchers.length > 0 && caps.length + schemas.length === 0) {
        if (support('lines').length === 0) problems.push(`${e.id} ${v}: ${only('lines')} its lines`)
        const samples = support('lines').flatMap((c) => c.samples ?? [])
        for (const m of textMatchers) if (!samples.some((s) => lineMatches(m, s, ctx))) problems.push(`${e.id} ${v}: no sample the CLI shows is accepted by ${JSON.stringify(m)}`)
      }
      for (const c of backing('lines')) {
        for (const s of c.samples ?? []) if (!textMatchers.some((m) => lineMatches(m, s, ctx))) problems.push(`${e.id} ${v}: ${c.path}'s sample ${JSON.stringify(s)} is not accepted by the entry's lines`)
      }
      if (valueConstraints && support('lines').length === 0) problems.push(`${e.id} ${v}: ${only('lines')} its field values`)
      // The stream the lines are on.
      for (const s of e.expect.streams) {
        if (s.lines.length > 0) {
          const ran = caps.some((c) => c.format === 'exit-stdout-stderr' || (c.format === 'stdout-jsonl' && s.stream === 'stdout'))
          if (!ran && !support('stream').some((c) => c.stream === s.stream)) problems.push(`${e.id} ${v}: nothing the CLI shows puts its lines on ${s.stream}`)
        }
        if (s.appReads !== undefined && (!s.appReads.includes(s.stream) || backing('appReads').length === 0)) problems.push(`${e.id} ${v}: appReads ${JSON.stringify(s.appReads)} is not backed or leaves out ${s.stream}`)
      }
      for (const c of backing('stream')) {
        if (!e.expect.streams.some((s) => s.stream === c.stream && s.lines.length > 0)) problems.push(`${e.id} ${v}: ${c.path} backs ${c.stream}, which the entry has no lines on`)
      }
      // What follows it.
      if (e.expect.afterwards !== undefined) {
        if (support('afterwards').length === 0) problems.push(`${e.id} ${v}: ${only('afterwards')} what follows it`)
        for (const c of backing('afterwards')) if (c.afterwards !== e.expect.afterwards) problems.push(`${e.id} ${v}: ${c.path} backs afterwards ${c.afterwards}, the entry says ${e.expect.afterwards}`)
      }
    }
  }
  return problems
}

// ---------------------------------------------------------------- (b) the fake side

const NUL = String.fromCharCode(0)
/** No real file system takes a path with a NUL in it: a write that escaped the
 *  in-memory capture would throw before it touched a disk. */
const VROOT = `/${NUL}ccc-oracle`
const vkey = (p: unknown) => nodePath.posix.normalize(String(p).replace(/\\/g, '/'))
const enoent = (p: unknown) => Object.assign(new Error(`ENOENT: ${String(p)}`), { code: 'ENOENT' })

class MemFs {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()
  mkdir(p: unknown): void { for (let d = vkey(p); d !== '/' && d !== '.'; d = nodePath.posix.dirname(d)) this.dirs.add(d) }
  write(p: unknown, data: unknown, append = false): void {
    const k = vkey(p)
    if (!this.dirs.has(nodePath.posix.dirname(k))) throw enoent(p)
    this.files.set(k, (append ? this.files.get(k) ?? '' : '') + String(data))
  }
  read(p: unknown): string { const v = this.files.get(vkey(p)); if (v === undefined) throw enoent(p); return v }
  exists(p: unknown): boolean { const k = vkey(p); return this.files.has(k) || this.dirs.has(k) }
  unlink(p: unknown): void { if (!this.files.delete(vkey(p))) throw enoent(p) }
}

/** Runs `f` with node:fs's writes caught in `m`, for paths under VROOT only. */
function captureWrites<T>(m: MemFs, f: () => T): T {
  const inRoot = (p: unknown) => {
    const k = vkey(p)
    if (k !== VROOT && !k.startsWith(`${VROOT}/`)) throw new Error(`refused a write outside the virtual root: ${String(p)}`)
    return k
  }
  const spies = [
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: unknown) => { m.mkdir(inRoot(p)); return undefined }) as never),
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: unknown, d: unknown) => { m.write(inRoot(p), d) }) as never),
    vi.spyOn(fs, 'appendFileSync').mockImplementation(((p: unknown, d: unknown) => { m.write(inRoot(p), d, true) }) as never),
  ]
  try { return f() } finally { for (const s of spies) s.mockRestore() }
}

interface FakeStdin {
  isTTY: true | undefined
  setEncoding(): undefined
  setRawMode(): undefined
  on(ev: string, cb: (chunk?: string) => void): FakeStdin
}
class Exited { constructor(readonly code: number) {} }
interface Stdin { tty: boolean; text?: string }

/** One run of a fake's script, in a vm context: argv, environment and stdin
 *  given, the file system `m`, timers that never fire, and no module but fs,
 *  path and crypto. A run still waiting when its input has ended has exit code
 *  null. */
function runScript(script: string, m: MemFs, dir: string, argv: readonly string[], env: Record<string, string>, stdin: Stdin): Outcome {
  const st = { exitCode: null as number | null, stdout: '', stderr: '' }
  const on: Record<string, Array<(chunk?: string) => void>> = {}
  const stdinObj: FakeStdin = {
    isTTY: stdin.tty ? true : undefined,
    setEncoding: () => undefined,
    setRawMode: () => undefined,
    on: (ev: string, cb: (chunk?: string) => void) => { (on[ev] ??= []).push(cb); return stdinObj },
  }
  const memFs = {
    existsSync: (p: unknown) => m.exists(p),
    readFileSync: (p: unknown) => m.read(p),
    writeFileSync: (p: unknown, d: unknown) => m.write(p, d),
    appendFileSync: (p: unknown, d: unknown) => m.write(p, d, true),
    mkdirSync: (p: unknown) => { m.mkdir(p) },
    unlinkSync: (p: unknown) => m.unlink(p),
  }
  const requireFake = (id: string): unknown => {
    if (id === 'fs') return memFs
    if (id === 'path') return nodePath.posix
    if (id === 'crypto') return { createHash }
    throw new Error(`REFUSED: the in-process fake asked for '${id}'`)
  }
  const proc = {
    argv: ['node', `${dir}/fake-codex.js`, ...argv],
    env: { ...env },
    execPath: `${VROOT}/node`,
    pid: 4242,
    platform: process.platform,
    cwd: () => dir,
    stdout: { write: (s: unknown) => { if (st.exitCode === null) st.stdout += String(s); return true } },
    stderr: { write: (s: unknown) => { if (st.exitCode === null) st.stderr += String(s); return true } },
    stdin: stdinObj,
    exit: (code?: number) => { if (st.exitCode === null) st.exitCode = code ?? 0; throw new Exited(st.exitCode) },
  }
  const context = vm.createContext({ setInterval: () => 0, setTimeout: () => 0, clearInterval: () => undefined, clearTimeout: () => undefined })
  const main = vm.runInContext(`(function (require, process, __dirname, __filename) {\n${script}\n})`, context) as (...args: unknown[]) => void
  const step = (f: () => void) => {
    if (st.exitCode !== null) return
    try { f() } catch (err) { if (!(err instanceof Exited)) throw err }
  }
  step(() => main(requireFake, proc, dir, `${dir}/fake-codex.js`))
  if (!stdin.tty) {
    if (stdin.text) for (const cb of on.data ?? []) step(() => cb(stdin.text))
    for (const cb of on.end ?? []) step(() => cb())
  }
  return { exitCode: st.exitCode, stdout: st.stdout, stderr: st.stderr }
}

interface World { m: MemFs; dir: string; home: string; script: string }
interface FakeDriver {
  versions: readonly string[]
  /** A world holding this fake at `version`, its realm not yet made. */
  install(version: string): World
  /** Signs the realm in, as this fake allows; false when it cannot. */
  signIn(kind: 'any' | 'api-key' | 'chatgpt', w: World): boolean
}
const envOf = (w: World) => ({ CODEX_HOME: w.home, PATH: '/usr/bin' })
const run = (w: World, argv: readonly string[], stdin: Stdin = { tty: false }) => runScript(w.script, w.m, w.dir, argv, envOf(w), stdin)

/** The FAKE constant of tests/wp1/fake-cli.test.ts, as the string it holds. */
function wp1FakeScript(): string {
  const text = readRepo('tests/wp1/fake-cli.test.ts') ?? ''
  const m = /\nconst FAKE = `([^`]*)`\r?\n/.exec(text)
  if (!m) throw new Error('the FAKE constant was not found in tests/wp1/fake-cli.test.ts')
  // A template literal with no substitution is a plain string: its value is
  // taken by the vm, which can run nothing in it.
  if (m[1].includes('${')) throw new Error('the FAKE constant has a substitution; read it another way')
  return vm.runInNewContext('`' + m[1] + '`') as string
}

function wp1Driver(script = wp1FakeScript()): FakeDriver {
  return {
    versions: ['0.155.1'],
    install: () => {
      const w = { m: new MemFs(), dir: `${VROOT}/wp1`, home: `${VROOT}/realms/r1`, script }
      w.m.mkdir(w.dir)
      return w
    },
    signIn: (kind, w) => {
      if (kind === 'api-key') run(w, ['login', '--with-api-key'], { tty: false, text: 'sk-oracle-test-key\n' })
      else run(w, ['login'])
      return true
    },
  }
}

/** The script installFakeCodex writes at `version`, caught in memory. */
function e2eFakeScript(version: string): string {
  const m = new MemFs()
  const dir = `${VROOT}/e2e`
  captureWrites(m, () => installFakeCodex(dir, version))
  return m.read(`${dir}/fake-codex.js`)
}

function e2eDriver(edit: (s: string) => string = (s) => s): FakeDriver {
  return {
    versions: ['0.153.4', '0.155.1'],
    install: (version) => {
      const w = { m: new MemFs(), dir: `${VROOT}/e2e`, home: `${VROOT}/realms/r1`, script: edit(e2eFakeScript(version)) }
      w.m.mkdir(w.dir)
      return w
    },
    signIn: (kind, w) => {
      if (kind === 'chatgpt') return false
      captureWrites(w.m, () => signInFakeRealm(w.home))
      return true
    },
  }
}

const stdinFor = (e: Entry, version: string): Stdin => e.preconditions.includes('stdin-tty')
  ? { tty: true }
  : { tty: false, text: e.preconditions.includes('stdin-pipe') ? (e.stdinLines ?? []).map((l) => `${subst(l, version)}\n`).join('') : undefined }

function fakeSideProblems(o: Oracle, drivers: Record<string, FakeDriver>): string[] {
  const problems: string[] = []
  const known = (o.knownDivergences ?? []).map((d) => ({ d, seen: false }))
  for (const e of o.entries) {
    for (const name of e.fakes) {
      const d = drivers[name]
      if (!d) { problems.push(`${e.id}: no driver for the fake ${name}`); continue }
      const versions = e.versions.filter((v) => d.versions.includes(v))
      if (versions.length === 0) problems.push(`${e.id}: ${name} plays none of its versions`)
      for (const v of versions) {
        const at = `${e.id} on ${name} ${v}`
        const w = d.install(v)
        let ready = true
        for (const p of e.preconditions) {
          if (p === 'empty-home') w.m.mkdir(w.home)
          else if (p === 'signed-in' || p === 'signed-in-api-key' || p === 'signed-in-chatgpt') {
            if (!d.signIn(p === 'signed-in' ? 'any' : p === 'signed-in-api-key' ? 'api-key' : 'chatgpt', w)) { problems.push(`${at}: the fake cannot set up ${p}`); ready = false }
          } else if (p !== 'stdin-pipe' && p !== 'stdin-tty') { problems.push(`${at}: unknown precondition ${p}`); ready = false }
        }
        if (!ready) continue
        const ctx: Ctx = { version: v, env: envOf(w) }
        const out = run(w, e.argv, stdinFor(e, v))
        // A recorded divergence: exactly that answer is accepted, and noted as seen.
        const k = known.find((x) => x.d.fake === name && x.d.entry === e.id && x.d.field === 'exitCode' && out.exitCode === x.d.fakeAnswers)
        if (k) k.seen = true
        problems.push(...outcomeProblems(k ? { ...e.expect, exitCode: k.d.fakeAnswers } : e.expect, out, ctx).map((p) => `${at}: ${p}`))
        if (e.expect.afterwards !== undefined) {
          const next = o.entries.find((x) => x.id === e.expect.afterwards)
          if (!next) { problems.push(`${at}: afterwards names no entry`); continue }
          problems.push(...outcomeProblems(next.expect, run(w, next.argv, stdinFor(next, v)), ctx).map((p) => `${at}, then ${next.id}: ${p}`))
        }
      }
    }
  }
  for (const k of known) if (!k.seen) problems.push(`the known divergence of ${k.d.fake} on ${k.d.entry} (${k.d.field} ${k.d.fakeAnswers}) no longer occurs: remove its record`)
  return problems
}

const DRIVERS = (): Record<string, FakeDriver> => ({ 'wp1-fake-cli': wp1Driver(), 'e2e-fake-codex': e2eDriver() })

// ---------------------------------------------------------------- the cases

describe('WP1.69 the fake Codex CLI oracle', () => {
  it('[host] is a versioned ASCII manifest for the contract\'s minimum and pinned CLI; each entry is what the app sends, claimed by a fake, with anchored lines', () => {
    expect(ORACLE_TEXT, `${ORACLE_FILE} is missing`).not.toBe('')
    expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(ORACLE_TEXT), 'the oracle is ASCII only').toBe(false)
    expect(ORACLE).toMatchObject({ schema: 'ccc-wp1-fake-cli-oracle/2', item: 'WP1.69', cli: 'codex', upstreamSource: SOURCE_FILE })
    expect(ORACLE.versions).toMatchObject({ minimum: CODEX_MIN_SUPPORTED_VERSION, pinned: CODEX_PINNED_CLI_VERSION })
    const covered = [ORACLE.versions.minimum, ORACLE.versions.pinned]
    expect(Object.keys(ORACLE.fakes).sort()).toEqual(Object.keys(DRIVERS()).sort())
    const ids = ORACLE.entries.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const problems: string[] = []
    for (const e of ORACLE.entries) {
      if (e.versions.length === 0 || e.versions.some((v) => !covered.includes(v))) problems.push(`${e.id}: versions ${e.versions}`)
      if (e.fakes.length === 0) problems.push(`${e.id}: no fake claims it`)
      for (const f of e.fakes) if (!ORACLE.fakes[f]) problems.push(`${e.id}: unknown fake ${f}`)
      for (const p of e.preconditions) if (!ORACLE.preconditions[p]) problems.push(`${e.id}: unknown precondition ${p}`)
      if (e.preconditions.includes('stdin-pipe') !== (e.stdinLines !== undefined)) problems.push(`${e.id}: stdinLines without a pipe, or a pipe without stdinLines`)
      if (e.expect.afterwards !== undefined && !ids.includes(e.expect.afterwards)) problems.push(`${e.id}: afterwards ${e.expect.afterwards}`)
      if (e.expect.exitCode !== undefined && !Number.isInteger(e.expect.exitCode)) problems.push(`${e.id}: exit code ${e.expect.exitCode} is not a number`)
      for (const s of e.expect.streams) if (s.stream !== 'stdout' && s.stream !== 'stderr') problems.push(`${e.id}: stream ${s.stream} is not the one the CLI uses`)
      for (const m of e.expect.streams.flatMap((s) => s.lines)) {
        const res = 'regex' in m ? [m.regex] : 'rpcResult' in m ? Object.values(m.rpcResult.fields).flatMap((f) => (f.regex ? [f.regex] : [])) : []
        for (const r of res) if (!r.startsWith('^') || !r.endsWith('$')) problems.push(`${e.id}: ${r} is not anchored`)
      }
      // The argv (and stdin) are exactly what the app sends.
      for (const v of e.versions) {
        let appArgv: unknown
        if (e.app.operation !== undefined) {
          const cmd = codexCommandLine('/usr/bin/codex', e.app.operation as CodexCliOperation, 'linux', {})
          appArgv = 'refused' in cmd ? cmd.refused : cmd.args
        } else if (e.app.agentSandbox !== undefined) appArgv = codexAgentArgs({ sandbox: e.app.agentSandbox })
        if (JSON.stringify(appArgv) !== JSON.stringify(e.argv)) problems.push(`${e.id}: the app sends ${JSON.stringify(appArgv)}`)
        if (e.app.stdin === 'appServerMessages') {
          const msgs = appServerMessages(v)
          const lines = (e.stdinLines ?? []).map((l) => subst(l, v))
          if (JSON.stringify(lines) !== JSON.stringify([msgs.initialize, msgs.initialized, msgs.read])) problems.push(`${e.id} ${v}: stdinLines are not the app's messages`)
        }
      }
    }
    for (const d of ORACLE.knownDivergences ?? []) {
      if (d.field !== 'exitCode' || !ids.includes(d.entry) || !entryOf(ORACLE, d.entry).fakes.includes(d.fake) || d.why.length < 20) problems.push(`divergence ${JSON.stringify(d)}`)
    }
    expect(problems).toEqual([])
  })

  it('[host] the upstream source fixture: exactly the minimum and pinned release tags, each file by commit, sha256 and blob, its lines in order', () => {
    expect(SOURCE_TEXT, `${SOURCE_FILE} is missing`).not.toBe('')
    expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(SOURCE_TEXT), 'the fixture is ASCII only').toBe(false)
    expect(SOURCE.versions.map((v) => v.version).sort()).toEqual([CODEX_MIN_SUPPORTED_VERSION, CODEX_PINNED_CLI_VERSION].sort())
    for (const v of SOURCE.versions) {
      expect(v.tag).toBe(`rust-v${v.version}`)
      expect(v.commitSha).toMatch(/^[0-9a-f]{40}$/)
      expect(v.tagObjectSha).toMatch(/^[0-9a-f]{40}$/)
      for (const s of v.sources) {
        expect(s.path, `${v.version} ${s.role}`).toMatch(/^codex-rs\//)
        expect(s.sha256, `${v.version} ${s.role}`).toMatch(/^[0-9a-f]{64}$/)
        expect(s.blobSha, `${v.version} ${s.role}`).toMatch(/^[0-9a-f]{40}$/)
        expect(s.excerpt.length, `${v.version} ${s.role}`).toBeGreaterThan(0)
        s.excerpt.forEach((e, i) => { if (i > 0) expect(e.line, `${v.version} ${s.role}: lines out of order`).toBeGreaterThan(s.excerpt[i - 1].line) })
      }
    }
  })

  it('[host] (a) the real side: every entry holds against its captures, schemas and upstream lines, and no claim rests on an app assumption alone', () => {
    expect(realSideProblems(ORACLE, readRepo)).toEqual([])
  })

  it('[host] (b) the fake side: each fake answers every entry it claims as the oracle says', () => {
    expect(fakeSideProblems(ORACLE, DRIVERS())).toEqual([])
  })

  it('[host] the in-process fake starts no process and writes nothing real', () => {
    // The FAKE's waiting browser sign-in starts a "browser": child_process,
    // which the sandbox refuses.
    const d = wp1Driver()
    const w = d.install('0.155.1')
    w.m.mkdir(w.home)
    w.m.write(`${w.home}/HANG`, '100')
    expect(() => run(w, ['login'])).toThrow(/REFUSED: the in-process fake asked for 'child_process'/)
    // The helper's writes land in memory; a path outside the virtual root is refused.
    const m = new MemFs()
    captureWrites(m, () => installFakeCodex(`${VROOT}/probe`, '0.155.1'))
    expect(m.read(`${VROOT}/probe/fake-codex.js`)).toContain("'codex-cli 0.155.1'")
    // (The probe path holds a NUL too, so even an uncaught write could not land.)
    expect(() => captureWrites(m, () => fs.writeFileSync(`/${NUL}elsewhere/x.txt`, 'x'))).toThrow(/outside the virtual root/)
  })

  it('[host] verify the verifier: a wrong exit code, line or stream, an altered upstream line, or an app assumption standing alone turns a side red', () => {
    const red = (f: (o: Oracle) => void) => {
      const o = clone(ORACLE)
      f(o)
      return { real: realSideProblems(o, readRepo).join('\n'), fake: fakeSideProblems(o, DRIVERS()).join('\n') }
    }
    const cite = (o: Oracle, id: string, kind: Kind, path: RegExp) => {
      const c = (entryOf(o, id).sources.citations ?? []).filter((x) => x.kind === kind && path.test(x.path))
      expect(c.length, `${id} has a ${kind} citation of ${path}`).toBeGreaterThan(0)
      return c
    }
    // A capture-backed entry: both sides.
    let r = red((o) => { entryOf(o, 'version').expect.exitCode = 2 })
    expect(r.real).toMatch(/version 0\.15[35]\.\d against .*version\.txt: exit code 0, the oracle says 2/)
    expect(r.fake).toMatch(/version on wp1-fake-cli 0\.155\.1: exit code 0, the oracle says 2/)
    r = red((o) => { (entryOf(o, 'version').expect.streams[0].lines[0] as { exact: string }).exact = 'codex {version}' })
    expect(r.real).toMatch(/version 0\.153\.4 against .*: stdout \(exactly\) does not hold/)
    expect(r.fake).toMatch(/version on e2e-fake-codex 0\.153\.4: stdout \(exactly\) does not hold/)
    r = red((o) => { (entryOf(o, 'exec-json-review').expect.streams[0].lines[3] as { regex: string }).regex = '^\\{"type":"turn\\.done".*$' })
    expect(r.real).toMatch(/exec-json-review 0\.155\.1 against .*exec-json\.jsonl: stdout \(inOrder\) does not hold/)
    expect(r.fake).toMatch(/exec-json-review on wp1-fake-cli 0\.155\.1: stdout/)
    // An upstream-backed entry: a wrong exit code, line or stream.
    r = red((o) => { entryOf(o, 'login-status-signed-out').expect.exitCode = 0 })
    expect(r.real).toMatch(/login-status-signed-out 0\.153\.4: codex-rs\/cli\/src\/login\.rs backs exit code 1, the entry says 0/)
    expect(r.fake).toMatch(/login-status-signed-out on e2e-fake-codex 0\.153\.4: exit code 1, the oracle says 0/)
    r = red((o) => {
      // Every citation moved to the wrong code too: the upstream lines still say 1.
      entryOf(o, 'login-api-key-tty-refused').expect.exitCode = 2
      for (const c of entryOf(o, 'login-api-key-tty-refused').sources.citations ?? []) if ((c.backs ?? []).includes('exitCode')) c.exitCode = 2
      o.knownDivergences = []
    })
    expect(r.real).toMatch(/login-api-key-tty-refused: codex-rs\/cli\/src\/login\.rs exits 1, the citation says 2/)
    r = red((o) => { (entryOf(o, 'login-status-api-key').expect.streams[0].lines[0] as { regex: string }).regex = '^Logged in with an API key$' })
    expect(r.real).toMatch(/login-status-api-key 0\.155\.1: no sample the CLI shows is accepted/)
    expect(r.fake).toMatch(/login-status-api-key on wp1-fake-cli 0\.155\.1: stderr \(inOrder\)/)
    r = red((o) => { entryOf(o, 'login-status-chatgpt').expect.streams[0].stream = 'stdout' })
    expect(r.real).toMatch(/login-status-chatgpt 0\.155\.1: nothing the CLI shows puts its lines on stdout/)
    expect(r.real).toMatch(/codex-rs\/cli\/src\/login\.rs backs stderr, which the entry has no lines on/)
    expect(r.fake).toMatch(/login-status-chatgpt on wp1-fake-cli 0\.155\.1: stdout \(inOrder\) does not hold/)
    // An upstream line altered, a sample the lines do not print, a line that is not in the fixture.
    r = red((o) => { cite(o, 'login-status-signed-out', 'upstream', /login\.rs$/)[0].excerpt![2].text = '            eprintln!("Not signed in");' })
    expect(r.real).toMatch(/login-status-signed-out 0\.153\.4: codex-rs\/cli\/src\/login\.rs:500 is not that line in the upstream fixture/)
    r = red((o) => { cite(o, 'login-status-chatgpt', 'upstream', /login\.rs$/)[0].samples = ['Signed in using ChatGPT'] })
    expect(r.real).toMatch(/login-status-chatgpt: codex-rs\/cli\/src\/login\.rs prints no line like the sample "Signed in using ChatGPT"/)
    r = red((o) => { cite(o, 'logout-signs-out', 'upstream', /login\.rs$/)[0].excerpt![0].line = 509 })
    expect(r.real).toMatch(/logout-signs-out 0\.155\.1: codex-rs\/cli\/src\/login\.rs:509 is not that line/)
    // An app assumption left as the sole backing.
    r = red((o) => { const e = entryOf(o, 'login-status-chatgpt'); e.sources.citations = (e.sources.citations ?? []).filter((c) => c.kind !== 'upstream') })
    expect(r.real).toMatch(/login-status-chatgpt 0\.155\.1: only an app assumption backs its exit code/)
    expect(r.real).toMatch(/login-status-chatgpt 0\.155\.1: only an app assumption backs its lines\b/)
    expect(r.real).toMatch(/login-status-chatgpt 0\.155\.1: nothing the CLI shows puts its lines on stderr/)
    r = red((o) => { const e = entryOf(o, 'debug-models-bundled'); e.sources.citations = (e.sources.citations ?? []).filter((c) => c.kind !== 'upstream') })
    expect(r.real).toMatch(/debug-models-bundled 0\.155\.1: only an app assumption backs its exit code/)
    r = red((o) => { for (const c of cite(o, 'login-status-signed-out', 'app-assumption', /cli-contract\.ts$/)) c.kind = 'observation' })
    expect(r.real).toMatch(/login-status-signed-out: src\/main\/providers\/codex\/cli-contract\.ts is the app's own, so an app assumption/)
    // An app assumption that disagrees with the CLI.
    r = red((o) => { cite(o, 'login-status-signed-out', 'app-assumption', /plan\.md$/)[0].exitCode = 2 })
    expect(r.real).toMatch(/login-status-signed-out 0\.155\.1: docs\/wp2\/plan\.md backs exit code 2, the entry says 1/)
    // A schema-backed entry: a field the CLI's schema does not require.
    r = red((o) => {
      const m = entryOf(o, 'app-server-usage-read').expect.streams[0].lines[0] as { rpcResult: { fields: Record<string, FieldSpec> } }
      m.rpcResult.fields.codexHomeDir = m.rpcResult.fields.codexHome
      delete m.rpcResult.fields.codexHome
    })
    expect(r.real).toMatch(/app-server-usage-read 0\.153\.4: initializeResponse does not require codexHomeDir/)
    expect(r.fake).toMatch(/app-server-usage-read on e2e-fake-codex 0\.155\.1: stdout/)
    // A document entry, and a citation that is not in its file.
    r = red((o) => {
      const m = entryOf(o, 'debug-models-bundled').expect.streams[0].lines[0] as { json: { models: FieldSpec } }
      m.json.models.each = { ...m.json.models.each, displayName: { type: 'string' } }
    })
    expect(r.real).toMatch(/debug-models-bundled 0\.153\.4 against .*trimmed\.json: stdout \(document\)/)
    expect(r.fake).toMatch(/debug-models-bundled on wp1-fake-cli 0\.155\.1: stdout \(document\)/)
    r = red((o) => { cite(o, 'login-status-chatgpt', 'app-assumption', /cli-contract\.ts$/)[0].quote = 'The pinned CLI prints one line: `Signed in using ChatGPT`' })
    expect(r.real).toMatch(/login-status-chatgpt: src\/main\/providers\/codex\/cli-contract\.ts does not contain/)
    // An unbacked exit code.
    r = red((o) => { entryOf(o, 'exec-json-cloud-agent').sources.citations = [] })
    expect(r.real).toMatch(/exec-json-cloud-agent 0\.155\.1: nothing backs its exit code/)
  })

  it('[host] verify the verifier: an injected fake that answers differently turns the fake side red', () => {
    const base = wp1FakeScript()
    const inject = (from: string, to: string) => {
      expect(base.includes(from), `the FAKE holds ${from}`).toBe(true)
      return fakeSideProblems(ORACLE, { 'wp1-fake-cli': wp1Driver(base.split(from).join(to)), 'e2e-fake-codex': e2eDriver() }).join('\n')
    }
    expect(inject("process.stderr.write('Not logged in\\n'); process.exit(1)", "process.stderr.write('Not logged in\\n'); process.exit(3)"))
      .toMatch(/login-status-signed-out on wp1-fake-cli 0\.155\.1: exit code 3, the oracle says 1/)
    expect(inject("'Not logged in\\n'", "'Not signed in\\n'")).toMatch(/login-status-signed-out on wp1-fake-cli 0\.155\.1: stderr/)
    expect(inject("process.stderr.write('Not logged in\\n')", "process.stdout.write('Not logged in\\n')")).toMatch(/login-status-signed-out on wp1-fake-cli 0\.155\.1: stderr \(inOrder\) does not hold/)
    expect(inject("'codex-cli 0.155.1\\n'", "'codex-cli 0.155.2\\n'")).toMatch(/version on wp1-fake-cli 0\.155\.1: stdout/)
    expect(inject("{ type: 'turn.started' }", "{ type: 'turn.begun' }")).toMatch(/exec-json-review on wp1-fake-cli 0\.155\.1: stdout/)
    // The recorded TTY divergence: any other answer is red, and so is the fix without its record going.
    const noTtyCheck = inject("if (process.stdin.isTTY) { process.stderr.write('refuses a TTY\\n'); process.exit(2) }", '')
    expect(noTtyCheck).toMatch(/login-api-key-tty-refused on wp1-fake-cli 0\.155\.1: exit code null, the oracle says 1/)
    expect(noTtyCheck).toMatch(/the known divergence of wp1-fake-cli on login-api-key-tty-refused \(exitCode 2\) no longer occurs/)
    const fixed = inject("process.stderr.write('refuses a TTY\\n'); process.exit(2)", "process.stderr.write('refuses a TTY\\n'); process.exit(1)")
    expect(fixed).toMatch(/no longer occurs: remove its record/)
    expect(fixed).not.toMatch(/login-api-key-tty-refused on wp1-fake-cli 0\.155\.1: exit code/)
    expect(inject("if (!d.trim()) process.exit(3)", "process.exit(3)")).toMatch(/login-api-key-pipe on wp1-fake-cli 0\.155\.1: exit code 3, the oracle says 0/)
    expect(inject("try { fs.unlinkSync(auth) } catch {}", '')).toMatch(/logout-signs-out on wp1-fake-cli 0\.155\.1, then login-status-signed-out/)
    expect(inject("codexHome: mode === 'wrong-home' ? path.dirname(home) : home", 'codexHome: path.dirname(home)')).toMatch(/app-server-usage-read on wp1-fake-cli 0\.155\.1: stdout/)
    expect(inject("{ slug: 'gpt-5.5', display_name: 'GPT-5.5',", "{ slug: 'gpt-5.5', label: 'GPT-5.5',")).toMatch(/debug-models-bundled on wp1-fake-cli 0\.155\.1: stdout \(document\)/)
    expect(inject("'Logged in using ChatGPT\\n'", "'Logged in via ChatGPT\\n'")).toMatch(/login-status-chatgpt on wp1-fake-cli 0\.155\.1: stderr/)
    // The e2e helper's script, edited after it is captured.
    const e2e = (from: string, to: string) => {
      expect(e2eFakeScript('0.153.4').includes(from), `the e2e fake holds ${from}`).toBe(true)
      return fakeSideProblems(ORACLE, { 'wp1-fake-cli': wp1Driver(), 'e2e-fake-codex': e2eDriver((s) => s.split(from).join(to)) }).join('\n')
    }
    expect(e2e("'codex-cli ", "'codex ")).toMatch(/version on e2e-fake-codex 0\.153\.4: stdout/)
    expect(e2e("process.stderr.write('Not logged in' + NL); process.exit(1)", "process.stderr.write('Not logged in' + NL); process.exit(0)"))
      .toMatch(/login-status-signed-out on e2e-fake-codex 0\.155\.1: exit code 0, the oracle says 1/)
    expect(e2e("ev({ type: 'turn.completed', usage: { input_tokens: 1200,", "ev({ type: 'turn.completed', usage: { input: 1200,")).toMatch(/exec-json-cloud-agent on e2e-fake-codex 0\.153\.4: stdout/)
    expect(e2e("userAgent: 'codex_cli_rs/", "userAgent: 'codex_cli_rs/9.")).toMatch(/app-server-usage-read on e2e-fake-codex 0\.153\.4: stdout/)
  })
})
