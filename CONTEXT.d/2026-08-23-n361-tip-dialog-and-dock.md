## 2026-08-23 -- #361 tip dialog on the E5 primitives, and the dock row that is the tip

**The headline bug.** Five actions -- Silence until restart / Don't show this
again / Next tip / Discuss / Got-it-or-action -- shared one row of a 512px
dialog with nothing marked `whitespace-nowrap`, so every label folded in half.
The footer is now the mock's **option A**: the three flow actions stay as
buttons and the two "stop showing me this" actions move into a `...` overflow
menu on the left of the footer. A/B/C is still the owner's pick to confirm --
B was two tiers, C a card anchored to the dock pill -- and A was built because
it is the least disruptive of the three.

**What else the dialog got wrong, and the shapes worth remembering.**

- `bg-mauve hover:bg-pink text-base` on the primary button. Tailwind resolves
  `text-*` in the font-SIZE namespace first, so `text-base` was never a colour:
  "Got it" was 16px text in whatever colour it inherited. This is exactly the
  bug `--text-on-brand` exists to prevent, and the E5 `DialogButton` sets it.
- `onClick={onClose}` on the `fixed inset-0` backdrop. Ctrl+C in a terminal
  fires click events, so copying text closed the dialog. Dismissal is now on
  MOUSEDOWN, and only when the mousedown lands on the backdrop itself.
- Emoji as iconography (a lightbulb and a pin) while the dock next to it drew a
  stroked SVG lightbulb, so the two halves of one feature did not look related.

**`DialogOverlay` grew an opt-in, and the target check is the point.** #360's
overlay deliberately had no dismiss prop at all. `onBackdropDismiss` adds the
mousedown rule the command bar's popovers use (#386) as an opt-in, so a light
informational dialog can be dismissed by clicking away without any dialog being
able to reintroduce a click handler. One difference from the bar's popovers is
load-bearing: their backdrop is an EMPTY SIBLING of the surface, this one is the
PARENT of the panel, so without `e.target === e.currentTarget` a mousedown that
begins on a button inside the dialog bubbles up and closes the dialog under the
user's finger. A right-click still dismisses inertly (`preventDefault` +
`stopPropagation`), so the gesture cannot fall through to the terminal, where
right-click pastes.

**Peach became a token.** Tips are peach and Ask Conductor is `--brand`, which
is what makes the two dock rows read as a pair. The dock said
`var(--color-peach)` -- a raw palette variable, and dialogs are scanned for
exactly that by `dialog-palette-retired.test.ts`. New semantic token
`--accent-tip` (both themes), used by the dock row, the collapsed rail pill, the
dialog's glyph tile and a new `tone="tip"` callout. The Discuss button stays
brand-coloured because it IS the Ask action, and the primary button stays the
standard E5 brand fill so this dialog's affirmative looks like every other
dialog's.

**The dock row is the tip now.** The row carried a "Tip of the day" header in
12px semibold over the tip in 10px muted -- spending the widest line of a 256px
rail on a label the lightbulb already says, and leaving the tip itself one
truncated line. The header is gone, the tip is the row's own text at 11px over
two clamped lines, and the `N new` pill shrank to a quiet counter badge (the
wording moved to the tooltip and the accessible name, where it costs no width).
The longest headline in the library is 59 characters; two lines hold it.

**Copy.** Every tip headline lost its leading emoji (49 of 50 had one) -- the
lightbulb is the only mark tips get. The Canvas tip still described the toolbar
as "next to Snap and Web"; that button has said **Browser** since the webview
rename, so the body and the focus hint now say Browser. The wider headline
content pass is #377; this change only had to stop the layout truncating what a
reasonable headline needs.

**`TipModal.tsx` left the `TRACKED_ELSEWHERE` map** in
`dialog-palette-retired.test.ts` -- it was excluded there pending this issue, so
it is now policed by the #360 scan like every other dialog, and the exclusion
map's own staleness guard is what forced the removal.

**Guards proved by mutation, not by assertion alone.** Turning the overlay's
`onMouseDown` back into `onClick` fails three tests (including #360's own
backdrop scan); putting an emoji back on a headline and restoring the "Tip of
the day" header each fail their guard. Full suite 7808 passed / 16 skipped /
2 todo across 703 files; `npm run typecheck` clean.
