## 2026-10-06 -- WP2 PR 4: fix pass 13, three review-thread findings (#625, #628)

Fix pass 13 (d3700924, cdde4930, a588c142), each fix with tests red before it
(15 new tests; 11 mutants, 11 red): a linked legacy account record that is
present but cannot be stored leaves its account, link and open conflicts as
they were; the record of which assistant a session's MCP credential went to
lasts for one launch, so a revived Ask tab is served its own assistant's tools;
the account memory listing gives only paths the memory channels take (one
shared bound). Its spec and quality reviews and the ADR-009 delta pass (the
Conductor MCP server and the memory channel bound) PASS (below); the SSH live
matrix (it changes `pty-manager.ts`) is owed.

Fix pass 13c (859bb49c, 36229fd5): the memory channels and the account listing
apply one path check in one unit, and the late exit of a replaced process
leaves the next launch's MCP record alone; 9 new tests, 5 mutants, 5 red.

Also in fix pass 13c (0ee4f1c1, 8a6fdf2a and the jsdom range): jsdom is held at
30.0.x (`~30.0.1`) while CI and the release workflow run Node 20, and the vision
teardown test waits for the exit it asserts (30 of 30 runs; 3 mutants, 3 red).
The reviews of fix pass 13 and of the fixes after it PASS; the SSH live matrix
is still owed.
