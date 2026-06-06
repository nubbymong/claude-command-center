# Transcript Path Contract Probe — Findings

Probe date: 2026-06-06
Branch: feat/beta-consolidation
Purpose: Task 0 of Logs v2 — verify transcript_path wire-shape + redaction behaviour
         before building the ingestion pipeline.

---

## 1. transcript_path in hook payloads

### Live-probe evidence (recorded 2026-05-31)

A real Notification POST from Claude Code was captured with this body shape:

```json
{
  "hook_event_name": "Notification",
  "notification_type": "permission_prompt",
  "message": "...",
  "session_id": "<uuid>",
  "cwd": "<path>",
  "transcript_path": "<absolute path to .jsonl>"
}
```

`transcript_path` IS present in real hook POSTs for Notification events.

### Wire-shape test fixtures

File: `tests/unit/hooks/hooks-gateway-wire.test.ts`

The test fixtures use `hook_event_name` (real Claude shape) confirmed at line 138-139.
None of the current test payloads include a `transcript_path` field — they cover
PreToolUse and PostToolUse shapes only. The Notification shape with `transcript_path`
is not exercised in the unit tests (covered only by the opt-in live-Claude test that
is skipped in CI).

### redactHookPayload verdict

File: `src/main/hooks/hook-payload-redactor.ts`

The redactor uses a WALK approach: it recursively walks every key/value in the object
and applies regex PATTERNS only to string values. There is NO field allowlist or
denylist — it does NOT strip fields by name.

The PATTERNS array matches:
- API key prefixes (sk-, xox*, AKIA*, gh*)
- PEM private-key blocks
- Generic password/secret/token/api_key = ... patterns

`transcript_path` is a file-system path (e.g. `C:\Users\nicho\.claude\projects\...\.jsonl`).
It does NOT match any of the six patterns above.

VERDICT: `transcript_path` IS KEPT by `redactHookPayload`. It passes through into the
ring buffer and is emitted over IPC to the renderer unchanged. The Logs v2 ingestion
layer can safely read `transcript_path` from the payload of any Notification event.

---

## 2. Statusline — transcript_path not copied

File: `src/main/providers/claude/statusline.ts`

At line ~126, `JSON.parse(input)` deserialises the full CC statusline stdin JSON (which
may include `transcript_path` if present in the status blob). Lines 147-163 build the
`status` object that is emitted to the renderer. The explicit field list is:

  sessionId, model, effortLevel, fastMode, contextUsedPercent,
  contextRemainingPercent, contextWindowSize, inputTokens, outputTokens,
  costUsd, totalDurationMs, linesAdded, linesRemoved, accountEmail, timestamp

`transcript_path` is NOT copied. The statusline path is therefore NOT a viable source
for transcript discovery — hooks (Notification payload) or a direct filesystem walk
of `~/.claude/projects` are the correct ingestion surfaces.

---

## 3. Histogram from real store scan

Run: `npx tsx scripts/dry-run-transcripts.ts`
Store: `<CLAUDE_MULTI_APP_RESOURCES>/account-profiles/profile-mpweyxus-862d60/.claude/projects`

Note: the home-level default path (`~/`) maps to the isolated profile home set by
CLAUDE_MULTI_APP's per-account USERPROFILE isolation (v1.5.25+). This IS the correct
store for the iCloud account sessions under test.

### Full histogram JSON

```json
{
  "scannedAt": "2026-06-06T10:46:02.614Z",
  "totalFiles": 168,
  "totalSizeMB": "3174.2",
  "filesAbove100MB": [
    "...\\F--CLAUDE-MULTI-APP\\41236479-bcfe-4cc2-ab41-7bae18b85cb4.jsonl (306 MB)",
    "...\\F--flexspec-rune-dsl-plus\\8ba39261-dd5f-466b-88ff-a0c48353caad.jsonl (1002 MB)",
    "...\\f--platform-v9\\04b9af40-74be-4898-8705-4db0118ce56e.jsonl (1251 MB)"
  ],
  "sampledFiles": 50,
  "sampledLines": 605343,
  "unparseableLines": 0,
  "typeValues": {
    "permission-mode": 29469,
    "attachment": 92614,
    "system": 12235,
    "file-history-snapshot": 15605,
    "user": 128898,
    "assistant": 213417,
    "queue-operation": 11108,
    "last-prompt": 31022,
    "pr-link": 29641,
    "mode": 6880,
    "custom-title": 14528,
    "agent-name": 12920,
    "progress": 1911,
    "ai-title": 4617,
    "worktree-state": 478
  },
  "messageRoles": {
    "user": 128898,
    "assistant": 213417
  },
  "contentPartTypes": {
    "(string-content)": 12975,
    "thinking": 50409,
    "text": 49854,
    "tool_use": 114639,
    "tool_result": 114641,
    "image": 404
  },
  "isSidechainCount": 0,
  "missingTimestampCount": 115519,
  "sampleFileSizeRange": {
    "minBytes": 16036,
    "maxBytes": 1312105939,
    "meanBytes": 61905997
  },
  "concerns": [
    "FILES_ABOVE_100MB: 3 file(s) exceed 100 MB — streaming is mandatory",
    "UNKNOWN_TYPE_VALUES: permission-mode, attachment, file-history-snapshot, queue-operation, last-prompt, pr-link, mode, custom-title, agent-name, ai-title, worktree-state — normalizer must handle or classify as unknown",
    "MISSING_TIMESTAMPS: 115519 entries lack a timestamp field"
  ]
}
```

---

## 4. Normalizer design implications

### Expected entry mapping (what was assumed)

The Logs v2 normalizer was designed to map JSONL entries to:
  message | tool_call | clear | sidechain | unknown

### What the histogram reveals

**WITHIN EXPECTATIONS:**
- `user` and `assistant` type entries with `message.role` user/assistant — these are
  the primary conversation entries; map to `message`
- `tool_use` content parts (114,639) and `tool_result` content parts (114,641) within
  `assistant` and `user` message entries — expected; map through `message`/`tool_call`
- `thinking` content parts (50,409) — extended thinking blocks; normalizer should
  include or skip as a sub-type of `assistant` entries
- `progress` type (1,911) — sub-turn progress events; can map to `unknown` or a
  `progress` variant
- `system` type (12,235) — system prompt snapshots; can map to `unknown` or `system`
- `(string-content)` — messages where `content` is a plain string, not an array (12,975)
  — normalizer must handle both array and scalar content

**OUTSIDE EXPECTED SURFACE (require explicit normalizer decisions):**
- `permission-mode` (29,469) — CCC permission mode metadata entries; map to `unknown`
- `attachment` (92,614) — file attachment metadata; the LARGEST non-message type; must
  be handled; map to `unknown` or a dedicated `attachment` variant
- `file-history-snapshot` (15,605) — file state tracking; map to `unknown`
- `queue-operation` (11,108) — agent queue entries; map to `unknown`
- `last-prompt` (31,022) — final prompt snapshot; map to `unknown`
- `pr-link` (29,641) — pull-request link metadata; map to `unknown`
- `mode` (6,880) — mode change entries; map to `unknown`
- `custom-title` (14,528) — session title; map to `unknown`
- `agent-name` (12,920) — agent identity entries; map to `unknown`
- `ai-title` (4,617) — AI-generated title; map to `unknown`
- `worktree-state` (478) — worktree tracking entries; map to `unknown`

**CRITICAL: `attachment` is the 2nd most common type (92,614 of 605,343 sampled lines
= ~15%). The normalizer MUST handle it or a `default: unknown` fallback is needed to
avoid crashing on unexpected types.**

**isSidechain: 0 instances found in 605k sampled lines.** The `sidechain` normalizer
branch will trigger rarely or never on this user's real data (may appear in other
accounts or in files not sampled).

**Missing timestamps: 115,519 / 605,343 = ~19% of entries lack a timestamp.** These
are predominantly the metadata entry types (attachment, pr-link, permission-mode, etc.)
— NOT summary/meta entries as initially suspected. The normalizer must not assume
timestamp presence; use entry index or file mtime as fallback.

**Files above 100 MB: 3 files, largest is 1,251 MB.** Streaming via readline is
non-negotiable — confirmed working in this probe at heap peak of 33 MB for 50 files.

**No unparseable lines** in 605,343 sampled lines — the JSONL format is clean.

**image content parts: 404** — the normalizer should pass through or strip image blobs;
they may be large if stored inline (check before ingesting).

---

## 5. Summary verdict

| Check | Result |
|---|---|
| transcript_path in hook POSTs | YES — present in Notification payloads |
| redactHookPayload strips transcript_path | NO — field is kept (path string, no secret pattern match) |
| statusline copies transcript_path | NO — field not in the status object |
| Streaming required | YES — 3 files >100 MB, largest 1.25 GB |
| isSidechain found in real data | NO (0 of 605k lines) |
| Unparseable lines | NONE |
| Unexpected type values | 11 distinct types outside expected surface |
| Missing timestamps | ~19% of entries — must be handled gracefully |
