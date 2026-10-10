// [host] Main's start-up wires an account's claude.ai web session clears as
// their guarantees need (account-web/claude-web-wiring.ts). The function is
// CALLED here with the modules it wires faked, so what it registers is
// asserted by behaviour, not by text:
//  - before a wipe, the account's views and its artifacts window close;
//  - at start, the listed accounts are swept once, over the record store read
//    once, with partition folders looked for under this instance's own session
//    data folder.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { parse } from '@babel/parser'

const W = vi.hoisted(() => ({
  closing: [] as Array<(profileId: string) => void>,
  panesClosed: [] as string[],
  artifactsClosed: [] as string[],
  swept: [] as Array<{ ids: readonly string[]; records: unknown; partitionExists: (id: string) => boolean }>,
  recordsRead: 0,
  recordsThrow: false,
  profiles: [] as Array<{ id: string }>,
  profilesThrow: false,
  folderRoots: [] as string[],
  sessionDataAsked: 0,
}))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => { if (name === 'sessionData') W.sessionDataAsked++; return `/instance/${name}` } },
}))
vi.mock('../../../src/main/account-profiles', () => ({
  listProfiles: () => { if (W.profilesThrow) throw new Error('profiles unreadable'); return W.profiles },
}))
vi.mock('../../../src/main/account-web/account-pane', () => ({
  closeAccountPanesForProfile: (id: string, reason?: string) => { W.panesClosed.push(reason === undefined ? id : `${id} (${reason})`) },
}))
vi.mock('../../../src/main/account-web/artifacts', () => ({
  closeArtifacts: (id: string) => { W.artifactsClosed.push(id) },
}))
vi.mock('../../../src/main/account-web/session-store', () => ({
  readClaudeWebRecordsForSweep: () => {
    W.recordsRead++
    if (W.recordsThrow) throw new Error('store unreadable')
    return { ok: true, profiles: new Set(['profile-recorded']) }
  },
}))
vi.mock('../../../src/main/account-web/sign-in', () => ({
  onClaudeWebSessionClosing: (fn: (id: string) => void) => { W.closing.push(fn) },
  sweepUnrecordedClaudeWebSessions: async (ids: readonly string[], records: unknown, partitionExists: (id: string) => boolean) => {
    W.swept.push({ ids, records, partitionExists })
    return []
  },
  claudePartitionFolderExists: (root: () => string) => (id: string) => { W.folderRoots.push(`${root()}|${id}`); return true },
}))

const { wireClaudeWebSession } = await import('../../../src/main/account-web/claude-web-wiring')

beforeEach(() => {
  W.closing.length = 0; W.panesClosed.length = 0; W.artifactsClosed.length = 0; W.swept.length = 0
  W.recordsRead = 0; W.recordsThrow = false; W.profiles = [{ id: 'profile-aaa111' }, { id: 'profile-bbb222' }]; W.profilesThrow = false
  W.folderRoots.length = 0; W.sessionDataAsked = 0
})

describe('[host] the claude.ai web session start-up wiring', () => {
  it("before a wipe, the account's views and its artifacts window close", () => {
    wireClaudeWebSession()
    expect(W.closing).toHaveLength(2)
    for (const fn of W.closing) fn('profile-aaa111')
    expect(W.panesClosed).toEqual(['profile-aaa111'])
    expect(W.artifactsClosed).toEqual(['profile-aaa111'])
  })

  it("at start, the listed accounts are swept once, over the record store read once, under this instance's own session data folder", () => {
    wireClaudeWebSession()
    expect(W.recordsRead).toBe(1)
    expect(W.swept).toHaveLength(1)
    expect(W.swept[0].ids).toEqual(['profile-aaa111', 'profile-bbb222'])
    expect(W.swept[0].records).toEqual({ ok: true, profiles: new Set(['profile-recorded']) })
    expect(W.swept[0].partitionExists('profile-aaa111')).toBe(true)
    expect(W.folderRoots).toEqual(['/instance/sessionData|profile-aaa111'])
  })

  it('a folder check handed in is the one used', () => {
    const asked: string[] = []
    wireClaudeWebSession({ partitionExists: (id) => { asked.push(id); return false }, profileIds: () => ['profile-ccc333'] })
    expect(W.swept[0].ids).toEqual(['profile-ccc333'])
    expect(W.swept[0].partitionExists('profile-ccc333')).toBe(false)
    expect(asked).toEqual(['profile-ccc333'])
    expect(W.sessionDataAsked).toBe(0)
  })

  it('an account list that cannot be read sweeps no account', () => {
    W.profilesThrow = true
    expect(() => wireClaudeWebSession()).not.toThrow()
    expect(W.swept[0].ids).toEqual([])
  })

  it('a record store read that throws makes the sweep stand down, and start-up goes on', () => {
    W.recordsThrow = true
    expect(() => wireClaudeWebSession()).not.toThrow()
    expect(W.swept[0].records).toMatchObject({ ok: false })
  })
})

/** A syntax tree node, as far as the walk below reads it. */
type AstNode = { type: string; [key: string]: unknown }
const SKIP = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens'])

/** Every node under `node` (itself included), with the statement list it sits in directly, if any. */
function* walk(node: unknown, list: AstNode[] | null = null): Generator<{ node: AstNode; list: AstNode[] | null }> {
  if (Array.isArray(node)) { for (const n of node) yield* walk(n, list); return }
  if (!node || typeof node !== 'object' || typeof (node as AstNode).type !== 'string') return
  const n = node as AstNode
  yield { node: n, list }
  for (const [key, value] of Object.entries(n)) {
    if (SKIP.has(key) || !value || typeof value !== 'object') continue
    // A block's (or the program's) own statements sit directly in its body.
    const own = key === 'body' && Array.isArray(value) && (n.type === 'BlockStatement' || n.type === 'Program') ? value as AstNode[] : null
    if (own) { for (const s of own) yield* walk(s, own) } else yield* walk(value, null)
  }
}

/** A call whose callee is the plain name `name`. */
const callTo = (n: AstNode, name: string): boolean => n.type === 'CallExpression' && (n.callee as AstNode)?.type === 'Identifier' && (n.callee as { name?: string }).name === name

describe("[host] main's start-up calls the claude.ai web session wiring", () => {
  // Read from index.ts's syntax tree, not its text: a call in a comment or a
  // string is not a call, and a call's block is the block it really runs in.
  const src = fs.readFileSync(path.join(__dirname, '../../../src/main/index.ts'), 'utf8')
  const program = parse(src, { sourceType: 'module', plugins: ['typescript'] }).program as unknown as AstNode
  const nodes = [...walk(program)]

  it('once, as a plain statement in the block that declares the app-window getter, after it, and nothing else wires it', () => {
    const imported = nodes.some(({ node: n }) => n.type === 'ImportDeclaration' && (n.source as { value?: string }).value === './account-web/claude-web-wiring'
      && n.importKind !== 'type' && (n.specifiers as AstNode[]).some((sp) => sp.type === 'ImportSpecifier' && sp.importKind !== 'type'
        && (sp.local as { name?: string }).name === 'wireClaudeWebSession' && (sp.imported as { name?: string }).name === 'wireClaudeWebSession'))
    expect(imported, "import { wireClaudeWebSession } from './account-web/claude-web-wiring'").toBe(true)

    const calls = nodes.filter(({ node: n }) => callTo(n, 'wireClaudeWebSession'))
    expect(calls, 'exactly one call').toHaveLength(1)
    expect((calls[0].node.arguments as unknown[]).length, 'called with no arguments').toBe(0)

    // The call is a statement of its own, directly in a block (never an if's,
    // a loop's or a ternary's unbraced branch, never inside an expression).
    const statement = nodes.find(({ node: n }) => n.type === 'ExpressionStatement' && n.expression === calls[0].node)
    expect(statement?.list, 'a plain statement directly in a block').toBeTruthy()
    const block = statement!.list!
    // ...and that block is the one that declares the app-window getter, before the call.
    const getterAt = block.findIndex((s) => s.type === 'VariableDeclaration'
      && (s.declarations as AstNode[]).some((d) => (d.id as { name?: string }).name === 'getWindow'))
    expect(getterAt, 'the block declares getWindow').toBeGreaterThanOrEqual(0)
    expect(block.indexOf(statement!.node), 'after the getter').toBeGreaterThan(getterAt)

    for (const direct of ['onClaudeWebSessionClosing', 'sweepUnrecordedClaudeWebSessions']) {
      expect(nodes.filter(({ node: n }) => callTo(n, direct)), `${direct} is wired only through wireClaudeWebSession`).toEqual([])
    }
  })
})
