// At start, the profile steps that write a sign-in are handed to the sign-in
// folder check as a function, which the check calls once every profile's
// folders are checked; none of them runs while that call is being built, and
// none runs anywhere else. Read from index.ts's syntax tree, not its text (a
// call in a comment or a string is not a call): the start sequence runs inside
// Electron's ready handler, which no unit test here starts. The check's own
// ordering is pinned in account-profiles-owner-only-credentials.test.ts.
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { parse } from '@babel/parser'

type Node = { type: string; [key: string]: unknown }
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && typeof (v as Node).type === 'string'

/** Every node below `root`, `root` included. */
function nodesOf(root: Node, out: Node[] = []): Node[] {
  out.push(root)
  for (const [key, value] of Object.entries(root)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
    for (const v of Array.isArray(value) ? value : [value]) if (isNode(v)) nodesOf(v, out)
  }
  return out
}
/** The calls below `root` whose callee is the plain name `name`. */
const callsTo = (root: Node, name: string): Node[] => nodesOf(root).filter((n) => n.type === 'CallExpression'
  && isNode(n.callee) && n.callee.type === 'Identifier' && (n.callee as { name?: string }).name === name)

const src = fs.readFileSync(path.join(__dirname, '../../../src/main/index.ts'), 'utf8')
const program = parse(src, { sourceType: 'module', plugins: ['typescript'] }).program as unknown as Node
const STEPS = ['runFirstRunCapture', 'cleanupSessionHomes', 'syncPrimaryCredentialsWithGlobal']

describe('the start\'s profile steps run only after the sign-in folders are checked', () => {
  // Mutation to prove this can fail: run the steps while the call is built and hand the check a function that does nothing.
  it('are handed to the folder check as a function, called inside it and nowhere else', () => {
    const calls = callsTo(program, 'startOwnerOnlyCredentialFolders')
    expect(calls).toHaveLength(1)
    const args = calls[0].arguments as Node[]
    expect(args.length).toBeGreaterThan(0)
    const steps = args[0]
    expect(['ArrowFunctionExpression', 'FunctionExpression']).toContain(steps.type)
    for (const step of STEPS) {
      expect(callsTo(steps, step), `${step} inside the steps`).toHaveLength(1)
      expect(callsTo(program, step), `${step} in index.ts`).toHaveLength(1)
    }
  })
})
