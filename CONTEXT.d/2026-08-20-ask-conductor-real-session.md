## 2026-08-20 -- Ask Conductor becomes a real session, filed apart

Built the UI half of Ask Conductor against the owner-approved canvas
(`Ask Conductor docked panel` v5). The prompt plumbing already existed
(`ce40b706`: `askPrompt` -> `pty:spawn` -> `CCC_ASK_PROMPT`, launch line carries
only the env reference, `buildClaudeLaunchCommand.askPrompt` is a BOOLEAN);
everything here is the renderer half plus the retirement of the old path.

### The shape decision

An Ask session is a REAL interactive session with its own tab, not a modal. A
modal has nowhere to host the TUI, so it would have to shell out to `claude -p`
-- one-shot, no resume, no session identity. A bare positional prompt starts the
ordinary interactive session with that prompt submitted, so resume, history and
account switching come for free.

It carries NO saved config. The old `FeatureGuidePage.ask()` created and
PERSISTED a `TerminalConfig` labelled "Ask Conductor" into the user's Saved
Configs, because launching a session was the only mechanism the app had.

Three options were weighed for "a session with no config":

- ephemeral synthetic config passed to `useLaunchConfig`, never stored --
  REJECTED: leaves a dangling `configId` that round-trips to disk and lands in a
  dead zone (`LogTree` files it as neither live nor orphan; `groupSessions`
  buckets it as orphaned; `githubAutoDetectAccept` would `updateConfig()` a
  ghost id);
- a reserved magic config id -- REJECTED, same failure modes plus a magic string
  every `configId` predicate must learn;
- CHOSEN: no `configId` at all, plus a `kind?: 'ask'` discriminator on `Session`.

`kind` is required because `configId == null` is NOT a marker for Ask: the
add-account login shell, the re-auth shell and a resumed project folder are all
config-less already. Every existing `configId` dereference was checked and all
tolerate `undefined`.

### Fences (each mutation-tested, i.e. reverting it turns a test red)

- `kind` IS in `buildSessionState`'s allowlist, or a restored Ask session comes
  back as an ordinary config-less session -- same silent-drop class as the
  `loggingEnabled` / `detachable` bugs.
- `askPrompt` is NOT in that allowlist. That omission is the entire mechanism
  keeping the user's typed question out of `session-state.json` and out of the
  next launch. The test also asserts the question text appears nowhere in the
  serialized state under any key.
- `markSessionForResumePicker` is never called on an Ask launch. BOTH resume-
  picker branches of `buildClaudeLaunchCommand` return before `promptArg` is
  appended, so routing the launch through the picker would drop the question
  with no error and every existing test still green.
- `useRestartSession.forceRemount` clears `askPrompt`. It merges the CAPTURED
  session over the live one, so without an explicit clear a restart re-submits
  whatever the user first typed. Verified: removing the line turns the test red.
- Ask sessions are pinned `sessionType: 'local'`, `provider: 'claude'`,
  non-shell -- the SSH path never sets `CCC_ASK_PROMPT` and Codex ignores it.

### UI

- Docked pill at the BOTTOM of the sidebar, below a divider, sibling of the
  session scroller (the only `flex-1` child) so it stays pinned. The Ask session
  is split out of `sessions` ONCE, at the store read, rather than at each of the
  four bucketing expressions -- missing any one would show it twice or lose it.
  The collapsed rail gets an icon-only variant.
- The tab wears the app monogram instead of an identity dot, via one `TabGlyph`
  helper so the normal and inline-rename branches cannot drift apart.
- The session header renders a banded Ask variant: monogram, fixed title, one
  line naming what it knows, and "Past discussions" (which is just `restart()`
  -- that already marks the session for the resume picker, so it is the ordinary
  path, not a second mechanism). The right-hand cluster, including the account
  chip, is shared with every other session.
- Entry points: docked pill, footer button, the Feature Guide's Ask box, and
  Discuss on any tip modal. All route through one `launchAskConductor()`, which
  FOCUSES an open Ask session rather than starting a second, and hands a
  question to a running one by writing it to the PTY (the env route is
  spawn-time only).
- `help:workspace` fails closed to `null`; the old code returned silently there,
  so the button did nothing. The reason now surfaces in the dock -- the one
  surface on screen for every entry point.

### Knowledge

- The staged `CLAUDE.md` preamble no longer tells the session to refuse anything
  outside the curated docs. It now covers two subjects explicitly: the Conductor
  (from `app-knowledge.md`) and Claude Code itself (from its own knowledge, with
  the official docs as the fallback when unsure), and is required to say which
  of the two it is describing. It is also told it cannot see the user's code and
  must say so rather than guess.
- New `ask-conductor` section in `app-knowledge.ts` (feeds both the Feature
  Guide search and the staged doc), a `CARDS_21` What's New card, and changelog
  entries -- it shipped in v2.0.0 as "Ask Command Center" and had never had one
  under its current name.

### Decisions taken, and what was NOT done

- **No keyboard shortcut.** The design named `Ctrl+/`, but that already toggles
  the GitHub panel (a hard-coded `window` keydown listener in `GitHubPanel`,
  invisible to the Settings conflict checker) and a tip teaches it, so both
  handlers would fire on one press. Owner's call: ship the four click entry
  points and decide the chord later.
- **The orphaned config is left alone.** Installs that used the old path still
  carry a saved config pointing at the help folder (some still labelled "Ask
  Command Center"). It still works; deleting stored user config silently was not
  taken unilaterally. One click removes it.
- **Live access to Sentinel / Logs (book of work item 10) is NOT built.** The
  refusal rule that made it useless is gone, but giving the session real tools
  over app data is a new surface and needs its own design and ADR-009 pass.

### Still required before merge

ADR-009 adversarial pass over the whole PR batch -- it touches `pty-manager`,
the `pty:spawn` IPC schema, argv/env construction and canvas ownership. Bound
the round count and file scope before dispatching.
