// Runs the native-module (better-sqlite3) unit tests under Electron-as-Node so
// the test runtime's ABI matches the electron-rebuilt binary. Plain `vitest run`
// executes under system Node, whose NODE_MODULE_VERSION differs from Electron's,
// which makes `require('better-sqlite3')` throw ERR_DLOPEN_FAILED. Setting
// ELECTRON_RUN_AS_NODE=1 and launching the Electron binary as a Node runtime
// gives us the matching ABI with no second build and no display server.
//
// Usage: node scripts/run-native-tests.mjs [extra vitest args / file filters]
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
// `require('electron')` returns the path to the electron executable when not
// running inside Electron itself.
const electronExe = require('electron')
const vitestEntry = resolve(process.cwd(), 'node_modules/vitest/vitest.mjs')
const configPath = resolve(process.cwd(), 'vitest.native.config.ts')
const passthrough = process.argv.slice(2)

const result = spawnSync(
  electronExe,
  [vitestEntry, 'run', '--config', configPath, ...passthrough],
  {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  },
)

process.exit(result.status ?? 1)
