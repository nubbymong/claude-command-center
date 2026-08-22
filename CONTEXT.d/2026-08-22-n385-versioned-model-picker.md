# 2026-08-22 — #385 versioned models back in the pickers, and guarded

## The bug

`resources/model-registry.json` had five `dropdown` rows (the family aliases)
while `models` carried the versioned ids. Both pickers rendered `dropdown`
verbatim (`modelsFromRegistry`, `src/shared/model-registry.ts`), so **Opus 4.6
could not be selected at all** even though the registry knew it and
`pty-handlers.ts` already accepted versioned ids on the command line. The launch
path was never broken — the picker had simply lost the versions.

## What changed

**Rows are derived now (option (c) from the issue).** `buildModelPickerRows()`
in `src/shared/model-registry.ts` returns the curated **alias** rows from
`dropdown` first, under a `Latest` group, then a **pinned** row per model
derived from `models`, grouped under its family:

```
Latest    Opus · Opus 1M · Fable 5 · Sonnet · Haiku
Opus      Opus 5 · Opus 4.8 Fast · Opus 4.8 · Opus 4.7 · Opus 4.6 · Opus 4.5
Fable     Fable 5
Sonnet    Sonnet 5 · Sonnet 4.6 · Sonnet 4.5
Haiku     Haiku 4.5
```

Deriving the pins from `models` is what satisfies the acceptance criterion that
a Sentinel/user overlay entry appears with **no code change** — `mergeRegistry`
puts it in `models` and it shows up on the next render. All three consumers use
it: the footer popover (`SessionStatusStrip`, sections), and the two `<select>`s
(`SessionDialog`, `AgentTemplateDialog`) via `<optgroup>`.

New `ModelEntry` fields: `pickable: false` (a matcher, not a launchable id —
`codex-family`) and `articleExempt: true` (carried deliberately though the
article does not list it — `claude-opus-4-8-fast`).

**Registry caught up with the article**: added `claude-opus-5`,
`claude-sonnet-5`, `claude-opus-4-5`, `claude-sonnet-4-5`, and moved each family
alias onto the newest member (`opus`/`opus[1m]` → `claude-opus-5`, `sonnet` →
`claude-sonnet-5`). The release gate had been **refusing** every cut since #375
because four article models were missing; it passes now (10/10 covered).

## Traps hit

- **`onModel` dispatched on `si === 0`.** With one model section that worked;
  with five it would have written `/model` for the effort rows. It now compares
  against `modelGroups.length`.
- **`getPricingWithSource` took the FIRST prefix key, not the longest.** Keys
  collapse by dropping the trailing version, so `claude-opus-5` → `claude-opus`,
  which prefixes `claude-opus-4-8-fast-20260601` and priced a Fast model at
  standard Opus rates purely because it now sits earlier in `models`. Registry
  order is a UI concern now, so the loop takes the longest base. There was
  already a test pinning this exact number ("old key order made it $5") — it
  went red, which is how it was found.
- **`shortModelName`/`isModelActive` were family-level only.** A pinned row
  could never show its checkmark, and the `opus` alias row ticked whenever *any*
  Opus ran. Both take an optional registry now and compare version-faithfully;
  a fuzzy `pattern` match is still never trusted for a label (it would claim the
  wrong version). Without a registry the old behaviour is unchanged.

## Quoting (#144, now with versions)

`[1m]` is a POSIX glob character class, so an unquoted `--model opus[1m]` aborts
the whole launch line under zsh. A pinned id can carry it too
(`claude-opus-4-6[1m]`). Audit of every path that builds a command **string**:

| Path | Site | Verdict |
|---|---|---|
| Local (PowerShell / POSIX) | `pty-manager.ts` → `modelFlag` | quoted |
| SSH POSIX remote (+ tmux, quoted twice) | `pty-manager.ts:1487` → `modelFlag` | quoted |
| SSH Windows remote (cmd.exe) | `pty-manager.ts:1461` `--model "${winModelId}"` | double-quoted on purpose — cmd.exe does not strip `'`, and `claude.cmd` strips `"` |
| Sentinel headless (`shell: true`) | `sentinel-analysis.ts` argv array | **was a gap** |

The headless guard's `UNSAFE_ARGV` listed the glob metacharacters `*` and `?`
but not `[` / `]`, so a bracketed id would have been glob-expanded there. Added
— that path cannot quote (argv goes through `shell: true` unquoted), so it now
fails loudly instead.

The existing emission guard only scanned `pty-manager.ts` for one exact
spelling, so a *new* file emitting `--model` was unscanned.
`tests/unit/spawn-model-flag-versioned.test.ts` now walks all of `src/main`.
Verified it can fail: a probe file with `` `--model ${bad}` `` turned it red.

## The two guards (owner's acceptance)

Both run the **same comparison** over the same snapshot,
`resources/claude-code-model-configuration.json` (moved out of
`scripts/fixtures/` so the packaged app can read it):

1. **Sentinel** — `src/main/sentinel/sentinel-models.ts`, wired into
   `sentinelStartupCheck()` **before** the `claude --version` probe so it still
   runs when Claude Code is unavailable. Pure, no network: every networked
   Sentinel input has to degrade to "analysis unavailable" offline, and a guard
   that silently stops running is not a guard. Reports missing models, models
   the article dropped, and the snapshot itself as stale after 90 days.
   Severity `warn`, never `high` — neither case breaks a running session, and
   `high` would light the alarm dot every launch.
2. **Release gate** — `scripts/release-gate.mjs` (the #375 gate), unchanged in
   shape; it just reads the moved snapshot and honours `articleExempt`.

The gate is dependency-free ESM that runs before `npm ci`, so it keeps its own
copy of the logic. `tests/unit/model-coverage-parity.test.ts` runs both over ten
shared fixtures and requires identical verdicts, so the two cannot drift.

## Left for the owner

- **`efforts` omitted on the four new entries.** The support article documents
  no effort levels at all, so rather than guess I left them absent — the
  registry contract says absent = unknown = all levels valid (spec §3), which is
  exactly today's behaviour. If Claude Code's `/effort` list per model is known,
  fill them in and the UI will gate on it automatically.
- **Per-model effort gating is live but data-driven.** `buildEffortRows` marks
  unsupported levels `disabled` (greyed, not hidden) using each entry's existing
  `efforts`. Today that only bites Haiku 4.5 (no `xhigh`/`max`/`ultracode`) and
  Opus 4.6 / Sonnet 4.6 (no `ultracode`). Answers the issue's open question
  "does the effort list change per model?" visibly and reversibly.
- **Two pre-existing `fallbackPricing` numbers look wrong** against Anthropic's
  published rates: `claude-opus-4-6` is 15/75 (published 5/25) and
  `claude-haiku-4-5` is 0.8/4 (published 1/5). Left untouched — changing them
  moves tokenomics totals and is not this issue. Worth a separate look.
- **A pinned 1M variant is not offered.** Only `opus[1m]` exists today; whether
  the CLI accepts `claude-opus-4-6[1m]` is unverified, so no such row is
  invented. The quoting handles it if one ever appears.
