/**
 * Codex's first-launch screens, as the real-launch spec reads them
 * (tests/e2e/codex-real-launch.spec.ts; P4.9, row 67), by the rules the
 * 2026-10-02 VM incident left (completion plan 9.2). PURE: a terminal's rows
 * in, a decision out. tests/wp1/mode-matrix.test.ts checks it on screen text
 * rendered from the 9.2 probe captures of the real CLI.
 *
 * Codex draws in an inline viewport, so a menu it has answered can leave its
 * last frame on screen above the live one (rendered at 160 x 38 the probe
 * captures show each answered menu replaced in place; a smaller pane need
 * not). So:
 *   - the live screen is the one whose title is LOWEST on screen, and its
 *     menu is the rows from that title down;
 *   - the selected row is the LAST row with the selection mark and an option
 *     number, and Enter may confirm only when that row lies in the live menu
 *     and is the one option the spec answers (never option 1 of the sandbox
 *     menu, the administrator set-up: the owner's, OR6);
 *   - each screen is answered once (the probes show one of each; a second one
 *     would need its own option text), and nothing is answered while the
 *     screen is unchanged since the last answer;
 *   - ready (9.2): no prompt on screen, Codex's footer on the last line, and
 *     the composer above it showing its placeholder. During the sandbox
 *     set-up the composer reads "Input disabled until setup completes." over
 *     the same footer, so the footer alone is not enough.
 */

export type FirstScreen = 'sandbox' | 'hooks' | 'trust'

export interface FirstScreenRule {
  /** How the screen's title reads on both versions (9.2 PB4; P3.10). */
  title: RegExp
  /** The one option the spec confirms, as its selected row reads. */
  answer: RegExp
  /** That option, for a refusal's message. */
  option: string
  /** The keys that move the selection to it (never Enter). */
  keys: readonly string[]
}

export const FIRST_SCREENS: Readonly<Record<FirstScreen, FirstScreenRule>> = {
  // A digit only moves the selection in this menu, and Enter confirms (PB4).
  sandbox: { title: /Set up the Codex agent sandbox/i, answer: /^\s*\u203A\s*2\.\s*Use non-admin sandbox/, option: '2. Use non-admin sandbox', keys: ['2'] },
  // Option 3 leaves the hooks untrusted, so config.toml records no hook trust.
  hooks: { title: /Hooks need review/i, answer: /^\s*\u203A\s*3\.\s*Continue without trusting/, option: '3. Continue without trusting', keys: ['\x1b[B', '\x1b[B'] },
  // Option 1 is selected when the prompt opens (PB1, PB4).
  trust: { title: /Do you trust the contents/i, answer: /^\s*\u203A\s*1\.\s*Yes, continue/, option: '1. Yes, continue', keys: [] },
}

/** Any prompt text, a title or an option: none may be on screen when ready. */
const PROMPT_TEXT = /trust the contents|Do you trust|Yes, continue|No, quit|Set up default sandbox|Use non-admin sandbox|Set up the Codex agent sandbox|Hooks need review/i
const SELECTED = /^\s*\u203A\s*\d+\./
const PLACEHOLDER = /^\s*\u203A\s+(?:Ask Codex to do anything|Ask a follow-up question)\s*$/
/** Codex's footer: "<model> <effort> . <folder>" (src/shared/codex-screen.ts). */
const FOOTER = /^ {0,8}\S+ (?:none|minimal|low|medium|high|xhigh|max|ultra|default) \u00B7 \S/

/** The selected row of the menu on screen: the LAST row with the selection
 *  mark and an option number, '' when there is none. */
export function selectedRow(rows: readonly string[]): string {
  for (let i = rows.length - 1; i >= 0; i--) if (SELECTED.test(rows[i])) return rows[i]
  return ''
}

/** The live first screen: the one whose title is lowest on screen, its row,
 *  and its menu (the rows from the title down). Null when none is on screen. */
export function liveFirstScreen(rows: readonly string[]): { kind: FirstScreen; at: number; menu: string[] } | null {
  let live: { kind: FirstScreen; at: number } | null = null
  for (const kind of Object.keys(FIRST_SCREENS) as FirstScreen[]) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!FIRST_SCREENS[kind].title.test(rows[i])) continue
      if (!live || i > live.at) live = { kind, at: i }
      break
    }
  }
  return live ? { ...live, menu: rows.slice(live.at) } : null
}

/** A screen answered: which, and the screen Enter confirmed it on. */
export interface FirstScreenAnswer { kind: FirstScreen; screen: string }

/** What to do on this screen: answer its live first screen; wait (that
 *  screen was answered already, or nothing changed since the last answer);
 *  or nothing to answer (no first screen is on screen). */
export function nextFirstScreen(rows: readonly string[], answered: readonly FirstScreenAnswer[]): { act: 'answer'; kind: FirstScreen } | { act: 'wait'; why: string } | { act: 'none' } {
  const live = liveFirstScreen(rows)
  if (!live) return { act: 'none' }
  const last = answered[answered.length - 1]
  if (last && last.screen === rows.join('\n')) return { act: 'wait', why: 'the screen has not changed since the last answer' }
  if (answered.some((a) => a.kind === live.kind)) return { act: 'wait', why: `the live screen is the ${live.kind} screen, answered once already` }
  return { act: 'answer', kind: live.kind }
}

/** Whether Enter may confirm `kind` on this screen: it is the live screen,
 *  and the selected row of ITS menu is the option the spec answers. The row
 *  read is returned for a refusal's message. */
export function confirmable(rows: readonly string[], kind: FirstScreen): { ok: boolean; row: string; why?: string } {
  const live = liveFirstScreen(rows)
  if (!live || live.kind !== kind) return { ok: false, row: '', why: `the live screen is ${live ? `the ${live.kind} screen` : 'none of the first screens'}, not the ${kind} screen` }
  const row = selectedRow(live.menu)
  if (FIRST_SCREENS[kind].answer.test(row)) return { ok: true, row }
  return { ok: false, row, why: `"${FIRST_SCREENS[kind].option}" is not the selected row of the live menu` }
}

/** A ready composer (9.2): no prompt on screen, Codex's footer on the last
 *  line, and the composer above it showing its placeholder. */
export function composerReady(rows: readonly string[]): boolean {
  const shown = rows.filter((l) => l.trim() !== '')
  if (shown.some((l) => PROMPT_TEXT.test(l))) return false
  return shown.length >= 2 && FOOTER.test(shown[shown.length - 1]) && PLACEHOLDER.test(shown[shown.length - 2])
}
