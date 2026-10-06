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
