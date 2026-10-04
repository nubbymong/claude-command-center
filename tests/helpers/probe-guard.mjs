// Probes and fake CLIs never act on a real home.
//
// The plain-node entry of the home guard in home-guard-core.mjs (the vitest entry is
// home-isolation.ts). Start a probe or fake CLI with it preloaded and with a fresh
// environment built by isolatedProbeEnv(root):
//
//   import { isolatedProbeEnv } from '<repo>/tests/helpers/probe-guard.mjs'
//   spawnSync(process.execPath, ['--import', pathToFileURL('<repo>/tests/helpers/probe-guard.mjs').href, 'probe.mjs'],
//     { env: isolatedProbeEnv(myMkdtempFolder) })
//
// (On Windows `--import` needs a file: URL or a ./relative path, not C:\...)
// Inside the probe every fs mutation, and every spawn whose cwd or home environment
// is inside a real home, throws TEST_ISOLATION_VIOLATION; a refusal the probe
// swallows still makes it exit non-zero. Importing this module installs the guard
// in the importing process too, so an orchestrator script that imports it for
// isolatedProbeEnv cannot hand a child the inherited environment either.
import { installHomeGuard } from './home-guard-core.mjs'

installHomeGuard({ entry: 'probe' })

export {
  VIOLATION_CODE,
  drainViolations,
  isolatedProbeEnv,
  isolatedRoot,
  isRealHomePath,
  realHomeRoots,
} from './home-guard-core.mjs'
