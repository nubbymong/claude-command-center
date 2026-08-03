## 2026-08-03 -- KPI extraction: why 3 of 4 accounts failed, and the ~10x context it was burning (#191)

First real desktop run of the cross-account roll-up, dev instance, 4 accounts. The
cross-account code behaved: 4/4 reports generated, member rows correct, and the aggregate
refused honestly with "Only 1 of 4 accounts produced KPIs". The pre-existing KPI extraction
step is what failed, in two distinct ways, and the usage logging added the previous commit
caught it on its first outing.

- Mode A (aai-se03): `is_error:true`, `duration_api_ms:0`, `num_turns:1`, every token count
  0, exit 1. The API was never reached. Cause still UNKNOWN -- the code logged 500 chars of
  the raw envelope, which is mostly the zeroed usage block, so the reason in `result` never
  surfaced.
- Mode B (severson, aai-se02): `is_error:false`, `stop_reason:end_turn`, 4,788 output
  tokens, **$0.77 each** -- then `parseKpiOutput` returned null and the reply was DISCARDED
  with only 500 chars logged. Nothing left to post-mortem. Cause still UNKNOWN.

Root cause of the cost, measured rather than inferred. A headless `claude -p` loads the
account's whole mirrored global config. On a real profile: **10 MCP servers** (azure,
elasticsearch, m365, cloudflare, atlassian, grafana, kb, codebase-memory, atlassian-admin,
midpage) and **41 skills**. The real run carried `cache_read 134,038 + cache_creation
58,814 = 192,852` context tokens per extraction against a payload of roughly 31k -- about
162k of pure overhead, at $0.77 a call.

Measured with an identical trivial prompt under one profile's HOME:

| invocation | context tokens |
|---|---|
| `--strict-mcp-config` | 41,714 |
| `--strict-mcp-config --tools Read` | **14,395** |

So `--allowedTools` was never the lever -- it only gates the permission prompt. `--tools`
is what decides which tool DEFINITIONS enter context, and the two do different jobs; the
27k between those rows is the default built-in toolset's schemas. Both flags take
single-token values, which is the only reason they can be passed at all (see below). Landed
on both headless calls; `buildKpiSpawnArgs` keeps `--allowedTools Read` because it still
needs the pre-authorisation.

Corrected a wrong inference from the same session, recorded so it does not get re-derived:
the CLI's `Warning: claude.ai MCP server blocked by enterprise policy` line goes to
**stderr**, not stdout. An initial test used `2>&1` and made it look like stdout pollution
was breaking the JSON parse. Verified with separated streams: stdout starts with `{`. That
is NOT the cause of mode B.

What actually changed, none of it claiming to have found mode A or B:

- Failures are now recorded. `kpi-extraction-failure.json` lands beside `report.html` in the
  run's archive with the full stdout, stderr, argv, reason and usage. Paying $0.77 and
  keeping 500 characters was the real defect; the next occurrence is diagnosable.
- `describeClaudeError` pulls the hard-failure reason out of the envelope (`subtype`,
  `result`/`error`, and the `duration_api_ms:0` tell) so mode A will name itself.
- `parseKpiOutput` no longer uses a greedy `/\{[\s\S]*\}/`, which fails outright whenever
  anything after the object contains a `}`. Replaced with a string/escape-aware balanced
  scan over up to 8 candidate opening braces, keeping the LONGEST object that parses, plus
  fence stripping. It may or may not fix mode B -- unknown until the next run.
- Two guards found while testing that change: (1) if the first object never closes the
  reply was truncated, so bail out entirely -- otherwise the scan finds a NESTED complete
  child and writes `{"days":3}` out of a truncated KPI payload as if it were the metrics;
  (2) an envelope recovered from noisy stdout must still be unwrapped, or the CLI's own
  metadata gets written to kpis.json as the metrics. Both are now tested.
- `looksTruncated` distinguishes "cut off" from "no JSON here" in the log line.

Still blocked, and the reason is worth keeping: `spawnClaudeHeadless` uses `shell: true`,
which concatenates argv without quoting (this is the DEP0190 warning the suite prints). An
empty or space-bearing argument vanishes and the preceding flag swallows the next one. That
is why `--tools ""` for the no-tools synthesis pass and
`--settings '{"claudeMdExcludes":...}'` for the 41 skills and the 7KB CLAUDE.md cannot be
passed yet. Both spawn-arg builders now have a test asserting no argument is empty or
contains whitespace, so nobody adds one by accident. Tracked in #197.

Gate: 3443 unit tests pass (28 new), typecheck clean. NOT verified end to end -- whether
mode A and mode B are actually fixed needs another 4-account run.
