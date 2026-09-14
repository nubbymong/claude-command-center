# 2026-08-21 — Tips into the sidebar dock, and hiding either dock feature

## What moved

`TipPill` is gone. The tip trigger now lives in `components/sidebar/AskConductorDock.tsx`,
as a second row inside the dock zone under the Ask Conductor pill, in peach rather
than the brand colour so the two read as siblings.

The header pill had room for an icon and a few words, sat in whichever session
happened to be in front (so it moved as you switched), and competed with the
account and notes controls. The dock row is always in the same place and wide
enough to carry the tip's `shortText` plus a count. That extra room is the whole
argument for the move — it was in all three canvas options and the owner picked
one before any of this was built.

`SessionHeader` lost its `onShowTip` prop entirely; `App.tsx` now hands the
callback to `Sidebar`, which passes it to both dock call sites (expanded and
collapsed rail). `TipModal` is unchanged — only the trigger moved.

## Hiding is a feature switch, not a display toggle

Right-clicking either dock row offers "Hide …", which opens
`HideDockFeatureDialog` and, on confirm, writes the setting.

The dialog is not ceremony. Hiding turns the **feature** off:

- `showTips: false` — the row goes, and `App.tsx`'s launch-time `pickNextTip()` is
  now gated on the setting. Without that gate the library would keep burning down
  behind a hidden row, stamping tips shown that nobody saw, and the "N new" count
  would be wrong the day the user turned it back on.
- `showAskConductor: false` (new, defaults true, absent means shown) — the entry
  point goes, and it is the only one. An Ask session that is **already open stays
  open**: a display toggle must not destroy a running session.

Because the row you dismissed it from is then gone, the dialog is the last place
the user can be told where the way back is, so it names Settings → General
explicitly. Both settings also have checkboxes there.

## Two things worth not rediscovering

**`getCurrentTip()` cannot be used as a zustand selector.** It builds a fresh
`{ tip, content }` object on every call, so selecting it directly fails the
`Object.is` check on every store touch and re-renders for ever. It is derived in
a `useMemo` off `currentTipId` + `tracking`, which are its only inputs.

**The count says "new", not "unread", and that is deliberate.** `tipsShown` is
stamped when a tip is *picked* — about two seconds after launch — not when it is
read (backlog 12–16, pre-existing). So `countUnseenTips` honestly counts "never
put in front of you". Moving the trigger does not fix that; it does make it
visible, which is why the wording is what it is.

## Verification

Full suite **6196 passed / 15 skipped**, typecheck clean.

`tests/unit/renderer/sidebar-dock-tips.test.tsx` is new (15 cases). All three of
its load-bearing guards were mutation-tested and each mutation produced real
failures:

| mutation | failed |
| --- | --- |
| `if (!showAsk && !tipReady) return null` disabled | 1 |
| menu hides immediately instead of opening the dialog | 3 |
| `showTips` dropped from the `tipReady` conjunction | 2 |

ADR-009 does not apply: renderer UI and two boolean settings, nothing on the
sensitive-path table.
