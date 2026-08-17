# ADR-016: The canvas serves the session worktree CCC designates

- Status: Accepted
- Date: 2026-08-17

## Context

Two mandated features collided:

- **Session isolation (ADR-012).** Every agent claims its own git worktree
  (`<parent>/ccc-wt/<id>`) and a `PreToolUse` hook denies writes to the primary
  checkout.
- **Agent Canvas served roots.** `canvas_render { htmlPath }` and UAT `distRoot`
  read files with the app's privileges, so they are confined to an allowlist
  that is *exactly the session's configured project directory* -- the primary
  checkout. Three adversarial reviews (2026-08-11, -14, -15) drove that
  allowlist to where it is: per session, default-empty, realpath'd, floored
  (never home, a volume root, or a dot-directory under home), and derived only
  from the user's configuration -- **never from anything the agent can write**
  (a transcript's cwd, a resume target, a plugin directory).

So an agent that dutifully isolates itself writes its mockup into a directory
the canvas refuses, and is forced to the inline `html` fallback -- the very
form the skill tells it never to use (it floods the approval prompt with the
whole document). Found while dogfooding the canvas for the beta.13 mockups.

## Decision

**CCC designates where the session's worktree lives, tells the guard, and
serves that path -- pending until it really exists.**

1. **Designation is CCC's own computation.** At spawn, `pty-manager` derives
   `<worktree base>/<first 8 of the CCC session id>` from the *configured*
   project directory (`resolveCwd(options.cwd)`, the same value the served root
   uses -- never the transcript-derived launch cwd) and CCC's own session id.
   The base mirrors the guard's default (`<parent of the primary checkout>/
   ccc-wt`, or `CCC_WT_ROOT` from CCC's environment). Only for interactive
   Claude sessions whose project is a primary git checkout (`.git` is a
   directory); otherwise nothing is designated. (`src/main/canvas/canvas-worktree.ts`)
2. **The guard is told, not asked.** The path goes into the PTY environment as
   `CCC_SESSION_WORKTREE`. `session-guard claim` creates the worktree there, or
   adopts the worktree an earlier conversation of the *same CCC session* left
   there (a new `CLAUDE_CODE_SESSION_ID` after `/clear` or a restart). If the
   directory is held by another live session or is not a worktree of this repo,
   the guard falls back to its default location and says the canvas will not
   serve it. Unset outside CCC: nothing changes.
3. **The store treats it as a pending root.** `designateCanvasWorktreeRoot`
   records the lexical path (floor-checked). At resolution it is honoured only
   when it exists, is a real directory whose realpath *is* the designated path
   (an agent that pre-creates it as a junction/symlink to somewhere it wants
   read gets nothing), and passes the floor -- evaluated on every resolution, so
   a directory swapped for a link stops serving immediately. Every candidate
   file is still realpath'd itself, so a link planted inside cannot reach out.
   The designation is per session and revoked with the session, like a live
   root. (`src/main/canvas/canvas-store.ts`)

Rejected alternatives -- both derive a served root from data the agent writes,
the exact class the earlier reviews closed:

- **Serve whatever the guard's lease says.** Leases live in
  `<git-common-dir>/ccc-sessions/*.json`, written by a script the agent runs;
  the agent can write any lease naming any directory.
- **Serve any git worktree of a served root.** `.git/worktrees/*` and a
  worktree's `.git` file are agent-writable; a forged entry names an arbitrary
  directory. Even bidirectional verification only raises the bar to "write one
  file outside cwd", and a served root must not rest on that.
- **A user-configured "extra canvas roots" setting.** Sound (user-authorized)
  and it would also cover other layouts, but it does not make the two mandated
  features work together *out of the box*, and it grants the whole worktree
  base rather than this session's worktree. Still a reasonable follow-up if a
  project needs a served folder that is neither.

## Consequences

- An isolated agent's `htmlPath` and `distRoot` under its own worktree render.
  The skill text now says so.
- What a designated root can ever expose is *files physically under a directory
  CCC named and the agent populated* -- the same trust level as the project
  directory itself. Nothing an agent writes moves the designation; a link at or
  above it disables it; a link inside it is contained.
- Under CCC, a session's worktree is **per CCC session (tile)**, not per Claude
  Code conversation: `/clear` and restarts adopt the same worktree (branch kept;
  uncommitted work reported). Fewer orphaned worktrees. Outside CCC the guard is
  unchanged. Two tiles whose ids share a prefix would collide on the directory;
  the second falls back to the default location and is simply not served.
- Limits: a project configured on a linked worktree or a non-repo gets no
  designation (the guard has nothing to anchor to there either); a session that
  claims elsewhere (a `CCC_WT_ROOT` set only in the agent's shell, an ignored
  hint) is not served -- fail closed, today's behaviour, never misdirected.
  Under a designation `--slug` names only the branch; the directory is CCC's.
- Security-sensitive (served-root allowlist): ADR-009 adversarial pass required
  and recorded on the PR.
