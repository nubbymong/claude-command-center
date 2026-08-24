# 2026-08-24 — What's New multi-page feature showcase (upgrade flow)

Owner-approved design (canvas "What's New feature showcase" v1, "yeah this
looks good"): the upgrade flow's What's New is now a multi-page run — the
one-line summary is page 0, and each flagship feature of the line gets a full
page behind it with a drawn vignette.

- **`onboarding/showcase-pages.ts` (new)** — the curated pages per line
  (`SHOWCASES_21`: Agent Canvas, Session Watchdog, one-row bar) +
  `showcasesFor(currentVersion)` with sectionsFor's fallback rule (2.0 → none;
  a future line without a set → the newest set). Deliberately NOT in
  `changelog.ts`, so `gen-changelog.js` and the Changelog-in-sync CI are
  untouched by construction.
- **`onboarding/ShowcaseVignette.tsx` (new)** — pure-CSS decorative
  illustrations (mini canvas pane with mode title / Inspect chips / framed
  page / note pin + A/B/C; terminal with rate-limit banner + watchdog chip;
  one-row bar strip). aria-hidden, no emoji, tokens only (`.sv-*` in
  onboarding.css).
- **`WhatsNewV2Step`** — internal paging: footer dots (24px targets), "Skip
  the showcase", Next → on inner pages, the harness CTA + hint only on the
  last page; positional "Page N of M" hint earlier. Summary items grew
  `seeIt` chips (canvas/watchdog/oneRow) that jump to their page — a chip
  renders only when its page exists, so the two curated files cannot drift
  into a dead button. SECTIONS_21 gained the Watchdog and one-row lines.
  With no pages authored (2.0 builds) the step collapses to exactly the old
  single-page behaviour — the harness contract (`onNext`, `ctaLabel`, `hint`)
  is unchanged and OnboardingHarness was not touched.
- The step registry is untouched: `whatsNewV2` always surfaces on an upgrade
  (harness-level gate), so no `sinceVersion` bump and no frozen-table churn.
- Tests: `whatsnew-showcase.test.tsx` — data invariants (unique ids, 3-4
  points, seeIt resolution incl. the three flagships linked), paging (Next
  never fires onNext inward; last page carries the CTA; Skip leaves; dots
  jump both ways; per-kind vignette), and the 2.0 collapse via module
  re-import.

Changelog entry for the showcase lands with the rc.1 cut prep.
