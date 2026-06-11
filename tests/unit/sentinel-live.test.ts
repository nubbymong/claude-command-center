/**
 * Opt-in live sentinel analysis test — exercises the REAL `claude -p` end-to-end.
 *
 * GATED: set CCC_LIVE_SENTINEL_TEST=1 to enable.
 * CI and normal `npm run test` runs skip this entirely (no token cost).
 *
 * Pattern mirrors tests/integration/hooks/real-claude.test.ts.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { runAnalysis } from '../../src/main/sentinel/sentinel-analysis'
import { spawnClaudeHeadless } from '../../src/main/claude-headless'
import { fetchChangelog, sliceChangelog } from '../../src/main/sentinel/sentinel-changelog'

const FIXTURE_CHANGELOG = `## 9.9.9

- Added new model claude-imaginary-9 at $42 input / $84 output per 1M tokens
- The statusline JSON field model.display_name was renamed to model.displayLabel
`

const RESOURCES_DIR = path.join(__dirname, '..', '..', 'resources')
const MANIFEST_JSON = fs.readFileSync(
  path.join(RESOURCES_DIR, 'sentinel-assumption-manifest.json'), 'utf-8'
)
const REGISTRY_JSON = fs.readFileSync(
  path.join(RESOURCES_DIR, 'model-registry.json'), 'utf-8'
)

describe.skipIf(!process.env.CCC_LIVE_SENTINEL_TEST)(
  'sentinel live: real claude -p analysis',
  () => {
    it(
      'runAnalysis returns ok=true with at least one finding for the fixture changelog',
      async () => {
        const r = await runAnalysis({
          runner: (args, timeoutMs, stdin) => spawnClaudeHeadless(args, timeoutMs, stdin),
          changelog: FIXTURE_CHANGELOG,
          manifestJson: MANIFEST_JSON,
          registryJson: REGISTRY_JSON,
          from: '9.9.8',
          to: '9.9.9',
        })

        console.log('[sentinel-live] runAnalysis result:', JSON.stringify(r, null, 2))

        expect(r.ok).toBe(true)
        if (!r.ok) return   // narrow type

        expect(Array.isArray(r.findings)).toBe(true)
        expect(r.findings.length).toBeGreaterThan(0)

        console.log(`[sentinel-live] Findings count: ${r.findings.length}`)
        for (const f of r.findings) {
          console.log(
            `  [${f.severity}] ${f.kind}: ${f.title}\n    evidence: ${f.evidence}`
          )
        }
      },
      240000
    )

    it(
      'fetchChangelog returns content with ## <semver> headings (changelog format validation)',
      async () => {
        const raw = await fetchChangelog(15000)
        if (!raw) {
          console.warn('[sentinel-live] fetchChangelog returned null — offline, skipping format check')
          return
        }

        const firstTwoLines = raw.split('\n').slice(0, 2).join('\n')
        console.log('[sentinel-live] fetchChangelog first 2 lines:\n', firstTwoLines)

        // sliceChangelog should extract at least one versioned section from a real file
        // Use a very old version as lastSeen so we pick up at least one recent entry
        const sliced = sliceChangelog(raw, '0.0.0', '9999.9.9')
        console.log(
          `[sentinel-live] sliceChangelog extracted ${sliced.length} chars; ` +
          `first 120 chars: ${sliced.slice(0, 120)}`
        )

        const headingPattern = /^## v?\d+\.\d+\.\d+/m
        expect(headingPattern.test(sliced)).toBe(true)
      },
      30000
    )
  }
)
