// Probes and fake CLIs never act on a real home.
//
// The plain-node entry of the home guard in home-guard-core.mjs (the vitest entry is
// home-isolation.ts; the core lists what the guard covers and what it does not).
// Start a probe or fake CLI with it preloaded and with a fresh environment built by
// isolatedProbeEnv(root):
//
//   import { isolatedProbeEnv } from '<repo>/tests/helpers/probe-guard.mjs'
//   spawnSync(process.execPath, ['--import', pathToFileURL('<repo>/tests/helpers/probe-guard.mjs').href, 'probe.mjs'],
//     { env: isolatedProbeEnv(myMkdtempFolder) })
//
// (On Windows `--import` needs a file: URL or a ./relative path, not C:\...)
// isolatedProbeEnv also puts the preload in NODE_OPTIONS, and every spawn from a
// guarded process adds it to the child's NODE_OPTIONS, so node children and
// grandchildren load this file too; it removes itself from the child's own view of
// NODE_OPTIONS. Inside a guarded process the covered fs and spawn calls aimed at a
// real home throw TEST_ISOLATION_VIOLATION, and a refusal the process swallows still
// makes it exit non-zero. Importing this module installs the guard in the importing
// process too, so an orchestrator that imports it for isolatedProbeEnv cannot hand
// a child the inherited environment either.
import { installHomeGuard } from './home-guard-core.mjs'

installHomeGuard({ entry: 'probe' })

export {
  PROBE_GUARD_URL,
  VIOLATION_CODE,
  drainViolations,
  isolatedProbeEnv,
  isolatedRoot,
  isRealHomePath,
  realHomeRoots,
} from './home-guard-core.mjs'
