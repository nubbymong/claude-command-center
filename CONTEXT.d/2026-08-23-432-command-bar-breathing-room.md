## 2026-08-23 -- #432 command bar: breathing room + empty band labels hidden

From live beta.17 review, agreed on the Agent Canvas (owner picked "Balanced"
from A/B/C height variants; the canvas itself was under test at the same time).

- **Breathing room.** The one-row bar was `px-2 py-0.5` (2px vertical) with a
  top border, sandwiched between the status strip and the account footer, so it
  did not read as a central control. Now `px-2.5 py-[9px]` with every bar button
  a uniform `h-7` (28px) — the "Balanced" option, row ≈ 47px. One row kept;
  overflow/fold unchanged. The height lives in one place per button type:
  `CHIP_CLASS` (chips.tsx) covers command chips, collapsed-section chips, the
  "N more" pill and the NotesTool trigger; the five core-tool components
  (Screenshot/Logs/Webview/AgentCanvas + the inline Add and Partner buttons)
  each carry the same `h-7`. All are bar-only, so no other surface is affected.
- **Empty band labels hidden.** A band with no commands used to still show its
  GLOBAL / SESSION label (a deliberate drop affordance — see the old
  "empty band is the affordance" test). The owner found that noisy. Now the
  label AND its leading divider are hidden while a band is empty and no drag is
  in progress; both reappear the moment a drag starts (`dragId` set), because
  the empty band is still the drop target that scopes a command global/session.
  The band DIV itself always renders, so the row height no longer changes when
  the first/last command in a band is added or removed (Add + core tools hold
  the row open regardless).

Settings → Custom Commands has no live bar preview, so nothing to re-space there
(the owner asked to check "in case of impact").

Tests: `commandbar-rows-and-scope.test.ts` updated — empty band label hidden
while idle, present during a drag, present when non-empty; the drag case fires a
`dragstart` on a chip to set `dragId`.
