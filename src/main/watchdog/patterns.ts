// Derived from claude-auto-retry (https://github.com/cheapestinference/claude-auto-retry), MIT License.
//
// Pattern-detection engine for the session watchdog. Pure functions only — no I/O, no
// Node APIs beyond string/regex. All detectors operate on a captured terminal pane
// (a plain string, possibly containing raw ANSI escape sequences) and return booleans
// or small plain-data results. Callers own polling, timers, and side effects.

// Full CSI sequence range per ECMA-48: parameter/intermediate bytes (0x20-0x3f) + final
// byte (0x40-0x7e). Covers standard, private-mode (\x1b[?25h), and extended sequences.
const CSI_REGEX = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g
// OSC sequences: \x1b] ... (terminated by BEL \x07 or ST \x1b\\)
// Covers hyperlinks (\x1b]8;;url\x1b\\), window titles (\x1b]0;title\x07), etc.
const OSC_REGEX = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g
// DCS sequences: \x1bP ... ST
const DCS_REGEX = /\x1bP[\s\S]*?(?:\x07|\x1b\\)/g
// APC, SOS, PM sequences: \x1b[_X^] ... ST
const OTHER_ESC_REGEX = /\x1b[_X^][\s\S]*?(?:\x07|\x1b\\)/g

export function stripAnsi(text: string): string {
  return text
    .replace(OSC_REGEX, '')
    .replace(DCS_REGEX, '')
    .replace(OTHER_ESC_REGEX, '')
    .replace(CSI_REGEX, '')
}

// The companion line Claude Code prints directly under a LIVE session/usage-limit banner
// ("… /usage-credits to finish what you're working on."). A distinctive UI string, so it
// doubles as furniture in the chrome allowlist and as the high-confidence live-limit
// backstop signal below — one source of truth for both.
const USAGE_CREDITS = /\/usage-credits\b/i

// Indicators that Claude is mid-flight and the pane is NOT in a terminal error state.
// Two kinds: the streaming footer, and Claude Code's OWN internal-retry indicator.
// While either is on screen the request's retries are not exhausted — acting now would
// interrupt Claude's backoff. Defined up here because isChromeLine excludes these lines
// (a live working footer must never be stripped as furniture) and isWorking scans for
// them; both need the predicate.
const WORKING_PATTERNS: RegExp[] = [
  /esc to interrupt/i, // the working/streaming footer ("… (esc to interrupt)")
  /\besc\b.*\binterrupt\b/i, // tolerate reordering/spacing in the same footer
  /Retrying in\b/i, // internal-retry suffix — retries not yet exhausted
  /\battempt\s+\d+\/\d+/i, // "attempt 3/10" companion to the retry suffix
  // The main thread is blocked awaiting a subagent — actively working, even though the
  // streaming footer isn't on this thread. LIVE-ONLY render (it disappears the moment the
  // agent finishes), so it's safe to treat as working: unlike the "Backgrounded agent"
  // transcript notice, it can't linger and pin isWorking on an idle, genuinely-limited pane.
  /waiting for \d+ background agents? to finish/i,
]
const isWorkingLine = (l: string): boolean => WORKING_PATTERNS.some((p) => p.test(l))

// --- Chrome-aware tail ---
// Claude Code renders UI chrome BELOW the meaningful content: the input box, the footer
// (model/usage/version), key hints, the todo/task widget, the status spinner
// ("✻ Brewed for …"), background-agent notices, and the "/usage-credits" hint. A live
// error/limit banner sits ABOVE this chrome, so when there's a lot of it — e.g. a tall
// task list — the banner is pushed well up the pane. A fixed last-N-lines tail then
// scrolls right past a genuine banner (observed: a session-limit banner ~16 lines up
// behind a task widget went undetected for ~54 min). Stripping trailing chrome first
// makes the tail measure distance-in-CONTENT, not raw lines — which also keeps the
// scrollback false-positive fixed (real work below a quoted banner is NOT chrome, so it
// isn't stripped and the stale banner stays out of the window).
//
// Each entry must be ANCHORED to how Claude Code actually renders the furniture — a
// full-line shape, leading indentation, or a footer position — not just "the line
// contains this glyph." The miss cost here is a false retry (stripping content lets a
// stale banner re-enter the window), so a loose glyph match (a bare "ctrl+", a stray
// arrow, any semver) is unacceptable.
const CHROME_LINE: RegExp[] = [
  /^\s*$/, // blank
  /^[\s─│╭╮╰╯┌┐└┘├┤┬┴┼▏▕|]+$/, // box-drawing / rules
  /^\s*│\s*[>❯][^│]*│\s*$/, // boxed input row ("│ > … │"): anchored to
  // the PROMPT GLYPH, not "anything between two
  // bars" — a bare │…│ rule matches unicode-
  // border tool output (psql/duf tables) and
  // would strip it as chrome, pulling a stale
  // banner back in. The glyph is the discriminator.
  /^\s*[❯>]\s*$/, // empty input prompt (bare, unboxed)
  /^\s*⏵⏵/, // mode footer ("⏵⏵ auto mode on…", "⏵⏵ accept edits…")
  /Allowed by auto mode/i, // "Allowed by auto mode" permission notice (anchored to
  // the full phrase — bare /auto mode/ matched prose like
  // "auto mode is enabled in your settings"; the footer
  // itself is already covered by /^\s*⏵⏵/ above)
  /shift\+tab to (?:cycle|select)/i, // tab-cycle footer hint (anchored to the phrase)
  /^\s*\?\s+for shortcuts\b/i, // "? for shortcuts" footer hint
  /\|\s*v\d+\.\d+\.\d+\b/, // footer version segment ("… | v2.1.201"), pipe-anchored
  /^\s+[□◻■◼▢▪◽◾✓✔☐☑]\s+\S/, // INDENTED todo/task items (leading ws required — a
  // flush-left "✓ Fixed the bug" summary is content)
  /^\s*\d+\s+tasks?\s+\(/i, // task widget header ("8 tasks (…)") — the "(" count is
  // required so prose ("3 tasks remain in the backlog")
  // isn't stripped
  /^\s*…\s*\+\d+\b/, // "… +N completed"
  /\/clear to save/i, // "new task? /clear to save …k tokens" — anchored to the
  // save hint; bare /new task\?/ matched prose questions
  // ("Should I start the new task?")
  USAGE_CREDITS, // live-limit companion hint (shared w/ the backstop)
  /^\s*[✻✢✽✳✴✶✷]\s/, // status spinner ("✻ Brewed for …")
  /Backgrounded agent \(|to manage · /i, // background-agent notice — the "(" (or "to manage ·")
  // is required so prose ("Backgrounded agent finished
  // the lint run") isn't stripped
]
// A live working footer ("✻ Cogitating… (esc to interrupt)") matches the spinner glyph
// pattern above, so it must be excluded explicitly — it is live content, never furniture.
const isChromeLine = (l: string): boolean => !isWorkingLine(l) && CHROME_LINE.some((r) => r.test(l))

export interface LineRange {
  start: number
  end: number
}

// Last `n` lines AFTER dropping trailing chrome, so a tall widget / input box below a
// banner doesn't consume the window budget. Operates on an array of already-split lines.
// maxRaw (optional) additionally caps how far above the FULL bottom the window may reach:
// with it set, a line further than maxRaw raw lines from the bottom is excluded even if
// chrome-stripping would otherwise expose it — bounding content-distance for the overload
// path, where a terminal error sits just above the input box and anything reachable only
// past a tall widget is stale scrollback, not a live error.
export function contentTailRange(lines: string[], n: number, maxRaw = Infinity): LineRange {
  let end = lines.length
  while (end > 0 && isChromeLine(lines[end - 1])) end--
  const start = Math.max(0, end - n, lines.length - maxRaw)
  return { start, end }
}

export function contentTail(lines: string[], n: number, maxRaw = Infinity): string[] {
  const { start, end } = contentTailRange(lines, n, maxRaw)
  return lines.slice(start, end)
}

// Claude Code renders rate limits across multiple lines in its TUI, e.g.:
//   "⚠ You've hit your limit"
//   "· resets 3pm (UTC)"
// Detection: find a "limit" line and a "resets" line within 6 lines of each other.

const LIMIT_PATTERNS: RegExp[] = [
  /(?:hit|exceeded|reached).*(?:your|the)\s*(?:[\w-]+\s+){0,3}limit/i, // "hit/exceeded/reached your [session|weekly|5-hour] limit"
  /\d+-hour limit/i, // "5-hour limit"
  /limit reached/i, // "limit reached"
  /usage limit/i, // "usage limit"
  /out of.*usage/i, // "out of extra usage"
  /rate limit/i, // "rate limit"
  /try again in/i, // "try again in X hours" (implies rate limiting)
]

const RESET_PATTERNS: RegExp[] = [
  /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i, // "resets 3pm" / "resets at 3:00 PM"
  /resets?\s+in[:\s]\s*\d/i, // "resets in: 3 hours"
  /try again in \d+\s*(?:hours?|minutes?|h|m)/i, // "try again in 5 hours"
]

const WINDOW = 6

function hasNearbyMatch(lines: string[], idx: number, patterns: RegExp[], mask: boolean[] | null = null): boolean {
  const start = Math.max(0, idx - WINDOW)
  const end = Math.min(lines.length, idx + WINDOW + 1)
  for (let j = start; j < end; j++) {
    if (mask && mask[j]) continue
    if (patterns.some((p) => p.test(lines[j]))) return true
  }
  return false
}

// --- Tool-call echo ---
// Error/limit text inside a tool-call render — a grep argument, a quoted log line in the
// result block — is text ABOUT an error, never the live state, yet it sits in the most
// recent content rows where the tail window rightly looks. Mask the `● Name(` header (the
// glyph alone doesn't discriminate — real API errors render `● API Error: …` too, but
// never as `Name(…)`) and the `⎿`/`└`/indented children UNDER such a header. Result
// markers must NOT mask on their own: a live banner interrupting a tool/agent call
// renders as a `└` child of a NON-`Name(` notice (`● Agent "…" finished` → `└ You've hit
// your session limit …` — an observed live incident this suite pins). The mask is always
// computed over the FULL pane and sliced to the detection window afterwards: a window that
// starts mid-block (tool result taller than the tail) must still know its leading lines
// are children of a header above the window. Known limits: a header wrapped (not
// truncated) across rows leaves its continuation unmasked, and "full pane" means the
// captured pane — a result block taller than the monitor's capture leaves its header
// outside the capture entirely, and the leading children are unmasked again.
const TOOL_ECHO_HEADER = /^\s*[●⏺∙]\s*\S+\(/ // "● Bash(grep …", "⏺ Read(file …"
const TOOL_ECHO_RESULT = /^\s*[⎿└]/ // "  ⎿  3"

export function toolEchoMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false)
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (TOOL_ECHO_HEADER.test(l)) {
      inBlock = true
      mask[i] = true
      continue
    }
    if (inBlock) {
      // A blank / whitespace-only line does NOT end a tool block — result blocks
      // contain empty rows, and treating one as a terminator un-masked the quoted
      // error text that followed it (a `● Tool(…)` render with `API Error: 529` a
      // couple of lines down, after a spacer, then read as a live banner → false
      // retry). Keep the block LATCHED across blanks and mask them.
      if (l.trim() === '') { mask[i] = true; continue }
      // Result markers (⎿ └) and indented continuation lines are children of the
      // block.
      if (TOOL_ECHO_RESULT.test(l) || /^\s/.test(l)) { mask[i] = true; continue }
      // Only a non-empty, flush-left line that is NOT a result marker ends the
      // block — it is content in its own right (and stays UNmasked), which also
      // preserves the live-banner-as-child case: a `└ You've hit …` under a
      // non-`Name(` notice never set inBlock, so it is never reached here.
      inBlock = false
    }
  }
  return mask
}

// tailLines > 0 restricts detection to the last N lines of the pane. A live usage-limit
// banner sits at the prompt (the last thing printed); the same words quoted in scrollback
// — a conversation discussing limits, a stale banner the session already moved past — are
// NOT the current state and must not drive a retry. 0 = scan everything (print mode, where
// the input is captured process output, not a scrolling TUI). The USAGE_CREDITS companion
// (defined above) backstops a banner buried behind a widget the chrome allowlist doesn't
// recognize — trusted only when it sits in the live region (nothing but chrome below it).
export function isRateLimited(text: string, customPatterns: Array<string | RegExp> = [], tailLines = 0): boolean {
  const all = stripAnsi(text).split('\n')
  // Chrome-aware window: trailing UI furniture doesn't consume the tail budget.
  // Tool-echo mask, TUI only: print mode scans process output where quoted error
  // shapes ARE the real signal. The window is applied first (echo lines still consume
  // tail budget, so the window can't reach past a tall tool render into stale
  // scrollback), but the mask itself is computed over the FULL pane and sliced — a
  // result block taller than the window would otherwise hide its own `● Name(` header
  // above the window and leave the quoted children unmasked.
  let lines = all
  let mask: boolean[] | null = null
  if (tailLines > 0) {
    const { start, end } = contentTailRange(all, tailLines)
    lines = all.slice(start, end)
    mask = toolEchoMask(all).slice(start, end)
  }

  // Custom patterns test the RAW tail, not the chrome-stripped window. The user owns
  // their own false-positive tradeoff, so a pattern keyed on footer text (a usage
  // percentage, a model name) must still fire even though the footer is furniture the
  // built-in path strips — and it stays bounded to the same tailLines so it can't reach
  // deeper into scrollback than before.
  if (customPatterns.length > 0) {
    const raw = tailLines > 0 ? all.slice(-tailLines) : all
    const full = raw.join('\n')
    const custom = customPatterns.map((p) => (typeof p === 'string' ? new RegExp(p, 'i') : p))
    if (custom.some((p) => p.test(full))) return true
  }

  // Backstop for the modern render: a live limit prints "/usage-credits to finish…" right
  // by the banner, so finding that companion next to a reset/limit line catches a banner
  // buried behind a widget the chrome allowlist doesn't recognize. But it needs the SAME
  // liveness discipline as the main path: only trust the companion when it sits in the
  // live region — nothing but chrome below it. A resumed session's scrollback always
  // contains the stale banner+companion with real work rendered below; without this gate
  // the backstop fires on that (up to maxRetries injections + a ~24h wait). (Only when
  // tail-scoped; print mode uses the full scan below.)
  if (tailLines > 0) {
    // The companion must not itself be tool echo (a grep for "/usage-credits" quoting
    // banner text would otherwise satisfy both the companion and the nearby-reset check).
    const fullMask = toolEchoMask(all)
    // Array.prototype.findLastIndex is ES2023; tsconfig.node.json targets ES2022, so a
    // manual reverse scan avoids widening the project-wide lib target for one call site.
    let companionIdx = -1
    for (let i = all.length - 1; i >= 0; i--) {
      if (!fullMask[i] && USAGE_CREDITS.test(all[i])) {
        companionIdx = i
        break
      }
    }
    // Require a RESET line nearby — NOT just a LIMIT line. A live limit banner always prints
    // its reset time next to the companion; a session merely *explaining* usage limits ("when
    // you hit your usage limit you can run /usage-credits …") has the companion + a loose
    // "usage limit" LIMIT match but no reset time, and would otherwise false-fire a retry.
    if (
      companionIdx !== -1 &&
      all.slice(companionIdx + 1).every(isChromeLine) &&
      hasNearbyMatch(all, companionIdx, RESET_PATTERNS, fullMask)
    ) {
      return true
    }
  }

  // Find a "limit" line with a "resets" line nearby (works for both single-line messages
  // and multi-line TUI renders).
  for (let i = 0; i < lines.length; i++) {
    if (mask && mask[i]) continue
    if (LIMIT_PATTERNS.some((p) => p.test(lines[i]))) {
      if (hasNearbyMatch(lines, i, RESET_PATTERNS, mask)) return true
    }
  }

  return false
}

// Has the session RESUMED past its limit banner? Used by the watchdog's waiting branch,
// where plain isWorking() is too loose: `Retrying in …`/`attempt N/M` match transcript
// text, so a flaky-deploy log line lingering ABOVE a live banner made every expiry tick
// look like "user continued" — the monitor churned waiting/user-continued forever and
// never sent the retry. Ordering is the discriminator: a session that actually resumed
// renders its new work BELOW the banner; working lines above it are history. When no
// banner is in the window (scrolled away after a real resume, or entered via custom
// patterns), fall back to plain isWorking — same behavior as before.
export function resumedAfterLimit(text: string, tailLines = 0): boolean {
  const all = stripAnsi(text).split('\n')
  const { start, end } = tailLines > 0 ? contentTailRange(all, tailLines) : { start: 0, end: all.length }
  const lines = all.slice(start, end)
  const mask = toolEchoMask(all).slice(start, end)
  let lastLimit = -1
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    if (LIMIT_PATTERNS.some((p) => p.test(lines[i]))) lastLimit = i
  }
  if (lastLimit === -1) return isWorking(text)
  return lines.slice(lastLimit + 1).some(isWorkingLine)
}

// --- Interactive /rate-limit-options menu ---
// Newer Claude Code shows a selectable menu when a session/weekly limit is hit:
//   What do you want to do?
//   ❯ 1. Upgrade your plan
//     2. Stop and wait for limit to reset
// A bare Enter confirms the highlighted default — which is "Upgrade your plan"
// on some versions. The option ORDER varies between versions, so we never assume
// a position: we locate the cursor (❯) and the "Stop and wait" option and compute
// the cursor moves needed to land on it.

const MENU_CURSOR = '❯'
const WAIT_OPTION_REGEX = /stop and wait for limit to reset/i
const MENU_OPTION_REGEX = /^\s*❯?\s*\d+\.\s/

// tailLines > 0 restricts to the last N lines: a LIVE menu sits at the prompt, so the
// same menu text quoted in scrollback (a conversation about limits) must not make us
// drive arrow keys + Enter into whatever is actually on screen.
export function isRateLimitOptionsPrompt(text: string, tailLines = 0): boolean {
  const all = stripAnsi(text).split('\n')
  // Chrome-aware, like the banner detectors: a live menu pushed up by a tall widget below
  // it must still be seen, or the menu branch is skipped and a later sendKeys types into
  // the open menu (Enter confirms the default "Upgrade your plan"). Menu lines are not
  // chrome, so contentTail keeps them.
  const lines = tailLines > 0 ? contentTail(all, tailLines) : all
  const t = lines.join('\n')
  return (
    /what do you want to do\?/i.test(t) &&
    WAIT_OPTION_REGEX.test(t) &&
    (/enter to confirm/i.test(t) || /esc to cancel/i.test(t) || t.includes(MENU_CURSOR))
  )
}

// Cursor moves to reach the "Stop and wait for limit to reset" option, counted in
// option steps: positive => press Down N times, negative => Up, 0 => already there.
// Returns null when the layout can't be read (no cursor or option not found); the
// caller MUST NOT press Enter in that case, to avoid confirming the wrong option.
// tailLines mirrors isRateLimitOptionsPrompt so option counting ignores quoted menus.
export function menuStepsToWaitOption(text: string, tailLines = 0): number | null {
  const all = stripAnsi(text).split('\n')
  const lines = tailLines > 0 ? contentTail(all, tailLines) : all // chrome-aware, matches isRateLimitOptionsPrompt
  const optionLines = lines.filter((l) => MENU_OPTION_REGEX.test(l))
  if (optionLines.length === 0) return null
  const cursorPos = optionLines.findIndex((l) => l.includes(MENU_CURSOR))
  const waitPos = optionLines.findIndex((l) => WAIT_OPTION_REGEX.test(l))
  if (cursorPos === -1 || waitPos === -1) return null
  return waitPos - cursorPos
}

// --- Overload / transient API error detection (distinct from usage limits) ---
// Claude Code already retries 5xx/529 internally; this only fires on a *sustained*
// terminal error left in the pane. Patterns are case-insensitive regexes (same as
// the usage-limit customPatterns), caller-supplied. Kept entirely separate from the
// usage-limit path above so the two never collide.
//
// Two guards keep this from firing on ordinary content (the historical bug: a bare
// "503"/"529" in code under edit, an HTTP status in a quoted log, or "status.claude.com"
// in a comment all looked identical to a live error):
//   1. Patterns are ANCHORED to Claude Code's actual error render ("API Error: <code>"
//      or the "overloaded_error" JSON type) — never a bare status number. This is a
//      convention of the caller-supplied pattern set, not enforced by this module.
//   2. Only the TAIL of the pane is inspected. A *terminal* error is the last thing
//      Claude printed; the same digits sitting in scrollback the user scrolled past
//      are not an error. Scanning the whole capture is what drove the false positives —
//      a 503 far up the buffer kept re-triggering during unrelated work.

// A real terminal error sits just above the input box (~5-6 variable lines: box
// borders + input row(s) + footer). A multi-line JSON error body adds a few more, so
// its anchor line can land ~10 rows from the bottom. 12 content lines cover that with
// margin; a typical capture is deeper than that, so trailing chrome is stripped and this
// keeps only the live error region (bounded further by OVERLOAD_MAX_RAW_LINES below).
const OVERLOAD_TAIL_LINES = 12
// Hard raw-distance cap for the overload path. A terminal API error renders just above
// the input box; an error only reachable by chrome-stripping past a tall widget is stale
// scrollback, not live. Bounds the deeper capture so overload — seconds-scale and more
// false-positive-prone than the reset-anchored limit path — can't reach an old quoted
// error. 20 matches the original upstream capture depth.
const OVERLOAD_MAX_RAW_LINES = 20

interface WindowedLines {
  lines: string[]
  mask: boolean[]
}

// Chrome-aware tail for the overload/safeguard detectors: a terminal error can be pushed
// up by the same widgets that pushed the limit banner, so strip trailing chrome first —
// but bound the reach so a widget-buried stale error stays out.
// Windowed lines PLUS their tool-echo mask. The mask is computed on the full pane and
// sliced to the window, so a result block taller than the window keeps its children
// masked even when the `● Name(` header sits above the window.
function tail(text: string): WindowedLines {
  const all = stripAnsi(text).split('\n')
  const { start, end } = contentTailRange(all, OVERLOAD_TAIL_LINES, OVERLOAD_MAX_RAW_LINES)
  return { lines: all.slice(start, end), mask: toolEchoMask(all).slice(start, end) }
}

// Compile a config pattern (string → case-insensitive RegExp) once per call. Invalid
// regexes are dropped rather than thrown (matches the usage-limit customPatterns path).
function toRegexes(patterns: Array<string | RegExp>): RegExp[] {
  const out: RegExp[] = []
  for (const p of patterns) {
    if (p instanceof RegExp) {
      out.push(p)
      continue
    }
    if (typeof p !== 'string' || !p) continue
    try {
      out.push(new RegExp(p, 'i'))
    } catch {
      /* skip invalid */
    }
  }
  return out
}

export interface PatternMatch {
  pattern: string
  line: string
}

// A REAL overload always renders as an `API Error:` line ("API Error: 529 …", "API Error:
// Server is temporarily limiting requests …", or "API Error: …" one line above a JSON
// `overloaded_error` body). Requiring that line nearby — the same discipline safeguardMatch
// uses — keeps the phrase patterns ("temporarily limiting requests", "overloaded_error")
// from firing when they're merely quoted/discussed in the pane (e.g. a session explaining
// this tool, or a chat about API errors). Mirrors SAFEGUARD_ANCHOR.
const OVERLOAD_ANCHOR: RegExp[] = [/\bAPI Error\b/i]

// Returns { pattern, line } for the first overload pattern matching a tail line (with an
// `API Error` line nearby), else null. Per-line (not whole-tail) so the caller can report
// WHICH line tripped it — invaluable for diagnosing a future false positive.
export function overloadMatch(text: string, patterns: Array<string | RegExp> = []): PatternMatch | null {
  if (!patterns || patterns.length === 0) return null
  // Tool-echo mask: a quoted "API Error: 529 overloaded" in a Bash() render carries its
  // own anchor on the same line, so the anchor discipline alone can't reject it.
  const { lines, mask } = tail(text)
  if (!lines.join('').trim()) return null
  const regexes = toRegexes(patterns)
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    for (const r of regexes) {
      if (r.test(lines[i]) && hasNearbyMatch(lines, i, OVERLOAD_ANCHOR, mask)) {
        return { pattern: r.source, line: lines[i].trim().slice(0, 200) }
      }
    }
  }
  return null
}

export function detectOverload(text: string, patterns: Array<string | RegExp> = []): boolean {
  return overloadMatch(text, patterns) !== null
}

// --- Safeguard / AUP false-positive detection ---
// A distinct failure mode from usage limits and 5xx overloads: the model's safeguards
// flag the message (often a false positive — the error itself says it "may flag safe,
// normal content as well"). It renders like:
//   ● API Error: Fable 5's safeguards flagged this message (…/legal/aup). … Claude Code
//     can't respond to this request with Fable 5.
//     Double press esc to edit your last message, or try a different model with /model.
// Because the flag is semi-random, an immediate re-send frequently clears it — but it
// must be capped so a *sticky* flag doesn't loop forever. Tail-anchored like the others.
// Anchor: a REAL flag always renders as an `API Error:` line. Requiring it nearby (same
// wrap-tolerant window isRateLimited uses for limit/resets pairing) keeps the phrases
// from firing on ordinary conversation — Claude quoting the AUP link or discussing
// safeguard errors at an idle prompt must not trigger a retry.
const SAFEGUARD_ANCHOR: RegExp[] = [/\bAPI Error\b/i]

export function safeguardMatch(text: string, patterns: Array<string | RegExp> = []): PatternMatch | null {
  if (!patterns || patterns.length === 0) return null
  // Same tool-echo discipline as overloadMatch: a quoted safeguard line in a tool render
  // can sit next to a quoted API Error anchor.
  const { lines, mask } = tail(text)
  if (!lines.join('').trim()) return null
  const regexes = toRegexes(patterns)
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    for (const r of regexes) {
      if (r.test(lines[i]) && hasNearbyMatch(lines, i, SAFEGUARD_ANCHOR, mask)) {
        return { pattern: r.source, line: lines[i].trim().slice(0, 200) }
      }
    }
  }
  return null
}

export function detectSafeguard(text: string, patterns: Array<string | RegExp> = []): boolean {
  return safeguardMatch(text, patterns) !== null
}

// Chrome-aware, so isWorking measures the SAME bottom as isRateLimited/detectOverload. A
// live working footer pushed up by a tall chrome stack below it (task widget + input box
// + footer) would be invisible to a raw last-N tail while the chrome-aware detectors still
// saw a lingering banner — the asymmetry that let retry text land in a mid-flight session.
// isChromeLine excludes working lines, so contentTail never strips the footer.
export function isWorking(text: string): boolean {
  return contentTail(stripAnsi(text).split('\n'), OVERLOAD_TAIL_LINES).some(isWorkingLine)
}

// Claude Code's OWN internal-retry render ("… · Retrying in 5s · attempt 3/10"). It
// satisfies isWorking (the turn is open and must not be interrupted), but it is the
// opposite of RECOVERY — the turn is still failing. Consumers inferring "the incident
// ended well" from a working pane must exclude it, or a sustained outage's in-flight
// retries zero the backoff budget every cycle and the give-up cap never trips.
const INTERNAL_RETRY_PATTERNS: RegExp[] = [/Retrying in\b/i, /\battempt\s+\d+\/\d+/i]

export function isInternalRetry(text: string): boolean {
  return contentTail(stripAnsi(text).split('\n'), OVERLOAD_TAIL_LINES).some((l) =>
    INTERNAL_RETRY_PATTERNS.some((p) => p.test(l)),
  )
}

export function findRateLimitMessage(text: string, customPatterns: Array<string | RegExp> = []): string | null {
  const lines = stripAnsi(text).split('\n')
  // Tool-echo mask: without it, a quoted "resets 9am" in a fresh grep line below a real
  // banner would win the bottom-up scan and be parsed instead of the banner.
  const mask = toolEchoMask(lines)
  void customPatterns // parity with upstream signature; unused by the built-in scan

  // Scan from the bottom up — the most recent "resets" line is the one to parse. The
  // Claude TUI never clears earlier rate-limit messages from scrollback, so a forward
  // scan would lock onto a stale line (e.g. an old "resets 11:30am" lingering above a
  // fresh "resets 4:30pm").
  for (let i = lines.length - 1; i >= 0; i--) {
    if (mask[i]) continue
    if (RESET_PATTERNS.some((p) => p.test(lines[i]))) return lines[i].trim()
  }

  // Fallback: any "limit" line, also scanned from the bottom.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (mask[i]) continue
    if (LIMIT_PATTERNS.some((p) => p.test(lines[i]))) return lines[i].trim()
  }

  return null
}

// --- Send gate (#266 BLOCKER-2 / MAJOR-3) ---
// A retry write lands WHEREVER the pane's focus is. Three panes it must never
// land in:
//   - a NUMBERED SELECTION (a permission prompt, /rate-limit-options, the
//     resume picker): `continue\r` there SELECTS — a permission prompt's
//     "1. Yes" auto-approves whatever was asked;
//   - an explicit interactive ask awaiting keys;
//   - an input box already carrying the USER'S OWN DRAFT: the write would
//     concatenate onto their unsubmitted text and submit the mangled line.
// The gate answers "may an automated line be typed into this pane RIGHT NOW",
// from the same rendered tail every other detector reads. Refusal defers the
// retry (never consumes an attempt) — a pane waiting on a human stays theirs.
// Bottom-anchored like the chrome walk: only the live lines near the input can
// gate, so a menu quoted in scrollback does not freeze retries forever.
const SEND_GATE_TAIL_LINES = 14

// A NUMBERED selectable option row as Claude Code renders one: optional caret,
// a small integer, a dot, then the label. Anchored to the row shape (not "a
// digit and a dot anywhere") so ordinary prose ("2. see above") is not a menu.
const MENU_NUMBER_ROW = /^\s*(?:[❯>]\s*)?\d{1,2}\.\s+\S/

// The FANCY input/selection caret (U+276F) carrying text after it. This is the
// discriminator the earlier revision missed by modelling the boxed mock shape
// instead of the real render (#266 review, F1/F2). Claude Code's real input is
// a top rule, `❯ …`, a bottom rule, then a footer — NO `│` gutters — and the
// SAME caret marks the focused row of an unnumbered picker ("❯ Looks good —
// save it", where Enter persists a policy). So one row of `❯ <non-space>`
// anywhere in the live window means either the user's draft or an open picker,
// and both must gate. The EMPTY prompt is `❯ ` with nothing after it, which
// does not match — that is the sendable retry posture. A markdown blockquote
// uses ASCII `>`, never this glyph, so this never fires on quoted prose.
const CARET_TEXT_ROW = /^\s*❯\s+\S/
// The boxed input row carrying text (the repo's own mock shape, and any render
// that does draw gutters) — belt-and-braces beside the caret row above.
const BOXED_DRAFT_ROW = /^\s*│\s*[>❯]\s*\S[^│]*│\s*$/
// The bare ASCII prompt carrying text. Prose-shaped (a markdown blockquote
// "> quoted line"), so it gates ONLY as the very last non-blank line — where a
// live ASCII prompt sits and a blockquote never does.
const BARE_ASCII_DRAFT_ROW = /^\s*>\s+\S/

export interface SendGateResult {
  ok: boolean
  reason?: 'menu' | 'draft'
}

/**
 * May an automated retry line be typed into this pane RIGHT NOW (#266
 * BLOCKER-2/MAJOR-3)? Read from the same rendered tail every detector uses.
 * Fails SAFE: when the live window shows anything that a `continue\r` could
 * corrupt — a menu (a permission prompt's "1. Yes" auto-approves), an
 * unnumbered picker (Enter confirms its focused row), or an input carrying the
 * user's unsubmitted draft — it refuses, and the caller defers without
 * consuming an attempt. An empty prompt under a live banner is the one
 * sendable state and returns ok.
 */
export function canSendNow(text: string, nonDimText?: string): SendGateResult {
  // The purpose-built /rate-limit-options detector first (chrome-aware): the
  // menu a rate-limit retry is most likely to collide with.
  if (isRateLimitOptionsPrompt(text, SEND_GATE_TAIL_LINES)) return { ok: false, reason: 'menu' }
  const lines = stripAnsi(text).split('\n')
  // Raw last-N window, deliberately NOT chrome-stripped: the things this gate
  // looks for (menus, the input row) ARE chrome, and stripping them first is
  // how the earlier revision ended up blind at exactly the wrong moment.
  const tail = lines.slice(Math.max(0, lines.length - SEND_GATE_TAIL_LINES))

  // The styled companion of the same pane (#418): every DIM cell blanked to a
  // space, lines aligned 1:1 with `text`. Claude Code renders the placeholder
  // in an EMPTY input dim — "Press up to edit queued messages" whenever the
  // queue is non-empty, "Message @agent…" in an agent view, "Comment on N
  // selected lines…" over an IDE selection — states that coexist with a live
  // rate limit indefinitely, so reading text alone made the gate defer forever
  // and the retry silently never fired. A DRAFT row must show NON-DIM ink
  // after its prompt glyph; a row whose after-caret text is all placeholder is
  // the sendable empty prompt wearing a hint. Two deliberate asymmetries:
  //   - menu rows are counted on the RAW text (a selector's unfocused rows may
  //     render dim, and losing them would weaken the menu guard);
  //   - no styled read, or line counts that do not match, means the styled
  //     read is IGNORED and every caret row gates as before — the fail-closed
  //     posture this gate has always had.
  const nonDimLines = nonDimText !== undefined ? stripAnsi(nonDimText).split('\n') : null
  const nonDimTail =
    nonDimLines !== null && nonDimLines.length === lines.length
      ? nonDimLines.slice(Math.max(0, nonDimLines.length - SEND_GATE_TAIL_LINES))
      : null
  const hasInk = (rowIndex: number, re: RegExp): boolean => (nonDimTail ? re.test(nonDimTail[rowIndex] ?? '') : true)

  let numberRows = 0
  let caretTextRows = 0
  for (let i = 0; i < tail.length; i++) {
    const l = tail[i]
    if (MENU_NUMBER_ROW.test(l)) numberRows++
    if (CARET_TEXT_ROW.test(l) && hasInk(i, CARET_TEXT_ROW)) caretTextRows++
  }

  // A menu: two+ numbered rows (a selector always lists its alternatives; one
  // lone "1. …" can be a content list item), or two+ caret rows (an unnumbered
  // picker with its options). Reported as 'menu'.
  if (numberRows >= 2 || caretTextRows >= 2) return { ok: false, reason: 'menu' }

  // A single caret-with-text row is ambiguous between the filled input and a
  // one-line picker — both gate. Anywhere in the window, because the real
  // render puts a bottom rule and a footer BELOW it, so it is never the last
  // line (the bug F1 exposed). Reported as 'draft' (the commoner case).
  if (caretTextRows >= 1) return { ok: false, reason: 'draft' }

  // The boxed form, anywhere in the window.
  for (let i = 0; i < tail.length; i++) {
    const l = tail[i]
    if (BOXED_DRAFT_ROW.test(l) && hasInk(i, BOXED_DRAFT_ROW) && !isWorkingLine(l)) {
      return { ok: false, reason: 'draft' }
    }
  }

  // The bare ASCII prompt: only as the last non-blank line, so a markdown
  // blockquote in content is never mistaken for a draft.
  let lastNonBlankIndex = -1
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i].trim() !== '') {
      lastNonBlankIndex = i
      break
    }
  }
  if (lastNonBlankIndex >= 0) {
    const l = tail[lastNonBlankIndex]
    if (BARE_ASCII_DRAFT_ROW.test(l) && hasInk(lastNonBlankIndex, BARE_ASCII_DRAFT_ROW) && !isWorkingLine(l)) {
      return { ok: false, reason: 'draft' }
    }
  }
  return { ok: true }
}
