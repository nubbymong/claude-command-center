## 2026-08-28 -- vite 8 + electron-vite 6-beta: paired build-toolchain upgrade

Dependabot's vite 7->8 bump (#531) failed at `npm ci`: electron-vite@5 peer-pins
vite ^5||^6||^7. vite 8 needs electron-vite >=6, which exists only as
6.0.0-beta.1 -- so this is a PAIRED upgrade, done deliberately instead.

What vite 8 actually changes (understood, not assumed): the build ENGINE.
Rolldown replaces Rollup for bundling, Oxc replaces esbuild for transforms,
Lightning CSS for CSS minify. Renamed option: build.rollupOptions ->
build.rolldownOptions (adopted in electron.vite.config.ts, 3 sites). Output now
carries rolldown-runtime chunks. Default browser targets raised (Chrome 111 /
Safari 16.4). Node floor 20.19+ (CI's node-version '20' resolves >=20.19, fine).

Verified in worktree: typecheck clean; production build green incl. ALL FOUR
main-process entries the app forks at runtime (index, hooks-host,
transcripts-worker, tokenomics-worker); full unit suite 8822 passed -- identical
to beta. NOT yet exercised: dev-mode HMR, e2e, the packaged app -- a build-engine
swap regenerates every shipped byte, so the desktop-tested gate applies FOR REAL
(no skip-desktop-test), plus a packaged-build smoke on the VM before merge.

Process notes:
- electron-vite pinned EXACT (6.0.0-beta.1) while it is a beta; dependabot will
  propose 6.0.0 stable when it lands.
- The "no \u{...} escapes in JSX" convention STAYS: esbuild is gone from the
  vite path but the rule's other grounds hold and Oxc's behaviour is untested;
  revisit deliberately, not as a side effect.
- Master test process (aicc_planning #20) gains the rule: build-toolchain
  changes mandatorily trigger the human/VM pack.
