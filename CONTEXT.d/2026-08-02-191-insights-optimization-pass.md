## 2026-08-02 -- Insights token/quality re-assessment: what was measured, what was fixed (#191)

A five-agent fan-out measured the whole Insights pipeline against real archives rather
than reasoning about it. Baseline, per single-account run (tokens we control; the CLI's
own `/insights` transcript digestion is inside the CLI and not reachable from here):

- report.html read via the Read tool: ~26,000 tokens -- **72% of a single run, 63% of a
  four-account run**. Measured 62-77 KB per report, of which only 10.8% is the numbers and
  labels a KPI extractor needs; 19% is byte-identical boilerplate re-read every run.
- previous-run context: the FULL previous kpis.json inlined verbatim, 13.5-15.4 KB.
- cross-account synthesis: every member's full kpis.json inlined, ~13.5 KB each.
- facets/*.json (29-50 files, 30-57 KB) are archived by copyReportToArchive and read by
  NOTHING. They reconcile exactly with six of the report's charts once
  `goal_categories: warmup_minimal` entries are dropped (verified on three runs), and
  carry signal absent from the report entirely (`claude_helpfulness`, the full friction
  tail the chart truncates).

Fixed on this branch, because it is this feature's own defect: the comparison table was
asserting equivalence it had not established. Merging on `category + metricKey` alone with
first-member-wins labelling produced a FALSE comparison from real data --
`Outcomes.successRate` is "Fully Achieved Rate" (0.4231) in one account and "Mostly or
Fully Achieved Rate" (0.787) in the other, whose actual fully-achieved rate is 0.128, the
worse of the two, dropped for want of a matching key. The table painted the worse account
green at 78.7% "fully achieved". Rule 3 of ADR-013 ("numbers are computed") was necessary
and insufficient; ADR-013 now carries 3b, alignment must be proven, and 3c, the prompt
gets the computed table.

Also landed here: account-unique metrics are kept instead of dropped (measured, they are
59 of 88 metrics across two real accounts -- mostly extraction key drift, e.g.
`environmentIssue` vs `environmentIssues`); `lists` survives into the artifact instead of
being lost entirely; totals are suppressed when reporting windows are incommensurate;
window length is computed from the dates because `period.days` is ACTIVE days (a 23-day
window arrives carrying `days: 10`); value formatting moved to `shared/kpi-format.ts` so
the number the model quotes always matches the number the UI renders; and the CLI's
`usage` block is logged instead of discarded, so the next pass measures instead of
estimating.

Cross-account synthesis payload is now ~88% smaller (30,477 -> 3,619 bytes measured on
two real accounts) AND better: the model no longer aligns blobs itself, the
key/label/window mapping is at the top rather than scattered, conflicts are declared, and
the prompt is built from the same assembled roll-up that is persisted -- so the model
cannot reason over a different table than the user sees.

Deliberately NOT done here, each filed separately: the report.html -> digest replacement
(3.46x input reduction and it lets the KPI pass drop `--allowedTools Read` entirely, which
matters because that pass currently holds filesystem read authority while consuming
model-generated HTML -- an injection-to-exfiltration shape held apart only by prompt
text); pinning the KPI taxonomy plus read-side canonicalisation; the render-side trend
defects (cumulative-window arrows, percent deltas shown as relative instead of
percentage-point, first-appearance metrics rendered as unchanged); and the CLI levers.

Two CLI findings worth keeping: `--allowedTools` does NOT unload tool schemas from context
-- `--tools` is the flag that does, so both headless calls silently pay for the entire
default toolset on every invocation. And `spawnClaudeHeadless` uses `shell: true`, which
concatenates argv without quoting, so an empty argument VANISHES and the preceding flag
swallows the next one; `--tools ""` cannot be passed safely until the spawner quotes.
Separately, a headless `claude -p` auto-loads CLAUDE.md and its `@AGENTS.md` import from
the resolved cwd -- about 2,300 tokens on every call, unmeasured until now.

Prompt caching is a dead end in this invocation model, recorded so nobody re-derives it:
Claude Code's own system-prompt/project-context layers do cache across separate processes
in the same cwd, but the app's payload is the first USER message of a fresh conversation
and the CLI exposes no way to place a cache breakpoint inside it. Reordering the template
earns nothing.

Gate: 3415 unit tests pass (36 new), typecheck clean. Still not exercised in the running
app; the desktop check and the ADR-009 adversarial pass remain outstanding.
