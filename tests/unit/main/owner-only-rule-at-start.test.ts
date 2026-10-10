// [host] At start the main process checks every account's sign-in folders
// with the account profiles module's own owner-only rule: index.ts starts the
// check once, handing it only the profile steps to run after it, so no other
// rule (one that passes every folder among them) can stand in for the
// module's default. Read from index.ts's syntax tree, not its text: a call
// in a comment or a string is not a call, and a second argument, a spread, a
// rename or the function handed on as a value would each be another route to
// another rule. The rule itself is pinned in the account profiles suites.
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { parse } from '@babel/parser'

const NAME = 'startOwnerOnlyCredentialFolders'

type Node = { type: string; [key: string]: unknown }
const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string'

/** Every node under `root`, each with its parent. */
function walk(root: Node, visit: (n: Node, parent: Node | null) => void, parent: Node | null = null): void {
  visit(root, parent)
  for (const [key, v] of Object.entries(root)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
    if (Array.isArray(v)) { for (const c of v) if (isNode(c)) walk(c, visit, root) }
    else if (isNode(v)) walk(v, visit, root)
  }
}

describe("at start the sign-in folders are checked with the account profiles module's own rule", () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../src/main/index.ts'), 'utf8')
  const program = parse(src, { sourceType: 'module', plugins: ['typescript'] }).program as unknown as Node

  it('index.ts imports the check under its own name from the account profiles module, and from nowhere else', () => {
    const imports: Array<{ from: string; imported: string; local: string; typeOnly: boolean }> = []
    walk(program, (n) => {
      if (n.type !== 'ImportDeclaration') return
      for (const sp of (n.specifiers as Node[])) {
        const local = (sp.local as Node).name as string
        const imported = sp.type === 'ImportSpecifier' ? (((sp.imported as Node).name ?? (sp.imported as Node).value) as string) : '*'
        if (local === NAME || imported === NAME) imports.push({ from: (n.source as Node).value as string, imported, local, typeOnly: n.importKind === 'type' || sp.importKind === 'type' })
      }
    })
    expect(imports).toEqual([{ from: './account-profiles', imported: NAME, local: NAME, typeOnly: false }])
  })

  it('it is called exactly once, with exactly one argument: the steps, a function written there (the rule is left to its default)', () => {
    const uses: Array<{ node: Node; parent: Node | null }> = []
    walk(program, (n, parent) => {
      if (parent?.type === 'ImportSpecifier') return
      if (n.type === 'Identifier' && n.name === NAME) uses.push({ node: n, parent })
    })
    // The one use outside the import is the callee of the one call: never
    // handed on as a value, renamed, called through .call / .apply / .bind,
    // or called a second time.
    expect(uses).toHaveLength(1)
    const call = uses[0].parent
    expect(call?.type).toBe('CallExpression')
    expect(call!.callee).toBe(uses[0].node)
    const args = call!.arguments as Node[]
    expect(args).toHaveLength(1)
    expect(['ArrowFunctionExpression', 'FunctionExpression']).toContain(args[0].type)
  })
})
