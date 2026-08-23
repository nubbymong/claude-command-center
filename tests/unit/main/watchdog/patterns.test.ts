import { describe, it, expect } from 'vitest'
import {
  stripAnsi,
  canSendNow,
  isRateLimited,
  findRateLimitMessage,
  isRateLimitOptionsPrompt,
  menuStepsToWaitOption,
  detectOverload,
  overloadMatch,
  detectSafeguard,
  safeguardMatch,
  isWorking,
  isInternalRetry,
  resumedAfterLimit,
} from '../../../../src/main/watchdog/patterns'

// Mirrors upstream claude-auto-retry's DEFAULT_OVERLOAD.patterns / DEFAULT_SAFEGUARD.patterns
// (config.js) — colon-form only, so the transient parens-retry form never matches.
const OVERLOAD_PATTERNS = ['API Error:\\s*(429|500|502|503|504|529)\\b', 'overloaded_error', 'temporarily limiting requests']
const SAFEGUARD_PATTERNS = ["safeguards flagged this message", "can't respond to this request with", 'legal/aup']

const TAIL = 12 // matches upstream's RATE_LIMIT_TAIL_LINES usage in the tool-echo suite

describe('stripAnsi', () => {
  it('removes bold/color/cursor CSI codes', () => {
    expect(stripAnsi('\x1b[1mlimit\x1b[0m')).toBe('limit')
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('\x1b[2Jhello\x1b[H')).toBe('hello')
  })
  it('leaves plain text unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text')
  })
  it('strips private-mode sequences (cursor hide, bracketed paste)', () => {
    expect(stripAnsi('\x1b[?25lhello\x1b[?25h')).toBe('hello')
    expect(stripAnsi('\x1b[?2004htext\x1b[?2004l')).toBe('text')
  })
  it('strips OSC hyperlinks and window titles', () => {
    expect(stripAnsi('\x1b]8;;https://example.com\x1b\\click here\x1b]8;;\x1b\\')).toBe('click here')
    expect(stripAnsi('\x1b]0;My Terminal\x07hello')).toBe('hello')
  })
  it('strips OSC + CSI mixed sequences, preserving rate-limit detection', () => {
    const input = '\x1b]8;;link\x1b\\5-hour limit reached\x1b]8;;\x1b\\ - resets 3pm'
    expect(isRateLimited(input)).toBe(true)
  })
})

describe('isRateLimited — basic banner + reset proximity', () => {
  it('detects "5-hour limit reached" with a reset nearby', () => {
    expect(isRateLimited('5-hour limit reached - resets 3pm')).toBe(true)
  })
  it('detects "You\'ve hit your session limit" (current wording)', () => {
    expect(isRateLimited("You've hit your session limit · resets 4:50pm (Asia/Shanghai)")).toBe(true)
  })
  it('returns false for normal output', () => {
    expect(isRateLimited('I can help you with that code')).toBe(false)
  })
  it('returns false for empty string', () => {
    expect(isRateLimited('')).toBe(false)
  })
  it('does NOT fire on limit text with no reset line nearby (>6 lines apart)', () => {
    expect(isRateLimited('hit your limit\n1\n2\n3\n4\n5\n6\n7\nresets 3pm')).toBe(false)
  })
  it('does NOT fire on limit text with no reset line at all', () => {
    expect(isRateLimited('rate limit information: see docs for details')).toBe(false)
  })
  it('matches custom patterns', () => {
    expect(isRateLimited('custom error xyz', [/custom error/i])).toBe(true)
  })
  it('full scan (tailLines=0, print mode) still detects a single-line banner', () => {
    expect(isRateLimited("You've hit your session limit · resets 3pm (UTC)", [], 0)).toBe(true)
  })
})

describe('isRateLimited — tool-echo masking (#63)', () => {
  const CHROME = [
    '╭──────────────────────────╮',
    '│ >                        │',
    '╰──────────────────────────╯',
    '  ⏵⏵ auto mode on',
    '~/project | opus 4.8 | 47k/200k | v2.1.214',
  ]

  it('does NOT trigger on banner text quoted inside a ● Bash(...) render', () => {
    const pane = [
      '● Bash(grep -c "5-hour limit reached - resets 3pm (UTC)" ~/logs/2026-07-18.log)',
      '  ⎿  3',
      ...CHROME,
    ].join('\n')
    expect(isRateLimited(pane, [], TAIL)).toBe(false)
    expect(findRateLimitMessage(pane)).toBeNull()
  })

  it('control: the same text unquoted at the prompt IS detected', () => {
    const pane = ['5-hour limit reached - resets 3pm (UTC)', ...CHROME].join('\n')
    expect(isRateLimited(pane, [], TAIL)).toBe(true)
    expect(findRateLimitMessage(pane)).toMatch(/resets 3pm/)
  })

  it('a real banner above a small tool render is still detected', () => {
    const pane = [
      "You've hit your session limit · resets 2:10am (Australia/Melbourne)",
      '● Bash(date)',
      '  ⎿  Fri Jul 18',
      ...CHROME,
    ].join('\n')
    expect(isRateLimited(pane, [], TAIL)).toBe(true)
  })

  it('does NOT match quoted overload text in a Bash() line', () => {
    const pane = ['● Bash(grep "API Error: 529 overloaded_error" ~/logs/x.log)', '  ⎿  2', ...CHROME].join('\n')
    expect(detectOverload(pane, OVERLOAD_PATTERNS)).toBe(false)
  })

  it('keeps a tool block masked across a blank line inside it (fix #2)', () => {
    // A spacer row inside the result block must NOT un-mask the quoted error text
    // that follows it — that reset inBlock and read the quote as a live banner.
    const pane = [
      '● Bash(cat ~/logs/x.log)',
      '  ⎿  matched:',
      '',
      '     API Error: 529 overloaded_error',
      ...CHROME,
    ].join('\n')
    expect(detectOverload(pane, OVERLOAD_PATTERNS)).toBe(false)
  })

  it('still detects the same text as a real live banner (not over-masked, fix #2 guard)', () => {
    const pane = ['thinking…', 'API Error: 529 overloaded_error', ...CHROME].join('\n')
    expect(detectOverload(pane, OVERLOAD_PATTERNS)).toBe(true)
  })

  it('does NOT match quoted safeguard text in a Bash() line', () => {
    const pane = [
      '● Bash(grep "safeguards flagged this message" session.log)',
      '  ⎿  API Error: safeguards flagged this message (legal/aup)',
      ...CHROME,
    ].join('\n')
    expect(safeguardMatch(pane, ['safeguards flagged this message'])).toBeNull()
  })

  it('does NOT fire on a tool result taller than the tail window (header outside it)', () => {
    const logLine = (t: string) =>
      `     [2026-07-18 ${t}] Rate limit detected: "5-hour limit reached - resets 3pm (UTC)". Waiting 12600s...`
    const tallToolResult = [
      '● Bash(grep "limit" ~/logs/2026-07-18.log)',
      '  ⎿  [2026-07-18 09:58:01] Monitor started',
      logLine('10:29:37'),
      logLine('11:31:12'),
      logLine('12:33:40'),
      logLine('13:35:02'),
      logLine('14:41:55'),
      logLine('15:44:10'),
      logLine('16:29:37'),
      logLine('16:31:12'),
    ]
    const pane = [...tallToolResult, '', '❯ '].join('\n')
    expect(isRateLimited(pane, [], TAIL)).toBe(false)
  })
})

describe('isRateLimited — chrome-aware tail vs live footer', () => {
  const widget = [
    '  8 tasks (4 done, 1 in progress, 3 open)',
    '  □ a',
    '  □ b',
    '  □ c',
    '  □ d',
    '  □ e',
    '  □ f',
    '  □ g',
    '   … +3 completed',
    '  new task? /clear to save 300k tokens',
  ]
  const banner = "You've hit your session limit · resets 3pm (UTC)"

  it('finds a banner buried behind a task widget + bare input box (tail=12)', () => {
    const bare = ['───────', '❯ ', '───────', '  ⏵⏵ auto mode on']
    expect(isRateLimited([banner, ...widget, ...bare].join('\n'), [], 12)).toBe(true)
  })

  it('finds a banner behind a widget above a BOXED input "│ > │" (tail=12)', () => {
    const boxed = ['╭────────────────────────╮', '│ >                      │', '╰────────────────────────╯', '  ? for shortcuts']
    expect(isRateLimited([banner, ...widget, ...boxed].join('\n'), [], 12)).toBe(true)
  })

  it('does NOT strip a psql unicode-border table, so a stale banner above it stays out', () => {
    const table = [
      '  ⎿  ┌────────┬───────────┐',
      '     │ id     │ name      │',
      '     ├────────┼───────────┤',
      ...Array(10).fill('     │ 0      │ user0     │'),
      '     └────────┴───────────┘',
    ]
    const pane = [banner, '● Bash(psql -c "select * from users limit 8")', ...table, '❯ '].join('\n')
    expect(isRateLimited(pane, [], 12)).toBe(false)
  })

  it('a genuine footer/mode line is chrome — banner behind it is still reachable', () => {
    const pane = [
      "You've hit your session limit · resets 2am (Europe/Zurich)",
      '───────────────────────────────',
      '❯ ',
      '───────────────────────────────',
      '  Opus 4.8 1M | repo@dev | 5h 100% @02:00 | v2.1.201',
      '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
    ].join('\n')
    expect(isRateLimited(pane, [], 12)).toBe(true)
  })

  it('a LIVE footer ("esc to interrupt") is content, not chrome, and does NOT get stripped away', () => {
    // isWorking must see it even behind a tall chrome stack (proves the footer itself
    // is excluded from CHROME_LINE).
    const pane = [
      '✻ Cogitating… (12s · esc to interrupt)',
      '  10 tasks (2 done, 1 in progress, 7 open)',
      '  □ a',
      '  □ b',
      '  □ c',
      '  □ d',
      '  □ e',
      '  □ f',
      '  □ g',
      '   … +2 completed',
      '  new task? /clear to save 300k tokens',
      '',
      '───────────────',
      '❯ ',
      '───────────────',
      '  Opus 4.8 | repo@dev | v2.1.201',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ].join('\n')
    expect(isWorking(pane)).toBe(true)
  })

  it('a live "Retrying in" footer is content, not chrome — isRateLimited scan still reaches it', () => {
    // Not chrome means it counts against tail budget like any content line; the point is
    // WORKING_PATTERNS exemption keeps it out of CHROME_LINE so isWorking/isRateLimited
    // share the same bottom.
    const pane = 'API Error: 529 Overloaded · Retrying in 5s · attempt 3/10'
    expect(isWorking(pane)).toBe(true)
    expect(isInternalRetry(pane)).toBe(true)
  })
})

describe('findRateLimitMessage', () => {
  it('returns the matching line from multiline input', () => {
    const text = 'Some output\n5-hour limit reached - resets 3pm (Europe/Dublin)\nMore output'
    expect(findRateLimitMessage(text)).toBe('5-hour limit reached - resets 3pm (Europe/Dublin)')
  })
  it('returns null when no match', () => {
    expect(findRateLimitMessage('normal output\nmore output')).toBeNull()
  })
  it('returns the most recent resets line when scrollback has a stale one (bottom-up scan)', () => {
    const text = "You've hit your limit · resets 11:30am (UTC)\nlots of output\nYou've hit your limit · resets 4:30pm (UTC)"
    expect(findRateLimitMessage(text)).toMatch(/4:30pm/)
  })
  it('a fresh quoted line does not steal the message from a real banner (skips masked lines)', () => {
    const CHROME = ['╭──╮', '│ > │', '╰──╯']
    const pane = [
      "You've hit your session limit · resets 2:10am (Australia/Melbourne)",
      '● Bash(grep "old limit - resets 9am (UTC)" log.txt)',
      '  ⎿  1',
      ...CHROME,
    ].join('\n')
    expect(findRateLimitMessage(pane)).toMatch(/resets 2:10am/)
  })
})

describe('overload detection — colon-form vs parens-form anchor', () => {
  it('matches colon-form "API Error: 529"', () => {
    expect(detectOverload('API Error: 529 Overloaded', OVERLOAD_PATTERNS)).toBe(true)
  })
  it('does NOT match the transient parens-retry form', () => {
    expect(detectOverload('API Error (529 {"type":"error"}) · Retrying in 5s · attempt 3/10', OVERLOAD_PATTERNS)).toBe(false)
  })
  it('does NOT match a bare status number with no API Error frame', () => {
    expect(detectOverload('got a 529 back', OVERLOAD_PATTERNS)).toBe(false)
    expect(detectOverload('500 Internal server error · try again', OVERLOAD_PATTERNS)).toBe(false)
  })
  it('does NOT match phrase patterns merely quoted in prose (no API Error nearby)', () => {
    expect(detectOverload('the "temporarily limiting requests" pattern is a built-in signal', OVERLOAD_PATTERNS)).toBe(false)
  })
  it('reports the matched pattern and offending line via overloadMatch', () => {
    const m = overloadMatch('thinking…\nAPI Error: 529 Overloaded', OVERLOAD_PATTERNS)
    expect(m).not.toBeNull()
    expect(m!.line).toBe('API Error: 529 Overloaded')
  })
})

describe('overload detection — raw-line cap prevents reaching a stale error behind tall chrome', () => {
  it('does NOT match an API error buried >20 raw lines up behind a tall chrome widget', () => {
    const pane = [
      'API Error: 529 Overloaded',
      '  20 tasks (0 done, 20 open)',
      ...Array(22).fill('  □ pending task'),
      '───────────────',
      '❯ ',
    ].join('\n')
    expect(detectOverload(pane, OVERLOAD_PATTERNS)).toBe(false)
  })
  it('still matches a terminal API error just above the input box', () => {
    const pane = ['API Error: 529 Overloaded', '───────────────', '❯ ', '───────────────', '  ⏵⏵ auto mode on'].join('\n')
    expect(detectOverload(pane, OVERLOAD_PATTERNS)).toBe(true)
  })
})

describe('safeguard detection — requires a nearby API Error anchor', () => {
  const FLAG = [
    '❯ continue',
    '',
    "● API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). They may flag safe, normal content as well. Claude Code can't respond to this request with Fable 5.",
    '  Double press esc to edit your last message, or try a different model with /model.',
    '❯ ',
  ].join('\n')

  it('matches the safeguards-flagged render', () => {
    expect(detectSafeguard(FLAG, SAFEGUARD_PATTERNS)).toBe(true)
  })
  it('does NOT fire on the phrases without an API Error render nearby', () => {
    expect(detectSafeguard('see https://www.anthropic.com/legal/aup for the policy', SAFEGUARD_PATTERNS)).toBe(false)
    expect(detectSafeguard("Claude Code can't respond to this request with Opus 4.8.", SAFEGUARD_PATTERNS)).toBe(false)
  })
  it('does NOT fire on the phrase quoted far up in scrollback (tail-anchored)', () => {
    const pane = ['discussing safeguards flagged this message', ...Array(15).fill('● unrelated work'), '❯ '].join('\n')
    expect(detectSafeguard(pane, SAFEGUARD_PATTERNS)).toBe(false)
  })
  it('reports the matched pattern + line via safeguardMatch', () => {
    const m = safeguardMatch(FLAG, SAFEGUARD_PATTERNS)
    expect(m).not.toBeNull()
    expect(m!.pattern).toMatch(/safeguards flagged/)
    expect(m!.line.length).toBeLessThanOrEqual(200)
  })
})

describe('isWorking / isInternalRetry', () => {
  it('detects the working footer', () => {
    expect(isWorking('Cogitating… (esc to interrupt)')).toBe(true)
  })
  it('returns false at an idle prompt', () => {
    expect(isWorking('│ > ')).toBe(false)
  })
  it('treats "Retrying in"/"attempt n/m" as still-working AND as an internal retry', () => {
    expect(isWorking('API Error: 529 Overloaded · Retrying in 5s · attempt 3/10')).toBe(true)
    expect(isInternalRetry('API Error: 529 Overloaded · Retrying in 5s · attempt 3/10')).toBe(true)
  })
  it('does not treat the idle "✻ Brewed for …" spinner as working or internal-retry', () => {
    expect(isWorking('✻ Brewed for 54m 35s\n❯ ')).toBe(false)
    expect(isInternalRetry('✻ Brewed for 54m 35s\n❯ ')).toBe(false)
  })
  it('does not treat a lingering "Backgrounded agent" transcript notice as working', () => {
    const pane = [
      '● Task(build the parser)',
      '  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)',
      '● Done. The parser passes all 14 tests.',
      "You've hit your session limit · resets 3pm (Europe/Zurich)",
      '❯ ',
    ].join('\n')
    expect(isWorking(pane)).toBe(false)
  })
})

describe('resumedAfterLimit — order-sensitive', () => {
  it('working text ABOVE the banner is history, not a resume', () => {
    const pane = ['✻ Cogitating… (esc to interrupt)', "You've hit your session limit · resets 3pm (UTC)", '❯ '].join('\n')
    expect(resumedAfterLimit(pane)).toBe(false)
  })
  it('working/content text BELOW the banner counts as resumed', () => {
    const pane = ["You've hit your session limit · resets 3pm (UTC)", '● wrote some code', '✻ Cogitating… (esc to interrupt)'].join(
      '\n',
    )
    expect(resumedAfterLimit(pane)).toBe(true)
  })
  it('falls back to plain isWorking when no banner is in the window', () => {
    expect(resumedAfterLimit('✻ Cogitating… (esc to interrupt)')).toBe(true)
    expect(resumedAfterLimit('❯ ')).toBe(false)
  })
})

describe('interactive rate-limit-options menu', () => {
  const MENU_UPGRADE_FIRST = [
    "You've hit your session limit · resets 6:50pm (Europe/London)",
    '/rate-limit-options',
    'What do you want to do?',
    '❯ 1. Upgrade your plan',
    '  2. Stop and wait for limit to reset',
    'Enter to confirm · Esc to cancel',
  ].join('\n')
  const MENU_WAIT_FIRST = [
    "You've hit your session limit · resets 12:10am (Europe/Dublin)",
    'What do you want to do?',
    '❯ 1. Stop and wait for limit to reset',
    '  2. Upgrade your plan',
    'Enter to confirm · Esc to cancel',
  ].join('\n')

  it('detects the menu regardless of which option is highlighted', () => {
    expect(isRateLimitOptionsPrompt(MENU_UPGRADE_FIRST)).toBe(true)
    expect(isRateLimitOptionsPrompt(MENU_WAIT_FIRST)).toBe(true)
  })
  it('returns false for a plain rate-limit banner with no menu', () => {
    expect(isRateLimitOptionsPrompt("You've hit your limit · resets 3pm (UTC)")).toBe(false)
  })
  it('returns false for normal output containing the question in prose', () => {
    expect(isRateLimitOptionsPrompt('What do you want to do? Build a feature?')).toBe(false)
  })

  it('counts +1 down when "Stop and wait" is one below the cursor', () => {
    expect(menuStepsToWaitOption(MENU_UPGRADE_FIRST)).toBe(1)
  })
  it('counts 0 when "Stop and wait" is already highlighted', () => {
    expect(menuStepsToWaitOption(MENU_WAIT_FIRST)).toBe(0)
  })
  it('counts -1 when "Stop and wait" is above the cursor', () => {
    const text = ['What do you want to do?', '  1. Stop and wait for limit to reset', '❯ 2. Upgrade your plan'].join('\n')
    expect(menuStepsToWaitOption(text)).toBe(-1)
  })
  it('returns null when unreadable: no cursor to anchor on', () => {
    const text = ['What do you want to do?', '  1. Upgrade your plan', '  2. Stop and wait for limit to reset'].join('\n')
    expect(menuStepsToWaitOption(text)).toBeNull()
  })
  it('returns null when unreadable: no menu options present at all', () => {
    expect(menuStepsToWaitOption('just some text')).toBeNull()
  })

  it('a live menu pushed up by a widget below it is still detected (chrome-aware, tail-scoped)', () => {
    const MENU_BEHIND_WIDGET = [
      'What do you want to do?',
      '❯ 1. Upgrade your plan',
      '  2. Stop and wait for limit to reset',
      'Enter to confirm · Esc to cancel',
      '',
      '  8 tasks (2 done, 6 open)',
      '  □ a',
      '  □ b',
      '  □ c',
      '  □ d',
      '───────────────',
      '❯ ',
      '───────────────',
      '  ⏵⏵ auto mode on',
    ].join('\n')
    expect(isRateLimitOptionsPrompt(MENU_BEHIND_WIDGET, 6)).toBe(true)
    expect(menuStepsToWaitOption(MENU_BEHIND_WIDGET, 6)).toBe(1)
  })
  it('ignores a menu only quoted above live work (tail-scoped)', () => {
    const pane = [...MENU_UPGRADE_FIRST.split('\n'), ...Array(10).fill('● unrelated work'), '❯ '].join('\n')
    expect(isRateLimitOptionsPrompt(pane, 6)).toBe(false)
  })
})

describe('canSendNow (#266 BLOCKER-2 / MAJOR-3) — the send gate, against REAL render shapes', () => {
  // Claude Code's real input is a top rule, `❯ …`, a bottom rule, then a footer
  // — NO `│` gutters (#266 review, F1: the earlier fixtures used the repo's own
  // mock shape and the gate was inert against real output). The EMPTY prompt is
  // `❯ ` with nothing after the caret; a DRAFT is `❯ <text>`. A footer sits
  // below the bottom rule, so the caret row is NEVER the last line.
  const RULE = '─────────────────────────────────────────'
  const FOOTER = '  ⏵⏵ accept edits on (shift+tab to cycle) · ? for shortcuts'
  const BANNER = 'Claude usage limit reached. Your limit resets at 4:30pm.'

  it('the normal retry posture — empty prompt under a live banner — is sendable', () => {
    const tail = [BANNER, RULE, '❯ ', RULE, FOOTER].join('\n')
    expect(canSendNow(tail)).toEqual({ ok: true })
  })

  it('F1: refuses a REAL filled input (caret above the bottom rule + footer, not the last line)', () => {
    const tail = [BANNER, RULE, '❯ fix the failing auth test first', RULE, FOOTER].join('\n')
    expect(canSendNow(tail)).toEqual({ ok: false, reason: 'draft' })
  })

  it('F1: refuses a draft even with a task widget between the caret and the bottom of the pane', () => {
    const tail = [
      BANNER,
      RULE,
      '❯ keep going with the migration',
      RULE,
      '  8 tasks (2 done, 6 open)',
      '  □ a', '  □ b', '  □ c',
      FOOTER,
    ].join('\n')
    expect(canSendNow(tail)).toEqual({ ok: false, reason: 'draft' })
  })

  it('F2: refuses an UNNUMBERED caret picker (Enter would confirm its focused row)', () => {
    // A single focused caret row is ambiguous between a filled input and a
    // one-option picker focus; the SECURITY property is that it gates, not the
    // cosmetic reason. Two caret rows resolve to 'menu' explicitly.
    const oneRow = ['Review the proposed auto-mode setup?', '❯ Looks good — save it', RULE].join('\n')
    expect(canSendNow(oneRow).ok).toBe(false)

    const twoRows = [
      'Review the proposed auto-mode setup?',
      '❯ Looks good — save it',
      '❯ Let me adjust the arguments first',
      RULE,
    ].join('\n')
    expect(canSendNow(twoRows)).toEqual({ ok: false, reason: 'menu' })
  })

  it('refuses a numbered permission menu (a "1. Yes" would be auto-approved)', () => {
    const tail = [
      'Do you want to run this command?',
      '  npm run deploy',
      '',
      '❯ 1. Yes',
      "  2. Yes, and don't ask again",
      '  3. No (esc)',
    ].join('\n')
    expect(canSendNow(tail)).toEqual({ ok: false, reason: 'menu' })
  })

  it('refuses the /rate-limit-options menu shape', () => {
    const tail = [
      "You've hit your session limit · resets 4:30pm (Europe/London)",
      '/rate-limit-options',
      'What do you want to do?',
      '❯ 1. Upgrade your plan',
      '  2. Stop and wait for limit to reset',
      'Enter to confirm · Esc to cancel',
    ].join('\n')
    expect(canSendNow(tail)).toEqual({ ok: false, reason: 'menu' })
  })

  it('belt-and-braces: refuses a boxed input row carrying a draft (mock/gutter render)', () => {
    const tail = [
      BANNER,
      '╭──────────────────────────────╮',
      '│ > fix the failing test first │',
      '╰──────────────────────────────╯',
      FOOTER,
    ].join('\n')
    expect(canSendNow(tail)).toEqual({ ok: false, reason: 'draft' })
  })

  it('does not read a markdown blockquote (ASCII >) as a draft — the fancy caret is the input, not >', () => {
    const tail = [
      'The reviewer wrote:',
      '> the fix looks right to me',
      BANNER,
      RULE, '❯ ', RULE, FOOTER,
    ].join('\n')
    expect(canSendNow(tail)).toEqual({ ok: true })
  })

  it('does not read one numbered list item in prose as a menu', () => {
    const tail = [
      'Plan:',
      '1. Refactor the parser first',
      'then everything else as discussed.',
      BANNER, RULE, '❯ ', RULE,
    ].join('\n')
    expect(canSendNow(tail)).toEqual({ ok: true })
  })

  it('a menu quoted in old scrollback does not gate — only the live window counts', () => {
    const menuFarUp = [
      '❯ 1. Yes',
      '  2. No',
      ...Array.from({ length: 30 }, (_, i) => `output line ${i}`),
      BANNER, RULE, '❯ ', RULE,
    ].join('\n')
    expect(canSendNow(menuFarUp)).toEqual({ ok: true })
  })

  it('a bare ASCII prompt draft as the last line refuses; the same text higher up does not', () => {
    expect(canSendNow('banner\n> half-typed thought')).toEqual({ ok: false, reason: 'draft' })
    expect(canSendNow(`> quoted earlier\n${BANNER}`)).toEqual({ ok: true })
  })

  // --- #418: the styled read. Claude Code renders placeholder text in an
  // EMPTY input dim; the second argument is the same pane with every dim cell
  // blanked. A caret row is a draft only if NON-DIM ink follows the caret.
  describe('#418 dim placeholders', () => {
    it('every real placeholder shape is the sendable empty prompt — and still defers without the styled read', () => {
      const placeholders = [
        'Press up to edit queued messages',
        'Message @reviewer…',
        'Comment on 4 selected lines…',
        'Try "fix lint errors"', // the model-generated prompt suggestion
      ]
      for (const ph of placeholders) {
        const raw = [BANNER, RULE, `❯ ${ph}`, RULE, FOOTER].join('\n')
        const nonDim = [BANNER, RULE, '❯ ', RULE, FOOTER].join('\n')
        expect(canSendNow(raw, nonDim), ph).toEqual({ ok: true })
        // Text-only reading keeps the old fail-closed posture.
        expect(canSendNow(raw).ok, `${ph} (no styled read)`).toBe(false)
      }
    })

    it('a real draft carries non-dim ink and still gates', () => {
      const raw = [BANNER, RULE, '❯ fix the failing auth test first', RULE, FOOTER].join('\n')
      expect(canSendNow(raw, raw)).toEqual({ ok: false, reason: 'draft' })
    })

    it('part-typed text with a trailing dim hint gates — any non-dim ink is a draft', () => {
      const raw = [BANNER, RULE, '❯ fix the (tab to accept)', RULE, FOOTER].join('\n')
      const nonDim = [BANNER, RULE, '❯ fix the', RULE, FOOTER].join('\n')
      expect(canSendNow(raw, nonDim)).toEqual({ ok: false, reason: 'draft' })
    })

    it('a styled read that does not align line-for-line is IGNORED (fail closed)', () => {
      const raw = [BANNER, RULE, '❯ Press up to edit queued messages', RULE, FOOTER].join('\n')
      const misaligned = [BANNER, RULE, '❯ '].join('\n')
      expect(canSendNow(raw, misaligned)).toEqual({ ok: false, reason: 'draft' })
    })

    it('menu detection stays on the RAW text — dim unfocused rows still count', () => {
      const raw = [
        'Do you want to run this command?',
        '❯ 1. Yes',
        "  2. Yes, and don't ask again",
        '  3. No (esc)',
      ].join('\n')
      // A selector may render its unfocused rows dim; blanking them must not
      // let the menu collapse to a sendable pane.
      const nonDim = ['Do you want to run this command?', '❯ 1. Yes', '', ''].join('\n')
      expect(canSendNow(raw, nonDim)).toEqual({ ok: false, reason: 'menu' })
    })

    it('an unnumbered picker (focused row is not dim) still gates with the styled read', () => {
      const raw = ['Review the proposed auto-mode setup?', '❯ Looks good — save it', RULE].join('\n')
      expect(canSendNow(raw, raw).ok).toBe(false)
    })

    it('a DIM PROMPT GLYPH over a live type-ahead draft still gates (the glyph dims while loading)', () => {
      // claude.exe dims the pointer whenever isLoading — the ink check must be
      // by column after the glyph found in the RAW row, never a masked
      // re-match of the whole shape (which the blanked glyph would fail,
      // flipping refuse to SEND).
      const raw = [BANNER, RULE, '❯ fix the failing auth test', RULE, FOOTER].join('\n')
      const nonDim = [BANNER, RULE, '  fix the failing auth test', RULE, FOOTER].join('\n')
      expect(canSendNow(raw, nonDim)).toEqual({ ok: false, reason: 'draft' })
    })

    it('DIM box borders around a non-dim draft still gate', () => {
      const raw = [BANNER, '╭────────────────────────╮', '│ > fix the failing test │', '╰────────────────────────╯', FOOTER].join('\n')
      const nonDim = [BANNER, '', '    fix the failing test', '', FOOTER].join('\n')
      expect(canSendNow(raw, nonDim)).toEqual({ ok: false, reason: 'draft' })
    })

    it('a DIM bare ASCII glyph over a draft as the last line still gates', () => {
      expect(canSendNow('banner\n> half-typed thought', 'banner\n  half-typed thought')).toEqual({
        ok: false,
        reason: 'draft',
      })
    })

    it('a dim placeholder behind the BARE prompt is sendable', () => {
      const ph = 'Press up to edit queued messages'
      expect(canSendNow(`banner\n> ${ph}`, `banner\n> ${' '.repeat(ph.length)}`)).toEqual({ ok: true })
    })

    it('pins the glyph locator column: a one-character draft right after the caret still gates', () => {
      // The locator is /^\s*❯/ — start = the column AFTER the glyph. If it
      // drifted to include the first non-space (the full shape regex), the
      // ink check would start past 'x' and send over a real draft.
      const raw = [BANNER, RULE, '❯ x', RULE, FOOTER].join('\n')
      expect(canSendNow(raw, raw)).toEqual({ ok: false, reason: 'draft' })
    })

    it('an ALL-DIM unnumbered picker still reads as a menu — raw caret rows count', () => {
      const raw = [
        'Review the proposed auto-mode setup?',
        '❯ Looks good — save it',
        '❯ Let me adjust the arguments first',
        RULE,
      ].join('\n')
      const nonDim = ['Review the proposed auto-mode setup?', '', '', RULE].join('\n')
      expect(canSendNow(raw, nonDim)).toEqual({ ok: false, reason: 'menu' })
    })

    it('a dim placeholder in the BOXED render is sendable too; a boxed draft is not', () => {
      const ph = 'Press up to edit queued messages'
      const box = (inner: string) => [BANNER, '╭──────────────────────────────╮', `│ > ${inner} │`, '╰──────────────────────────────╯', FOOTER]
      const raw = box(ph).join('\n')
      // Column-faithful mask: the dim placeholder blanks to spaces IN PLACE,
      // so the closing gutter stays at the same column as the raw row.
      const nonDim = box(' '.repeat(ph.length)).join('\n')
      expect(canSendNow(raw, nonDim)).toEqual({ ok: true })
      const draft = box('fix the failing test').join('\n')
      expect(canSendNow(draft, draft)).toEqual({ ok: false, reason: 'draft' })
    })
  })
})
