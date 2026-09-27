# Codex CLI 0.153.4 and 0.155.1 capabilities -- executable probe record (P3.1)

Evidence for `docs/wp2/completion-plan.md` section 8, P3.1: what the two supported Codex CLI versions actually do for the
PR 3 and PR 4 rows that were marked "evidence first". Evidence only; no product code changed.

Each claim is marked with how it was established:

- **[run]**: an executed command with an observed result;
- **[strings]**: read from the CLI binary's strings (config schema, help text, message tables), not executed.

## Environment

| Item | Value |
| --- | --- |
| Host | The Windows test VM (Windows 11, 22621), 2026-09-27 |
| CLIs | Vendor `codex.exe` of the npm packages `0.153.4` and `0.155.1`, each in its own install folder, run directly (no shell, no npm shim) |
| Account | The app-managed realm of a managed ChatGPT account (browser sign-in, Pro plan) |
| No-account probes | Throwaway `CODEX_HOME` folders, a fake API key, a dead proxy (`HTTPS_PROXY=http://127.0.0.1:9`): help, feature list, the TUI's slash-command list, a pre-flight run, the copied-rollout runs. No request left the VM |
| Harness | Node scripts in the session scratchpad (a job runner, a payload logger for notify and hooks, a minimal stdio MCP server, a pseudo-terminal driver); not committed |

Real conversations: **eight**, each a single short prompt, `model_reasoning_effort="low"`, `codex exec` (no TUI
conversation). Runs 1 to 5 had a read-only sandbox and no tools, in a working folder that was empty apart from two probe
skill folders (`.agents/skills/`, `.codex/skills/`). Runs 6 to 8 edited one file in a throwaway folder.

| Run | CLI | Command | Purpose | Input / cached / output tokens reported by `turn.completed` |
|---|---|---|---|---|
| 1 | 0.155.1 | `codex exec --json ...` | fixture; notify, hooks, MCP probe | 15,601 / 12,416 / 105 |
| 2 | 0.155.1 | `codex exec resume <id> --json ...` | resume by id; MCP code words | 32,117 / 27,776 / 111 (whole conversation, see answer 6; the resumed turn alone was 16,516 input) |
| 3 | 0.153.4 | `codex exec --json ... -c developer_instructions=...` | fixture; three delivery channels | 15,544 / 12,288 / 25 |
| 4 | 0.153.4 | `codex exec resume <id> --json ...` | resume by id; MCP code words | 16,379 / 15,360 / 6 (the resumed turn only) |
| 5 | 0.155.1 | `codex exec --ephemeral --json ... -c developer_instructions=...` | developer instructions on 0.155.1 | 13,982 / 0 / 6 |
| 6 | 0.155.1 | `codex exec --json -s workspace-write ...` | one-file edit | 31,352 / 27,776 / 78 (edit refused, see answer 5) |
| 7 | 0.155.1 | `codex exec --json -s danger-full-access ...` | one-file edit | 28,970 / 26,624 / 93 |
| 8 | 0.153.4 | `codex exec --json -s danger-full-access ...` | one-file edit | 30,757 / 27,392 / 62 |

Common flags of runs 1 to 4 and 6 to 8: `--json --skip-git-repo-check -C <folder>`, `-c notify=["node","<logger>","<log>"]`,
`-c hooks.<Event>=[{hooks=[{type="command",command="node <logger> <log>"}]}]` for SessionStart, UserPromptSubmit,
PreToolUse, PostToolUse, Stop and SessionEnd (runs 6 to 8 also PermissionRequest), and `--dangerously-bypass-hook-trust`
(config-defined hooks otherwise wait for trust through the TUI's `/hooks`). Runs 1 to 4 also started the local MCP probe
server with `-c mcp_servers.p31probe...`.

Not used at any point: `codex app-server`, `codex login`, any experimental feature. The realm's `auth.json` is
byte-identical before and after, and the VM's own `~/.codex` is unchanged (6,581 files: 0 added, 0 removed, 0 changed).
The test sessions stay in the realm (see "Test sessions left in the realm").

Fixtures, anonymised (last section): `tests/fixtures/codex/cli/<version>/`.

## Answers

### 1. Does a rollout copied into another realm resume there? (rows 22, 35)

**The local half works on both versions. The server half is not answered.** [run]

- Command, in a throwaway second realm holding a copy of the run-1 rollout (0.155.1) or the run-3 rollout (0.153.4), with
  the fake key and dead proxy: `codex exec resume <session id> --json --skip-git-repo-check "Reply with the single word ok."`
- Observed: `{"type":"thread.started","thread_id":"<the copied session's id>"}`, then `{"type":"turn.started"}`, then only
  the expected connection errors. The CLI found the copy by its id, loaded it and appended the new turn to the copied file
  in place (0.155.1: 66,992 to 78,426 bytes; 0.153.4: 65,381 to 75,881 bytes).
- Folders tested: on 0.155.1, a copy in the same date folder (`sessions/2026/09/27/`) and one in an older folder
  (`sessions/2026/09/20/`); on 0.153.4, the older folder only. The lookup found the copy in each case.
- Not answered: whether OpenAI accepts the conversation under a DIFFERENT account. The rollout carries the model's
  reasoning as opaque `encrypted_content` items, which may be tied to the account that produced them. Answering needs a
  second signed-in Codex account on the VM (an owner action; row 15's disposable test identities). Row 22 stays
  "evidence first" until then; no section 19 record yet.

### 2. Resume by id in the same realm (row 34), and where a resumed rollout is written (row 38)

- [run] `codex exec resume <session id> ...` (runs 2 and 4) resumed by id on both versions, exit 0; run 2 took 9.3 s and
  run 4 took 7.2 s end to end. [strings] The TUI command is `codex resume [SESSION_ID] [PROMPT]` (help, both versions).
- [run] The resumed turn is **appended to the original file, in its original date folder**; no new file is created and
  no second `session_meta` record is written. The resume adds `thread_settings_applied` events: two in the 0.155.1 file,
  one in the 0.153.4 file.
- [run] The rollout file name uses **local time** (`rollout-2026-09-27T12-08-23-<id>.jsonl` for 19:08:23 UTC on a VM set
  to America/Los_Angeles). Local and UTC dates were the same day in these runs, so whether the folder follows the local
  or the UTC date is not proven.
- [run] Hook payloads carry `transcript_path`, the exact rollout file (answer 4), so row 38 can locate a resumed rollout
  by id under `sessions/`, or take the path from a hook, instead of looking only in today's folder.
- [run] The SessionStart hook of a resume says `"source": "resume"`; a new session says `"startup"`.

### 3. Codex's own model, compact and plan commands (rows 41, 61, 69)

[run] Typed into the real TUI through a pseudo-terminal (throwaway home, fake key, dead proxy); the same on both versions:

| Typed | Popup entry |
|---|---|
| `/mo` | `/model  choose what model and reasoning effort to use` |
| `/comp` | `/compact  summarize conversation to prevent hitting the context limit` |
| `/pl` | `/plan  switch to Plan mode` |
| `/sta` | `/status  show current session configuration and token usage`, `/statusline  configure which items appear in the status line` |
| `/re` | `/review`, `/rename`, `/resume  resume a saved chat`, `/recap  summarize the current conversation now` |

- The commands exist on both supported versions. Their effect was not exercised (that needs a TUI conversation).
- [run] Plan mode: neither version has a launch flag for it in `--help`; it is the mid-session `/plan` command.
  Parity with Claude's launch option means sending `/plan` once the session is ready.
- [run] The TUI's start banner reads `model: gpt-6-astra low   /model to change`.

### 4. What `notify` and hooks deliver (rows 43, 46, 47, 63)

- [run] `notify` fired under `codex exec` in run 1, once (one turn); the notify output of the other runs was not
  recorded. It was not observed under the TUI.
  The program receives one JSON argument: `{"type":"agent-turn-complete","thread-id":...,"turn-id":...,"cwd":...,
  "client":"codex_exec","input-messages":[...],"last-assistant-message":...}`. [strings] The notify payload strings of both
  binaries (the same key list) name no other type.
- [run] Hooks, JSON on stdin, both versions. Every event but SessionEnd carries `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, `model` and `permission_mode`; then:
  - SessionStart: `source` (`startup` or `resume`);
  - UserPromptSubmit: `turn_id`, `prompt`;
  - PreToolUse (runs 6 to 8): `turn_id`, `tool_name` (`apply_patch`), `tool_input` (`{"command": "<the
    patch text>"}`) and `tool_use_id`; PostToolUse adds `tool_response` (the tool's exit code, wall time and output);
  - Stop: `turn_id`, `stop_hook_active`, `last_assistant_message`;
  - SessionEnd: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `reason` (no `model`, no `permission_mode`).
- [strings] Hook events both binaries know (their config schema): PreToolUse, PermissionRequest, PostToolUse,
  PreCompact, PostCompact, SessionStart, SessionEnd, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt.
  Handler types: command, mcp_tool, prompt, agent. PermissionRequest was configured in runs 6 to 8 but not observed
  (`codex exec` asks for no approval).
- [run] Configuration: `hooks.<Event> = [{ matcher = ..., hooks = [{ type = "command", command = "..." }] }]` in
  `config.toml` or through `-c`; [strings] a `hooks.json` file is also read. Config-defined hooks run once trusted (the
  TUI's `/hooks`) or for one invocation with `--dangerously-bypass-hook-trust`, which also emits a warning item in the
  `--json` output. How the app enables them is for P3.10 to decide, under its ADR-009 pass, as is the mapping of these
  events to the busy, attention and Watchdog states.

### 5. Line counts (row 36)

**No native line counts; they can be derived from the recorded diff of each edit.**

- [strings] No rollout record type of either version has a line-count field; the only `lines_added`/`lines_removed`
  strings in both binaries belong to the Codex Cloud tasks client. [strings] The TUI status line's own items are model with
  reasoning, total input and output tokens, estimated thread cost and context remaining; no line counts.
- [run] Runs 7 and 8 (one prompt each: "In note.txt, replace the line beta with two lines, delta and epsilon"): both
  versions made the edit with their `exec` tool calling `tools.apply_patch`, and both wrote an `event_msg`
  `item_completed` record whose item is a `FileChange`:
  `{"type":"FileChange","changes":{"<file>":{"type":"update","unified_diff":"@@ -1,3 +1,4 @@\n alpha\n-beta\n+delta\n+epsilon\n gamma\n","move_path":null}},"status":"completed",...}`.
  No `patch_apply_end` or `turn_diff` record was written.
- How to derive: for each `FileChange` in a turn, count the `unified_diff` lines that start with `+` (added) or `-`
  (removed), skipping the `@@` hunk headers; here +2 and -1. The PreToolUse and PostToolUse hooks carry the same patch
  text as `tool_input.command`.
- [run] The `--json` stream's `file_change` item has only `{"path", "kind":"update"}`: a consumer of `codex exec --json`
  cannot count lines from it.
- [run] Run 6 (0.155.1, `-s workspace-write`, with the unelevated Windows sandbox chosen by
  `-c windows.sandbox="unelevated"`) did not edit: the patch tool answered
  `failed to prepare windows sandbox wrapper: windows unelevated restricted-token sandbox cannot enforce split writable
  root sets directly; refusing to run unsandboxed`, and the model reported that no change was made. The writable set was
  the workspace plus two temporary roots, with read-only `.git`, `.agents` and `.codex` entries inside the workspace.
  The CLI's own `codex sandbox` command wrote a file in the same setup. Runs 7 and 8 therefore used
  `-s danger-full-access` in the throwaway folder. Which sandbox the app's Codex sessions use on Windows is outside P3.1.

### 6. Rollout fixtures from real sessions (owed since MP8; rows 18, 25)

- [run] 0.155.1 and 0.153.4, each a new session plus one resumed turn (`rollout-exec-then-resume.jsonl`, 30 and 29
  records) and each an edit session (`rollout-edit.jsonl`); 0.155.1 also the refused edit
  (`rollout-edit-sandbox-refused.jsonl`).
- [run] Record types: `session_meta`, `event_msg:task_started`, `response_item:message` (developer, user, assistant),
  `world_state`, `turn_context`, `event_msg:item_completed`, `response_item:reasoning`, `response_item:custom_tool_call`
  and `custom_tool_call_output` (edit runs), `token_usage_record`, `event_msg:token_count`, `event_msg:task_complete`,
  `event_msg:thread_settings_applied`. Readers must tolerate `world_state`, `token_usage_record` and
  `thread_settings_applied`.
- [run] **Token totals after a resume differ by version:**

  | Field, resumed turn | 0.155.1 | 0.153.4 |
  |---|---|---|
  | `token_count.info.total_token_usage.input_tokens` | 32,117 (whole conversation) | 16,379 (restarts at the resume) |
  | `token_count.info.last_token_usage.input_tokens` | 16,516 | 16,379 |
  | `token_usage_record.turn_token_usage.input_tokens` | 16,516 | 16,379 |
  | `token_usage_record.thread_token_usage.input_tokens` | 32,117 | 31,923 |
  | `codex exec --json` `turn.completed.usage.input_tokens` | 32,117 (whole conversation) | 16,379 (the turn) |

  A reader that takes the latest `total_token_usage` as the session's total undercounts a resumed 0.153.4 session; per-turn
  figures (`last_token_usage`, or `token_usage_record.turn_token_usage`) summed over the file are consistent on both
  versions, and `token_usage_record.thread_token_usage` is cumulative on both.
- [run] `token_count.rate_limits` (both versions): `limit_id` `codex`, `primary` `{used_percent, window_minutes: 10080,
  resets_at}`, `secondary` null, `credits`, `individual_limit`, `spend_control_reached`, `plan_type`,
  `rate_limit_reached_type`.
- Not covered: a subagent rollout (row 27).

### 7. The unit of a credits figure (row 17)

- [run] The account shows credits. Both versions record `"credits":{"has_credits":true,"unlimited":false,
  "balance":"<decimal string, 10 fraction digits>"}` in every `token_count` event: the same fields as the usage read,
  which spells them `hasCredits`, `unlimited`, `balance`.
- [strings] There is no unit field. The CLI's status view prints the balance followed by ` credits` (and, for a
  workspace, `Monthly credit limit` ... ` of ` ... ` credits used`), so the unit is **Codex credits, a count, not money**.
- Row 17 can show "N credits"; the live check is possible on the VM's managed account.

### 8. How MCP instructions or skills reach a Codex session (row 51)

- [run] The Codex MCP client (`clientInfo.name` `codex-mcp-client`) initialises with protocol `2025-06-18` and
  capabilities `experimental.codex/auth-change` and `elicitation` (form, url). It declares **no `roots` capability** and
  answers a server's `roots/list` with `{"roots":[]}`. It calls `tools/list` at startup on both versions.
- [run] MCP server `instructions`: **not delivered**. In runs 2 and 4 the probe server's instructions held a code word
  that existed nowhere else; asked for it, the model answered `none` (fixtures `exec-resume-json.jsonl` and
  `mcp-client-handshake-codewords.jsonl`). The instructions also appear in no recorded context.
- [run] MCP tool descriptions: in the same runs the model answered `none` for a code word that existed only in the probe
  tool's description. [strings] Both versions defer MCP tools behind Codex's tool search (feature
  `tool_search_always_defer_mcp_tools`, fixed on); older rollouts on the VM show `tool_search_call` and
  `tool_search_output` records. A tool is found through search, not listed up front.
- [run] `developer_instructions` (config key, or `-c` at launch): **delivered** on both versions; asked for a code word
  held only there, the model returned it (run 3 on 0.153.4, run 5 on 0.155.1). 0.153.4 records it as the first developer
  message of the rollout; run 5 was ephemeral, so 0.155.1 has no rollout record of it, only the `--json` output
  (`exec-ephemeral-developer-instructions-json.jsonl`).
- [run] Skills: `SKILL.md` folders under the working folder's `.agents/skills/` and `.codex/skills/`, and the realm's
  `skills/`, are listed (name, description, path) in the session's `<skills_instructions>` developer message.
- So Conductor's instructions reach a Codex session through `developer_instructions` or a skill, not through the MCP
  server's instructions; the tools themselves are reachable through Codex's tool search.
- Run 1's answer is not evidence: its prompt contained the marker text itself, and its handshake fixture
  (`mcp-client-handshake.jsonl`) shows the marker-text instructions of that run.

### 9. `codex exec --json` for background agents and the Insights report (rows 57, 68)

- [run] JSONL on stdout: `thread.started {thread_id}`, `turn.started`, `item.started` and `item.completed` with `item:
  {id, type, ...}` (types seen: `agent_message` with `text`, `file_change` with `changes: [{path, kind}]` and `status`,
  and `error` for warnings), `turn.completed {usage: {input_tokens, cached_input_tokens, cache_write_input_tokens,
  output_tokens, reasoning_output_tokens}}`, and `error {message}` while reconnecting. Exit 0 on success; `-o <file>`
  writes the last message.
- [run] `turn.completed.usage` after `exec resume` is the whole conversation on 0.155.1 and the resumed turn only on
  0.153.4 (answer 6). A background agent or Insights run that bills by `turn.completed` must take the version into
  account, or read the rollout's per-turn records.
- [run] Useful flags, both versions (`--help`): `-C <dir>`, `-s <sandbox>`, `--output-schema <file>` (structured output),
  `--ephemeral` (run 5 left the realm's sessions unchanged), `--ignore-user-config`, `--ignore-rules`,
  `exec resume <id>`. 0.155.1 adds `--worktree`.
- [run] `codex exec` prints `Reading additional input from stdin...`; the runner closed stdin.

### 10. Memories and log folders (rows 55, 56)

- [run] Memories are **off by default** on both versions (`codex features list`: `memories  stable  false`); the TUI has
  `/memories  configure memory use and generation`. [strings] When on, the CLI writes `MEMORY.md`, `memory_summary.md`
  and `raw_memories.md` under `<CODEX_HOME>/memories/`, with `[memories]` config keys including `generate_memories` and
  `use_memories`. [run] The realm has `memories_1.sqlite` (tables `consolidation_progress`, `jobs`, `stage1_outputs`;
  `stage1_outputs` empty) and no `memories` folder.
- [run] Logs: the realm's `log/` holds `codex-login.log` (sign-in); [strings] the TUI writes `codex-tui.log` there, and
  `log_dir` moves the folder. [run] The structured log database is `logs_2.sqlite` (table `logs`); `codex exec` wrote
  there, not to a text log.

### 11. The CLI command list, for the artifacts record (row 58)

- [run] `codex --help`, 0.155.1: agents, exec, review, login, logout, mcp, plugin, app-server [experimental],
  remote-control [experimental], app, completion, update, doctor, sandbox, debug, apply, resume, queue, archive, delete,
  migrate-rollouts, unarchive, fork, cloud [EXPERIMENTAL], exec-server [EXPERIMENTAL], features. 0.153.4 has the same
  plus `mcp-server`, and no `--worktree`. On 0.155.1, `codex mcp-server --help` prints the top-level help (the subcommand
  is gone), so `help/mcp-server-help.txt` holds that.
- No artifacts, share or publish command on either version. [strings] The `artifact` feature flag is "under
  development" and off; its strings are an internal thread table and memory-prompt text. [run] The TUI offers `/export`
  (the conversation as markdown) and `/copy`. `codex cloud` is experimental (WP1.41 keeps it off).
- Row 58's artifacts part: no Codex equivalent on the supported versions; the section 19 record stands as planned.

## Rows this affects

| Row | Result |
|---|---|
| 17 | Unblocked: the unit is Codex credits; the managed account shows a balance. |
| 18, 25 | Real rollout fixtures for both versions. Readers must sum per-turn usage: a resumed 0.153.4 session restarts `total_token_usage`. |
| 22, 35 | Local mechanics proven; cross-account acceptance needs a second signed-in account (owner action). |
| 34 | Unblocked: `codex exec resume <id>` / `codex resume <id>` in the same realm. |
| 36 | Unblocked by derivation: count `+`/`-` lines of each `FileChange.unified_diff` in the rollout. No section 19 record needed. |
| 38 | Unblocked: a resume appends to the original file; find it by id or take `transcript_path` from a hook. |
| 41, 61, 69 | `/model`, `/compact`, `/plan` exist on both versions; plan mode has no launch flag. |
| 43, 46, 47, 63 | Hook and notify payloads recorded, including PreToolUse and PostToolUse; PermissionRequest exists but was not observed. |
| 51 | Instructions via `developer_instructions` or a skill; no MCP roots; MCP tools via tool search. |
| 55, 56 | Memory files and log folders located; memories off by default. |
| 57, 68 | `codex exec --json` event stream recorded; resume usage differs by version. |
| 58 | Artifacts: no equivalent (section 19 record). |

## Test sessions left in the realm

Five persisted test sessions (runs 1 and 2 share one file, runs 3 and 4 another, and runs 6, 7 and 8 one each) remain in
the managed realm, because the CLI's thread database indexes them. The app's Codex usage fallback for that account now
finds a last-seen reading, and the resume picker lists them.

## Fixtures and anonymisation

`tests/fixtures/codex/cli/<version>/`: `rollout-exec-then-resume.jsonl`, `rollout-edit.jsonl`, `exec-json.jsonl`,
`exec-resume-json.jsonl`, `exec-edit-json.jsonl`, `hooks/{SessionStart-startup,SessionStart-resume,UserPromptSubmit,
PreToolUse,PostToolUse,Stop,SessionEnd}.json`, `notify-agent-turn-complete.json`, `mcp-client-handshake.jsonl`,
`mcp-client-handshake-codewords.jsonl`, `tui-slash-popup.txt`, `help/*.txt`; 0.155.1 also
`exec-ephemeral-developer-instructions-json.jsonl`, `rollout-edit-sandbox-refused.jsonl` and
`exec-edit-sandbox-refused-json.jsonl`. `ANONYMISED.txt` records the replacement counts and the scan result.

Replaced on the VM before any file left it, consistently across all files:

- UUIDs (session, thread, turn, item and tool-use ids) with `00000000-0000-7000-8000-0000000000NN`;
- prefixed ids (`msg_`, `resp_`, `rs_`, `ctc_`, `ctco_`, `call_` and similar, whether hex, UUID or base62) with
  `<prefix>_p31fixtureNNNNNN`;
- the reasoning `encrypted_content` with `P31-REDACTED-ENCRYPTED-CONTENT`;
- the credit balance with `1250.0000000000`;
- the realm folder, the working folders and the VM user's home with `C:\Users\alex\...` paths and
  `realm-00000000000000000000000000000001` (TUI box lines re-padded after the swap);
- the base instructions text (OpenAI's system prompt, about 21,500 characters) with a one-line note.

Help captures were normalised: a byte-order mark and CRLF line endings removed, and one non-breaking hyphen, mis-decoded
by the capture, written as `-`.

Kept as recorded: model name, plan type, usage percentage and reset time, token counts, timestamps, the VM's time zone,
the prompts (written for the probe), content hashes and catalogue app ids written by Codex itself.

A scan of every output for UUIDs other than the placeholders, emails other than example.com, JWTs, `sk-` keys, base64
and hex runs, user-home paths, host and user names, IPv4 addresses and the known original values found nothing. The
remaining non-ASCII is Codex's own text: em dashes inside a skill description in the recorded context, curly
apostrophes in the model's answers, and the TUI's box drawing and prompt glyphs.
