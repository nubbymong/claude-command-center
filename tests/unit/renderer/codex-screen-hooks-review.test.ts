// P3.10: Codex's review of new or changed hooks is a blocking screen. The app's
// hooks come through `-c`, which Codex treats as hooks to review once ("Hooks
// need review ... Trust all and continue"), and its first option opens the
// /hooks view. Nothing the app types (Plan mode's /plan, Compact, the model
// pill, the Watchdog's retry) may land in either, so both read as 'blocked'.
// The rows are the real screens of the P3.10 VM probe (0.155.1 and 0.153.4),
// with the paths anonymised. The reading is the one module both the renderer
// and main use (src/shared/codex-screen.ts).
import { describe, it, expect } from 'vitest'
import { readCodexScreen, codexComposerState } from '../../../src/renderer/lib/codexComposer'
import { readCodexScreen as sharedRead } from '../../../src/shared/codex-screen'
import type { ScreenLine } from '../../../src/shared/codex-screen'

const P = '\u203a'
const plain = (text: string): ScreenLine => ({ text, typed: text })

const REVIEW: ScreenLine[] = [
  plain(''),
  plain('  Hooks need review'),
  plain('  6 hooks are new or changed.'),
  plain('  Hooks can run outside the sandbox after you trust them.'),
  plain(''),
  plain(`${P} 1. Review hooks`),
  plain('  2. Trust all and continue'),
  plain("  3. Continue without trusting (hooks won't run)"),
  plain(''),
  plain('  Press enter to confirm or esc to go back'),
]

const HOOKS_VIEW: ScreenLine[] = [
  plain('  Hooks'),
  plain('  Lifecycle hooks from config and enabled plugins.'),
  plain(''),
  plain('  \u26a0 6 hooks need review before they can run.'),
  plain(''),
  plain('  Event                 Installed   Active      Review      Description'),
  plain('  SessionStart          1           0           1           When a new session starts'),
  plain(''),
  plain('  Press t to trust all; enter to review hooks; esc to close'),
]

const ONE_HOOK: ScreenLine[] = [
  plain('  PreToolUse hooks'),
  plain('  1 hook needs review before it can run.'),
  plain(''),
  plain('  [!] Hook 1 \u00b7 new'),
  plain('  Press t to trust; esc to go back'),
]

describe('Codex\'s hook review screens are blocking (P3.10)', () => {
  it('the start-up review, the /hooks view and one hook\'s review read as blocked; nothing is typed into them', () => {
    for (const [name, lines] of [['review', REVIEW], ['view', HOOKS_VIEW], ['one hook', ONE_HOOK]] as const) {
      expect(readCodexScreen(lines).screen, name).toBe('blocked')
      expect(sharedRead(lines).screen, name).toBe('blocked')
      expect(codexComposerState(lines), name).toBe('not-ready')
    }
  })
})
