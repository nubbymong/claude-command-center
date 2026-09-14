## 2026-08-15 -- Onboarding: the update channel, the undisclosed listener, and copy that had drifted

A batch of small, separately-diagnosed onboarding fixes on the canvas P3 branch.
Two of them are behavioural; the rest are copy that stopped matching the product.

### A beta install received no betas, silently

`updateChannel` defaults to `'stable'` (settingsStore) and `getUpdateChannel()` in
`github-update.ts` returns `'stable'` unless the key says otherwise. So somebody who
deliberately installed a prerelease got no further prereleases, with no signal --
and `shouldReonboardForBeta()` reads the same value, so the beta re-onboarding path
was dead for exactly the cohort it exists for.

The fix is a row in the Transparency recap grid (no new page): it says which kind of
build you are running and carries a two-way control. It **persists** the
pre-selection rather than just painting it, because both the updater and the
re-onboarding gate read the stored value -- a pre-selection that is not saved fixes
nothing.

That forced a small settings addition: `updateChannelChosen?: boolean`. Without it
there is no way to tell "stable because nobody ever chose" from "stable because the
user chose it", and the pre-selection would flip a real choice back on the next
mount. Both this row and the Settings -> General select now set it, and the
pre-selection is skipped whenever it is present. The version parsing lives in
`utils/versionLabel.ts` (`isPrereleaseVersion`, `defaultUpdateChannelForVersion`) so
it is unit-testable without a renderer; anything that does not parse degrades to
`stable`.

### The hooks gateway was on by default and mentioned nowhere in the flow

`hooksEnabled` defaults true, which opens a loopback listener that -- per its own
Settings copy -- is reverse-tunnelled into SSH sessions you start. Every comparable
surface (logging, Sentinel, built-in tools, Codex, GitHub) is asked about
explicitly. It now gets a recap row naming the listener, the address and the "no
telemetry" fact, and reporting Off with where to change it. Disclosure only: a
consent toggle here would have to await the gateway start/stop IPC and reconcile
persisted intent with the listener's real state (`HooksGatewaySection` does exactly
that), which is more than a recap row should own.

### Copy that had drifted

- Four Conductor tools ship; three places still named three -- the MCP page's
  server-down state, the upgrade cohort's first onboarding page, and the Conductor
  MCP registration tip. All now name the Agent Canvas too.
- The Feature Guide had 19 entries and no Agent Canvas, while FinishStep promises it
  "explains every feature". Added, next to Conductor MCP. No canvas screenshot asset
  exists yet, so it borrows `step-vision.jpg` with a note (same precedent as the
  webview entry).
- The sketchpad entry claimed the agent fetches the drawing "via the vision MCP".
  Nothing does that. The honest route is Copy in the sketchpad toolbar and paste;
  sketches that DO reach the agent are the ones drawn on the canvas glass, which
  travel with `canvas_review`.
- "Canvas" named two different things. Resolved in wording only -- no component,
  store, channel or button id moved. The Feature Guide entry is now the "Excalidraw
  Sketchpad" (matching the in-app "Open the sketchpad instead"), and its trigger path
  describes what actually happens now: the toolbar button opens the Agent Canvas, and
  the sketchpad is one click inside it.
- Welcome said "Everything stays on your machine". Codex review sends a diff to
  OpenAI, and GitHub polling plus update checks reach github.com. Re-worded on the
  model already used in Settings -> GitHub: no telemetry, then what actually leaves.
- The guided tour counter divided by `STEPS.length` while `next()` skips steps whose
  anchor is not mounted, so it could promise cards it would never show. It now counts
  what is reachable.
- `onboarding.css` still described the `--ob*` tokens as an orange family; they have
  been azure since the V2 pass.

### Contrast

`.gh-d` (recap card body, 11.5px) was `--text-muted`, which measures ~3.3-4.1:1 on
these surfaces. Moved to `--text-secondary` for the whole class rather than only the
new rows -- two greys side by side in one grid would read worse than either. The
hierarchy against `.gh-t` is carried by size and weight. The new segmented control
takes the app's `.focus-ring` convention.

### Verification

- `npm run typecheck` clean (`npx tsc --noEmit` still checks nothing here).
- Full `npx vitest run`: **4774 passed / 13 skipped**, up from 4754/13 -- +20, all
  new: version parsing (8), the two recap rows and the pre-selection rules (8), the
  tour counter (3), the MCP page's server-down copy (1).
- Every new assertion was mutation-checked: reverting the counter expression, the
  pre-selection effect, the explicit-choice flag and the server-down copy each turns
  the matching test red.
- One existing assertion updated rather than weakened: `training-steps.test.ts`
  pinned the guide at 19 entries; it is now 20, with the reason recorded in the test.
