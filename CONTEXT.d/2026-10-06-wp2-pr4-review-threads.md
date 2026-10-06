## 2026-10-06 -- WP2 PR 4: fix pass 13, three review-thread findings (#625, #628)

Fix pass 13 (f8f94a2b, c2510849, ba2c7524), each fix with tests red before it
(15 new tests; 11 mutants, 11 red): a linked legacy account record that is
present but cannot be stored leaves its account, link and open conflicts as
they were; the record of which assistant a session's MCP credential went to
lasts for one launch, so a revived Ask tab is served its own assistant's tools;
the account memory listing gives only paths the memory channels take (one
shared bound). Owed: its spec and quality reviews, the ADR-009 delta pass (the
Conductor MCP server and the memory channel bound) and the SSH live matrix (it
changes `pty-manager.ts`).

Fix pass 13c (ad9289dc, b6548f2b): the memory channels and the account listing
apply one path check in one unit, and the late exit of a replaced process
leaves the next launch's MCP record alone; 9 new tests, 5 mutants, 5 red.

Also in fix pass 13c (56a30fc3, 24ce2e7a and the jsdom range): jsdom is held at
30.0.x (`~30.0.1`) while CI and the release workflow run Node 20, and the vision
teardown test waits for the exit it asserts (30 of 30 runs; 3 mutants, 3 red).
The reviews of fix pass 13 and of the fixes after it PASS; the SSH live matrix
is still owed.
