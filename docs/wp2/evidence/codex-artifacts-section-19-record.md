# Row 58, the artifacts half: a section 19 record (signed)

**Status:** Signed by the owner on the Agent Canvas, 2026-10-05: alternative A (section 6). Drafted 2026-10-03,
refreshed 2026-10-04 against the PR 4 head `ec2343c0`, and its citations re-checked for this copy on 2026-10-05
against `f6b9a086`. Row 58 (Web sign-in and artifacts), phase P4.6 of the completion plan
(`docs/wp2/completion-plan.md`). The web-session half of row 58 is separate and is not decided here.

**Design section 19** is the approved WP1 design's unsupported-capability escalation: where a shared feature cannot
carry over to Codex, the evidence, the user impact, the alternatives and a recommended decision go to the owner, and
the row stays in scope until the owner signs the record (the completion plan's "How to read it").

**Scope of this record:** Codex CLI 0.153.4 and 0.155.1, the two supported versions, as their Windows x64 npm builds
(the builds the evidence was taken from). The command list is the CLI's own; the macOS and Linux builds were not read.
Also 0.156.1, the newest version the app accepts without a warning (`src/main/providers/codex/cli-contract.ts:14`):
its Windows x64 binary was read as bytes, never run (E6), so its evidence is strings only.

**Decision (signed): alternative A.** Record the gap, add no Codex artifacts item, and say so in the Feature Guide and
the artifacts tip.

## 1. The shared feature

A Claude Code account can publish a page (an artifact) to claude.ai from a session. The page belongs to that account,
so only that account's web sign-in can open it (`src/main/account-web/artifacts.ts:1-12`). The app opens
`https://claude.ai/artifacts` as the session's account: a sandboxed window on that account's own web partition, its
navigation pinned to claude.ai (`artifacts.ts:43-55`, `:65-128`). Three places offer it, all on Claude only:

- a session's right-click menu, "Open artifacts" (`src/renderer/components/sidebar/SessionContextMenu.tsx:251-266`),
  never on a Codex row (`:83-91`);
- the command bar's Artifacts button (`src/renderer/components/CommandBar.tsx:293-312`), shown on Claude tabs only
  (its provider check, `:306`);
- Settings, Accounts, on a Claude account (`src/renderer/components/settings/AccountWebSession.tsx:172`, `:352`).

The Feature Guide (`src/shared/app-knowledge.ts:134`: the button "appears for a Claude session") and the tip
`tip.artifacts-button` (`src/renderer/tips-library.ts:460-472`, carrying Claude Code's mark, `:464`) describe it.

## 2. The question

Does Codex 0.153.4 or 0.155.1 (or 0.156.1, which the app also accepts) have an equivalent: a command, flag or tool
that publishes something from a session to a hosted place owned by the signed-in account, which the user can open
later? If yes, parity settles row 58's artifacts half. If no, design section 19 applies: this record goes to the
owner, and the row stays open until it is signed.

## 3. Evidence

No Codex CLI was run for this record. Everything below was read from files: the P3.1 evidence record
(`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`), the recorded fixtures, and the three binaries read as
bytes. [run] is an executed command, recorded in P3.1; [strings] is text read from a binary that was never run.

**E1. The command list, 0.153.4 and 0.155.1** [run, P3.1]. `codex --help` lists agents, exec, review, login, logout,
mcp, plugin, app-server [experimental], remote-control [experimental], app, completion, update, doctor, sandbox,
debug, apply, resume, queue, archive, delete, migrate-rollouts, unarchive, fork, cloud [EXPERIMENTAL], exec-server
[EXPERIMENTAL] and features; 0.153.4 also has mcp-server. No artifacts, share or publish command on either version.
Source: the P3.1 record, answer 11 (lines 233-243) and its summary row for row 58 (line 409); the recorded output is
`tests/fixtures/codex/cli/<version>/help/help.txt`.

**E2. The `artifact` feature flag, 0.153.4 and 0.155.1** [run, P3.1]. The feature list shows
`artifact  under development  false` (`tests/fixtures/codex/cli/0.153.4/help/features-list.txt:8`,
`tests/fixtures/codex/cli/0.155.1/help/features-list.txt:9`). It is unfinished and off by default, and the app turns
on no experimental or under-development feature (WP1.41).

**E3. What the flag's strings are** [strings, P3.1]. "Its strings are an internal thread table and memory-prompt
text" (answer 11).

**E4. The TUI's own commands** [run, P3.1]. The TUI offers `/export` (the conversation as Markdown) and `/copy`.
Neither publishes anything; both stay on the user's machine.

**E5. The 0.153.4 binary, as bytes** [strings, 2026-10-03]. `codex.exe` from `@openai/codex-win32-x64` 0.153.4
(295,408,944 bytes), read by a script that lists printable runs and never runs the file. 79 distinct runs contain
"artifact", of five kinds: the feature-flag table; a local thread-database table (`thread_artifacts`); telemetry
names (`codex.artifact.operation.started`); helper scripts for file-making skills (presentations, documents,
spreadsheets, pdf); and prompt text using the word in its ordinary sense. None is a command, a slash command, a menu
item or a web address a user opens. Read as strings only, the unfinished feature looks like making files, not
publishing hosted pages; that is an inference from strings, not a tested behaviour. The TUI's slash-command table lists
"copy the last response, code block, or quote" and "export the conversation as markdown"; its export menu reads "Save
the complete conversation as Markdown / Copy the complete Markdown transcript". A search for "/share", "/publish",
"share link", "shareable" and "public link" found no command.

**E6. The 0.155.1 and 0.156.1 binaries, as bytes** [strings, 2026-10-04]. Each `codex.exe` came from its Windows x64
platform package, fetched with `npm pack --ignore-scripts`, its SHA-1 matching the registry's (0.155.1 `9a25edd6`,
0.156.1 `3b222d3a`), and extracted into a scratch folder; nothing was installed or run, and the packages declare no
install script. 0.155.1's is 307,108,144 bytes, the same as the test VM's copy; 0.156.1's is 323,383,088 bytes.
"artifact" runs: 79 and 77, of the same five kinds. From 0.155.1 the thread table is renamed `thread_attachments`, and
a voice transcript cell and an internal developer command that writes JSON Schema files appear; 0.156.1 adds prompt
text only. The `artifact` flag's name is still in 0.156.1's feature table, with no name or description of its own
beside it, unlike the features a user can turn on; its stage needs a run to read. The top-level commands are
0.155.1's plus one internal proxy helper. The slash-command table gains commands, none about sharing, publishing,
uploading, a link or an artifact; `/export` and `/copy` read as before. No "/share", "/publish", "share link",
"shareable" or "public link" command in either.

**E7. `codex cloud`** [run, P3.1]. "[EXPERIMENTAL] Browse tasks from Codex Cloud and apply changes locally", with the
subcommands exec, status, list, apply and diff (`tests/fixtures/codex/cli/0.155.1/help/cloud-help.txt`). It handles
cloud tasks and their diffs, not published pages, and the app keeps it off (WP1.41).

**E8. `codex app`** [run, P3.1]. "Launch the Desktop app (opens the app installer if missing)"
(`tests/fixtures/codex/cli/0.153.4/help/help.txt:21`, `tests/fixtures/codex/cli/0.155.1/help/help.txt:20`). A separate
product: nothing read here shows it publishes pages, and the app does not drive it.

**Conclusion:** Codex 0.153.4 and 0.155.1 have no equivalent of Claude's artifacts, and 0.156.1's binary shows none
either.

## 4. What users lose (Codex)

- A Claude Code session can publish a page that its account owns, which the user opens later from the session, the
  command bar or Settings. A Codex session cannot, so there is no Codex page to open, and a Codex tab gets no "Open
  artifacts".
- What a Codex user still has, all built in PR 4: the Agent Canvas, which Codex sessions now draw on (P4.1), for pages
  to review in the app; the in-app browser pane (P4.2) for a page a session serves; and Codex's own `/export`, which
  saves a conversation as Markdown, and `/copy`.
- Nothing a user has today is taken away. Claude Code's artifacts keep working as they are.
- A separate fault, already fixed whatever was decided here: a Codex tab's right-click menu used to show Claude's
  "Open artifacts", "Authenticate claude.ai..." and "Sign in to Claude Code", acting on the primary Claude account
  (the #216 fallback; P3.6 finding V5). P4.6's first half took all three off a Codex row (`SessionContextMenu.tsx:83-91`;
  the acting account comes from `claudeWebActionProfileId`, `Sidebar.tsx:1614`), pinned by
  `tests/unit/renderer/sidebar-context-menus.test.tsx:135-161`, and the browser pane no longer offers that account's
  claude.ai on a Codex session (`WebviewPane.tsx:74-91`). The 2.1.1 changelog says so (`changelog.ts:55`).
- No security or data effect: the decision adds no window, partition, IPC or network path.

## 5. Alternatives

**A. Record the gap and add no Codex artifacts item (recommended; signed).** Cost: one sentence in the Feature Guide
and one in the artifacts tip, naming Codex's `/export`; both already say, by wording or by mark, that artifacts are
Claude Code's. Re-checked at each new supported Codex version.

**B. A nearby item on a Codex tab instead:** "Export conversation" (typing `/export` into Codex) or "Open
chatgpt.com". Not recommended. Neither is an artifact, so the name would mislead. Typing `/export` would go through
P4.1's submit primitive (`providers/codex/composer-submit.ts`), which handles the composer's known hazards, but
`/export` then opens Codex's own export menu, so the item would save the user one typed command. "Open chatgpt.com" is
what P4.6's Codex web-session item does.

**C. Turn on Codex's `artifact` feature.** Not possible within the rules: it is under development and off on both
versions, the app turns on no such feature (WP1.41), and its strings point to file making, not hosted pages.

**D. Use `codex cloud`.** Not recommended: experimental and kept off (WP1.41), and it handles cloud tasks and diffs,
not pages.

**E. An app-side stand-in** (a Conductor page store that Codex publishes to). Not for 2.1.1: it would be a new
feature, local rather than owned by the account on the web, and it overlaps the Agent Canvas, which both providers
already use.

## 6. Decision: alternative A (signed 2026-10-05)

1. Row 58's artifacts half closes on this record: Codex 0.153.4 and 0.155.1 have no equivalent of Claude's artifacts,
   and 0.156.1's binary shows none.
2. A Codex tab gets no artifacts item. This settles the completion plan's section 9 note ("the artifacts record
   decides the other"): no Codex item replaces "Open artifacts".
3. Claude's account items stay off a Codex tab's menu, as P4.6's first half already has them, pinned by
   `sidebar-context-menus.test.tsx:135-161`. Nothing more to build.
4. The Feature Guide line (`app-knowledge.ts:134`) and the tip `tip.artifacts-button` (`tips-library.ts:460-472`) each
   gain one sentence: in Codex, `/export` saves a conversation as Markdown. P4.11 checks the wording.
5. The parity checklist and the completion plan record row 58's artifacts half as "section 19 record, signed
   2026-10-05".
6. Re-check: when a newer Codex version joins the supported set (0.156.1 too, once its command list and feature
   stages are captured from a run), its command list and feature flags are read again; if `artifact` (or any share or
   publish command) is finished and on by default, parity reopens the row.

## 7. Owner decision

Signed by the owner on the Agent Canvas, 2026-10-05: alternative A, as recommended, with no note. On the canvas,
approving the record counted as signing it.
