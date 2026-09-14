## 2026-08-17 -- Settings visual consistency (one card / accent / input system)

The Settings pages had diverged into several visual systems. Audited every tab
(accent + background) and converged them.

Backgrounds -- was FOUR card systems (semantic `--surface-raised`, utility
`bg-surface0/30`, the GitHub tab's warm-black borderless `bg-mantle` -- the
"different black" the owner flagged, which read SUNKEN against the stage and
inverted in light mode -- and Hooks with no card at all). Now ONE:
- new `.settings-card` / `.settings-panel` / `.settings-divider` classes in
  styles.css (blue-tinted `--surface-raised` / `--surface-base` / `--border-subtle`,
  both theme-aware). Every tab's section cards + nested boxes use them; the
  shared `Section` helper now emits `.settings-card`.

Accent -- was blue (dominant) + green toggles + teal TabsRail/focus + Chromium's
un-themed native-control blue + a stray sapphire hover. Unified interactive
chrome on the app BLUE (`--color-blue`, theme-aware):
- `Toggle` on-state green -> blue (one edit, ~17 settings toggles); the mirrored
  "ON" label too; TabsRail active teal -> blue; a global
  `input[checkbox|radio|range] { accent-color: var(--color-blue) }` themes every
  native checkbox + slider (previously stock Chromium blue, ignoring the theme);
  sapphire hover -> blue.
Semantic DATA colours preserved: success green / +added--removed / usage-bar
ramps in the status-line preview, update-status text, the green "Install now"
pill, destructive red, identity swatches, the mauve tri-state, Codex accent
borders.

Inputs -- folded the GitHub/Codex/Copilot/AccountWeb `bg-surface0`/`bg-base`
variants onto the dominant `bg-crust/60 border-surface0/80 rounded ... focus:border-blue/50`.
GitHubConfigTab dropped its double padding + `max-w-3xl` (parent already pads +
centres). OAuthDeviceFlow modal scrim `bg-base/80` (a LIGHT scrim in light mode)
-> `bg-black/60`, and its borderless panel got a border to match other modals.

Renderer-only. typecheck + production build clean; settings/github/copilot
component tests green; full suite green. Light + dark both covered (all via
theme-aware tokens; no raw hex added). Owner to live-test the real pages.
