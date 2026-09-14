// tests/unit/main/pty-handlers-sessionid.test.ts
//
// #242 finding F2 (MAJOR, adversarial review round 5): sessionIdSchema had
// no charset regex, unlike every neighbouring field on this IPC surface
// (effortLevel, model -- see pty-handlers-effort.test.ts). sessionId reaches
// ssh-shim.ts's statusLine.command, a string Claude Code runs via `sh -c` on
// every statusline refresh -- an unsanitised value there is shell-
// interpolated, so even a value with no quote character (e.g. `x;id`) is
// enough to inject. Real ids are randomId()'s 24 lowercase-hex chars
// (src/shared/id.ts), which already satisfy the new charset guard -- this
// only ever rejects something a real id could never be.
import { describe, it, expect } from 'vitest'
import { sessionIdSchema } from '../../../src/main/ipc/pty-handlers'

describe('sessionIdSchema charset guard (#242 finding F2)', () => {
  it('accepts a real randomId()-shaped session id (24 lowercase hex chars)', () => {
    expect(() => sessionIdSchema.parse('a1b2c3d4e5f6a1b2c3d4e5f6')).not.toThrow()
  })

  it('accepts ids carrying an allowlisted prefix + hex, and hyphen/underscore', () => {
    expect(() => sessionIdSchema.parse('sid-1')).not.toThrow()
    expect(() => sessionIdSchema.parse('sid_1')).not.toThrow()
  })

  // Mutation to prove this can fail: remove the `.regex(...)` call from
  // sessionIdSchema -- every assertion below then passes parse() and the
  // `.toThrow()` expectations fail.
  it('rejects a sessionId carrying a shell metacharacter with no quote at all', () => {
    expect(() => sessionIdSchema.parse('x;id')).toThrow()
  })

  it('rejects a sessionId carrying a subshell/backtick/pipe', () => {
    expect(() => sessionIdSchema.parse('x$(id)')).toThrow()
    expect(() => sessionIdSchema.parse('x`id`')).toThrow()
    expect(() => sessionIdSchema.parse('x|id')).toThrow()
    expect(() => sessionIdSchema.parse('x&&id')).toThrow()
  })

  it('rejects a sessionId containing whitespace', () => {
    expect(() => sessionIdSchema.parse('x id')).toThrow()
  })

  it('rejects a sessionId containing a quote', () => {
    expect(() => sessionIdSchema.parse(`x'id`)).toThrow()
    expect(() => sessionIdSchema.parse('x"id')).toThrow()
  })
})
