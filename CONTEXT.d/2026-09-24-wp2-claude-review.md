## 2026-09-24 -- WP2 commit 5b: claude_review for Codex sessions

A local Codex session can now ask Claude Code to review its project
(`claude_review`), built to plan.md "Commit 5b" and the owner's three
decisions of 2026-09-24.

### Decisions

- The review runs on a registry account (the Claude reviewer default, else
  the provider default) through a launch the accounts service prepares. A
  package declares which launches it prepares (`launch.kinds`); Claude
  prepares reviews only, so Claude sessions keep their own path (A12).
- The change under review is produced by the main process and sent in the
  prompt. Mode working diffs through a private git dir the app writes, so the
  diffing git reads no repository configuration; only value-only work-tree
  settings (file mode, symlinks, line endings) are carried over. Mode range
  must be a real range (tree against tree).
- `claude_review` is offered to a Codex connection only while a Claude review
  could be prepared now. On macOS it runs on the normal sign-in, the primary
  account, with nothing redirected.
- The reviewer is `claude -p --restricted --strict-mcp-config --tools
  Read,Grep,Glob --output-format json --no-session-persistence`, the request
  on stdin, the account held as a credential consumer for the run.
- Codex sessions now wait up to 1000 s for a Conductor tool: the pinned
  Codex default (300 s) is below a review's length.

### Process

One bounded ADR-009 round (three Opus lenses) plus a confirmation, and an
independent spec-compliance review. Mutation proofs: 78/78 host and 7/7
real-process mutants killed. Real-process suites ran on the disposable
Windows VM, never on the owner's workstation. Windows Defender quarantined one
test file whose appended code looked like a credential stealer to its
heuristics; it was restored from HEAD and the new proof written without that
shape. The pass surfaced one pre-existing finding in shipped code, routed
privately.

### Open

- Defaults the owner may overturn are listed in plan.md "What was built".
- The SSH live matrix is required before merge (commit 4 and this commit
  touch pty-manager).
- The renderer (commit 6) builds the approved Hello Codex design.
