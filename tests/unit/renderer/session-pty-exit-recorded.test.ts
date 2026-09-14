/**
 * The half of the Ask-revive fix that no behavioural test can reach.
 *
 * `askSessionIsLive` is only as good as whatever SETS `ptyExited`, and that
 * lives in TerminalView's `pty.onExit` subscription — inside a component that
 * builds an xterm terminal, a WebGL addon and a ResizeObserver on mount, none of
 * which exist in jsdom. Delete the two lines and every behavioural test still
 * passes while the fix is inert in the running app: nothing would ever mark a
 * session dead, so the launch path would go back to writing into a dead PTY.
 *
 * So this reads the source. It is a weak form of test and it is the right one
 * here: it pins the exact invariant the diagnosis showed was missing, and it
 * fails if either line is removed.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.resolve(__dirname, '../../../src/renderer/components/TerminalView.tsx')

/** The body of the `pty.onExit(sessionId, …)` callback, brace-matched. */
function onExitBody(src: string): string {
  const start = src.indexOf('window.electronAPI.pty.onExit(sessionId')
  expect(start).toBeGreaterThan(-1)
  const open = src.indexOf('{', src.indexOf('=>', start))
  expect(open).toBeGreaterThan(-1)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error('unbalanced braces in the onExit callback')
}

describe('a PTY that exits is recorded on its session', () => {
  const src = fs.readFileSync(SRC, 'utf8')
  const body = onExitBody(src)

  it('the exit handler marks the session as no longer live', () => {
    // Without this, a session object outlives its process indistinguishably
    // from a running one, and anything that writes to "the existing session"
    // writes into main's pendingWrites buffer -- which only a spawn drains, and
    // which a spawn clears before it fills.
    expect(body).toMatch(/ptyExited:\s*true/)
    expect(body).toMatch(/updateSession\(sessionId/)
  })

  it('the exit handler clears the spawn tracker so a remount can respawn', () => {
    // The revive path bumps createdAt to force a remount. If the id is still
    // marked spawned, the remounted view declines to spawn and the revived tab
    // sits there dead with the question never delivered.
    expect(body).toMatch(/clearSpawned\(sessionId\)/)
  })

  it('the handler still tells the user, which is what it was doing before', () => {
    expect(body).toContain('Process exited with code')
  })
})
