/**
 * E2E for the #487 logging/disk fix — the STALE-DIR SWEEP half of the
 * helpers/electron-app.ts teardown hardening.
 *
 * #487's disk symptom was leaked isolated data dirs accumulating FOREVER: a run
 * whose teardown could not fully remove its mkdtemp dir (a node-pty shell still
 * holding a handle on Windows) left the multi-GB dir behind, and nothing ever
 * cleaned it up — one run's leak became permanent, and they piled up. The fix
 * added `sweepStaleTempDirs()`: at the first `launchIsolatedApp` in a test
 * process it removes any `ccc-e2e-*` dir in the OS temp root older than 1h,
 * so a leaked dir survives at most one run instead of forever — while leaving
 * a RECENT dir (an in-flight run's live data dir) untouched.
 *
 * This spec proves both halves of that behaviour, deterministically (pure fs —
 * no process/PTY timing to race):
 *
 *   - A pre-existing `ccc-e2e-*` dir with an OLD mtime (simulating a leak from a
 *     crashed prior run) is GONE after launch — the sweep removed it.
 *   - A pre-existing `ccc-e2e-*` dir with a CURRENT mtime SURVIVES — the age
 *     guard must never nuke a run's live data dir.
 *
 * Both fixture dirs are created at MODULE LOAD (before any test body runs), and
 * the beforeAll RE-ARMS the once-per-process sweep latch
 * (rearmStaleSweepForTest) before its own `launchIsolatedApp`. That re-arm is
 * load-bearing: Playwright loads spec files lazily, so when this file shares a
 * worker with earlier specs, an earlier spec's first launch consumed the
 * once-per-process sweep BEFORE this module was even loaded — the stale fixture
 * then post-dated the only sweep that would ever run and survived (exactly the
 * full-suite failure seen on the VM matrix). Re-arming after the fixtures exist
 * makes THIS spec's launch perform the sweep, deterministically, whether the
 * spec runs alone or mid-suite.
 *
 * CREDIBILITY (mutation-verified): commenting out the `sweepStaleTempDirs()`
 * call in launchIsolatedApp makes the OLD dir SURVIVE the launch → the first
 * assertion fails. Verified — see the PR notes / CONTEXT.d fragment.
 *
 * WHY NOT the process-tree-kill teardown assertion (attempted, deliberately not
 * shipped): the fix's other half is a `taskkill /T` process-tree kill so a
 * surviving node-pty shell can't hold the dataDir open. That is NOT credibly
 * reliable as an in-window e2e on Windows: shell-only sessions spawn PowerShell
 * under ConPTY (useConpty:true), which reparents the shell out of Electron's
 * process tree, and whether the dataDir is freed after teardown is dominated by
 * the RACE between the orphaned shell's natural death (when the pseudoconsole
 * tears down) and the rmSync window — not deterministically by tree-kill vs
 * root-only kill. Measured directly: with the shell idle it flipped
 * pass/leak across runs on BOTH the fixed and the reverted teardown; pinning
 * the shell alive made BOTH clean. No configuration failed reliably on old AND
 * passed reliably on the fix, so any such assertion would be flaky — worse than
 * none. That path stays covered by the harness itself (the sweep here catches
 * whatever a racy teardown leaves) and by the run-over-run absence of leaked
 * dirs.
 *
 * WHY NOT an in-app app.log ROTATION assertion (unit-only): driving the real app
 * across the 10MB MAX_LOG_SIZE cap in a single test window is not achievable in
 * a credible runtime, and the unbounded-growth failure shape needs a long-lived
 * ORPHANED window to appear — exactly what an in-window e2e cannot create.
 * Rotation on a hot long-lived stream, the synchronous-burst rotation race,
 * single-record truncation, the uncaughtException re-entrancy guard and
 * stream-error reopen are all covered, mutation-verified, in
 * tests/unit/main/debug-logger-epipe-loop.test.ts.
 *
 * Windows-only: the leak this sweep backstops is the Windows PTY-handle case,
 * and this repo's e2e runs on Windows.
 */
import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  launchIsolatedApp,
  closeIsolatedApp,
  rearmStaleSweepForTest,
  IsolatedApp,
} from './helpers/electron-app'

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

// Created at MODULE LOAD so they exist before this spec's beforeAll launch —
// the sweep that launch performs (see the re-arm below) must post-date them.
const rand = Math.random().toString(36).slice(2, 8)
// A leaked dir from a "prior crashed run": old mtime → the sweep must remove it.
const staleDir = path.join(os.tmpdir(), `ccc-e2e-STALE-${rand}`)
// A recent dir (an in-flight run's live data dir): the sweep must keep it.
const freshDir = path.join(os.tmpdir(), `ccc-e2e-FRESH-${rand}`)

try {
  // Give the stale fixture some content (mirrors a real leaked data dir) so the
  // sweep is exercised on a non-empty tree, then age its mtime past the 1h cap.
  fs.mkdirSync(path.join(staleDir, 'debug'), { recursive: true })
  fs.writeFileSync(path.join(staleDir, 'debug', 'app.log'), 'x'.repeat(4096))
  const old = Date.now() - TWO_HOURS_MS
  fs.utimesSync(staleDir, old / 1000, old / 1000)

  fs.mkdirSync(freshDir, { recursive: true })
  fs.writeFileSync(path.join(freshDir, 'marker'), 'live')
} catch {
  /* creation failure surfaces as a missing-precondition assertion below */
}

let ctx: IsolatedApp

test.beforeAll(async () => {
  test.setTimeout(120_000)
  // The sweep is once per worker PROCESS, and an earlier spec sharing this
  // worker may have consumed it before this module (and its fixtures, seeded
  // at module load above) existed. Re-arm the latch so the launch below is the
  // one that sweeps — the fixtures demonstrably pre-date it.
  rearmStaleSweepForTest()
  ctx = await launchIsolatedApp()
})

test.afterAll(async () => {
  try {
    await closeIsolatedApp(ctx)
  } catch {
    /* already closed */
  }
  for (const d of [staleDir, freshDir]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      /* best effort */
    }
  }
})

test('sweeps a stale leaked e2e data dir on launch, keeps a recent one (#487)', async () => {
  test.skip(process.platform !== 'win32', 'the leak this sweep backstops is the Windows PTY-handle case')

  // Precondition: the fresh fixture was created.
  expect(fs.existsSync(freshDir), 'fresh fixture dir was not created').toBe(true)

  // The stale, >1h-old leaked dir must have been swept by sweepStaleTempDirs()
  // at this spec's beforeAll launch (re-armed above, so it sweeps even when an
  // earlier spec in the same worker already consumed the once-per-process pass).
  expect(
    fs.existsSync(staleDir),
    `stale leaked dir was NOT swept (still present): ${staleDir}`,
  ).toBe(false)

  // The recent dir must be untouched — the age guard must never remove a run's
  // live data dir.
  expect(
    fs.existsSync(freshDir),
    `recent dir was wrongly swept (age guard failed): ${freshDir}`,
  ).toBe(true)

  // Desktop-gate evidence: the app running normally after the sweep.
  await shot(ctx.page, '01-app-running-after-stale-sweep')
})

// ───────────────────────────────────────────────────────────────── helpers

/** Capture desktop-gate evidence: write the PNG to the test output dir AND
 *  attach it by path (shows inline in the report). */
async function shot(p: IsolatedApp['page'], name: string): Promise<void> {
  const file = test.info().outputPath(`${name}.png`)
  await p.screenshot({ path: file })
  await test.info().attach(name, { path: file, contentType: 'image/png' })
}
