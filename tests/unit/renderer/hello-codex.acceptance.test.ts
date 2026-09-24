import { describe, it } from 'vitest'

// Acceptance criteria for the Hello Codex introduction (WP2 commit 6
// renderer), written before the page is built: docs/wp2/hello-codex-spec.md,
// "Acceptance criteria". Each pending case becomes a real test in commit 6,
// after the owner has reviewed the mockup on the Agent Canvas. Nothing here
// runs yet; the file keeps the criteria next to the code that will meet them.

describe('Hello Codex: when it shows', () => {
  it.todo('AC1: due when Codex is enabled, discovered and compatible, with one active signed-in account; not due when any of these is missing')
  it.todo('AC2: an adopted external sign-in that is still unverified, as the only account, does not make it due')
  it.todo('AC3: inside onboarding, the helloCodex page follows codexSignIn and is skipped when its when() is false')
  it.todo('AC4: outside onboarding, the first snapshot that makes it due shows the takeover once, after the boot gates and any open dialog')
})

describe('Hello Codex: seen once, replayable', () => {
  it.todo('AC5: Done, Skip, Escape and "Start a Codex session" each write helloCodexSeenVersion; it never shows again, upgrades included')
  it.todo('AC6: a replay from the Feature Guide or Settings shows it and leaves the stamp unchanged')
})

describe('Hello Codex: the pages', () => {
  it.todo('AC7: Hello, Accounts, Launch and resume, Code review, Differences, in that order, counted "N of 5"; arrow keys and dots move between them')
  it.todo('AC8: the first page and the launch page say Codex sessions and reviews run on this computer only in this release')
  it.todo('AC9: the review page shows the Claude-review line only when claude_review ships in the build')
  it.todo('AC10: "Start a Codex session" opens New session with the Codex card selected')
})

describe('Hello Codex: presentation and copy', () => {
  it.todo('AC11: semantic tokens only (no hard-coded colours); renders in the dark and light themes')
  it.todo('AC12: no em dashes and no emoji in the copy; no \\u{} escapes in the JSX')
  it.todo('AC13: focus lands on the primary button on entry; reduced motion cuts pages instead of sliding')
  it.todo('AC14: the Feature Guide and app-knowledge entries (commit 7) say what the pages say: local only, the reviewer default, confirming an existing sign-in each launch')
})
