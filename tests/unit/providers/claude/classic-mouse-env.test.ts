/**
 * TDD: CLAUDE_CODE_DISABLE_MOUSE env injection
 *
 * When classicTerminalCopyPaste is true (or undefined/unset), the Claude local
 * spawn env must include CLAUDE_CODE_DISABLE_MOUSE=1 so xterm owns the mouse
 * instead of CC (classic selection + right-click copy/paste).
 *
 * When false the var must be absent so CC's mouse mode is preserved.
 *
 * Shell-only sessions (elevated included) MUST receive the same vars. An earlier
 * revision of this file asserted the opposite — that shell-only sessions were
 * exempt — which pinned a live defect: the vars are inert for the shell itself
 * but govern any `claude` the user starts by hand, and the account re-auth flow
 * drops users at a shell-only prompt to do exactly that. The exempted claude ran
 * with mouse tracking on, xterm's selection came back empty, and right-click
 * "copy" became paste-into-the-PTY — at a shell prompt, EXECUTION of the
 * clipboard. SSH sessions still go through a different path.
 *
 * Note: we clear CLAUDE_CODE_DISABLE_MOUSE from process.env before each test
 * because the developer machine (and CI) may run with this var set, which would
 * bleed through the `{ ...process.env }` spread into the "should be absent"
 * assertions and produce false failures.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// On Windows, programs are found in PATH's folders (windows-programs.ts); stubbed here,
// so no real PATH is read: the first name asked for, in one fully qualified folder
// (the walk on the event loop and the one off it alike).
vi.mock('../../../../src/main/windows-programs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/windows-programs')>()),
  findOnWindowsPath: (names: readonly string[]) => `C:\\Tools\\${names[0]}`,
  findOnWindowsPathAsync: async (names: readonly string[]) => `C:\\Tools\\${names[0]}`,
}))
import { buildClaudeLocalSpawn } from '../../../../src/main/providers/claude/spawn'

const BASE_OPTS = { sessionId: 'ses-1', cwd: '/work', cols: 80, rows: 24 }

beforeEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE
  delete process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS
  delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE
  delete process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS
  delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
})

describe('buildClaudeLocalSpawn — CLAUDE_CODE_DISABLE_MOUSE', () => {
  it('sets CLAUDE_CODE_DISABLE_MOUSE=1 when classicTerminalCopyPaste is true', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, classicTerminalCopyPaste: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBe('1')
  })

  it('sets CLAUDE_CODE_DISABLE_MOUSE=1 when classicTerminalCopyPaste is undefined (default-on)', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBe('1')
  })

  it('omits CLAUDE_CODE_DISABLE_MOUSE when classicTerminalCopyPaste is false', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, classicTerminalCopyPaste: false })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined()
  })

  it('sets CLAUDE_CODE_DISABLE_MOUSE=1 for shell-only sessions (classic true)', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true, classicTerminalCopyPaste: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBe('1')
  })

  it('sets CLAUDE_CODE_DISABLE_MOUSE=1 for shell-only sessions (classic undefined = default-on)', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBe('1')
  })

  it('omits CLAUDE_CODE_DISABLE_MOUSE for shell-only sessions when classic is false', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true, classicTerminalCopyPaste: false })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined()
  })

  it('sets CLAUDE_CODE_DISABLE_MOUSE=1 for ELEVATED shell-only sessions too', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true, elevated: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBe('1')
  })

  it('stamps the other protective CLAUDE vars for shell-only sessions (defaults)', () => {
    // Same rationale as the mouse var: a hand-run `claude` in a Terminal must get
    // the identical protective treatment as a CCC-launched one. Clickable
    // questions default off ⇒ DISABLE_MOUSE_CLICKS; background tasks default
    // disabled ⇒ DISABLE_BACKGROUND_TASKS; classic default ⇒ alt-screen off.
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true })
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1')
  })
})
