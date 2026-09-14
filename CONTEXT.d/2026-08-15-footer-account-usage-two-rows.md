## 2026-08-15 -- Footer account-usage strip: two rows + "+N" overflow

Owner request: "if there are more than 3 open accounts I want the bottom bar
which shows the account usages to automatically stretch to two rows with a max
of 3 accounts on each row - if the user has more than 6 then some sort of
overflow button where they can click for their status."

### What renders it

`MultiAccountStatusline` (rendered by `BottomBar`'s centre zone) was a single
flex row of account pills: identity dot + full email + one `RateLimitBar` per
usage bucket. It still gates on `>= 2` live accounts.

### What changed

- New pure, generic `splitAccountRows()` next to `liveAccountUsage()`, with the
  caps exported (`FOOTER_MAX_PER_ROW = 3`, `FOOTER_MAX_ROWS = 2`,
  `FOOTER_MAX_VISIBLE = 6`). All the boundary behaviour lives there so it is
  testable without a DOM.
  - `<= 3` -> one row (byte-identical classes to before: `gap-6`, pills
    `shrink-0`, no vertical padding, email un-truncated).
  - `4..6` -> two rows, BALANCED (4 -> 2+2, 5 -> 3+2, 6 -> 3+3). Balanced rather
    than fill-first (3+1) so the centred cluster stays symmetric; both readings
    satisfy "max 3 per row".
  - `> 6` -> first 6 in two rows of 3, the tail returned as `overflow`.
- Two-row mode tightens the inter-pill gap to `gap-4`, adds `py-1`, and lets the
  email ellipsise (`min-w-0` + `truncate`) while the meters stay `shrink-0`, so
  three pills survive the 1280px `minWidth` (`src/main/index.ts`). The full
  address stays in the pill's `title`.
- `AccountOverflow`: a "+N" chip that opens a small popover listing the hidden
  accounts with the same dot/email/meters.

### Bar height is NOT load-bearing

The footer is `min-h-7` (a MINIMUM) and `shrink-0` inside App's
`flex flex-col h-screen`; the terminal column re-fits from a `ResizeObserver` on
its own container (`TerminalView`), not from a height constant. Nothing measures
the footer, and no CSS/JS elsewhere hard-codes its height -- so it can grow.

### Popover traps handled

- `BottomBar` and its centre zone are `overflow-hidden`, so an absolutely
  positioned popover would be clipped. Uses `position: fixed` computed from the
  chip's `getBoundingClientRect()` -- the existing `ScreenshotButton` pattern
  (no ancestor creates a containing block, so `fixed` escapes the clip).
- Dismissal is a document `mousedown` probe (the `AiUsagePopover` /
  `ScreenshotButton` pattern), deliberately NOT a full-screen backdrop div:
  house rule, a backdrop that closes on click gets dismissed spuriously because
  Ctrl+C fires click events.
- Escape closes and hands focus back to the chip; the chip carries `focus-ring`,
  `aria-haspopup="dialog"` and `aria-expanded`; the popover is `role="dialog"`
  and receives focus on open.
- Appear animation is a new `.account-overflow-pop` class in `styles.css` with a
  `prefers-reduced-motion: reduce` guard, mirroring `.footer-update-pulse`.
- New chrome consumes V2 semantic tokens only (`--surface-overlay`,
  `--border-strong`, `--text-primary`, `--text-secondary`, `--brand`) and uses
  `--text-secondary` (>= 5:1 on both themes' chrome) rather than `--text-muted`.

### Verification

`npm run typecheck` clean; full `npx vitest run` 4793 passed / 13 skipped (+19
new). Boundary tests at 3 / 4 / 6 / 7 / 9 accounts plus open-reveal, Escape and
outside/inside mousedown. Mutation-checked four ways -- fill-first split,
removing the visible cap, forcing multi-row styling, and `<=` -> `<` on the
single-row boundary -- each killed by exactly the tests that should catch it.
