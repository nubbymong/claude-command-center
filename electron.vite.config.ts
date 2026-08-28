import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { canvasBridgePlugin } from './scripts/vite-plugin-canvas-bridge.mjs'
import { resolveBuildSha, resolveBuildTime } from './scripts/build-identity.mjs'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

// Build identity (#384): the short git sha of the built commit (GITHUB_SHA in
// CI, `git rev-parse` locally, "dev" outside git) and one build timestamp.
// Resolved ONCE here so main and renderer carry identical values — the splash
// (main) and Settings → About (renderer) print the same line from them.
const buildSha = resolveBuildSha({ cwd: __dirname })
const buildTime = resolveBuildTime()

export default defineConfig({
  main: {
    // canvasBridgePlugin resolves virtual:canvas-bridge / virtual:canvas-analysis
    // to the esbuild-bundled in-page scripts ccc-ux:// serves.
    plugins: [externalizeDepsPlugin(), canvasBridgePlugin()],
    // Bake the full package version (incl. any -beta.N suffix) into the main
    // process so the updater knows its exact prerelease build (numbered-beta
    // detection). Mirrors the renderer define below.
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_SHA__: JSON.stringify(buildSha),
      __BUILD_TIME__: JSON.stringify(buildTime),
    },
    build: {
      outDir: 'out/main',
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'hooks-host': resolve(__dirname, 'src/main/services/hooks-host.ts'),
          // Logs v2 transcript-indexing worker (forked by fork-transcripts-worker.ts).
          'transcripts-worker': resolve(__dirname, 'src/main/logging/transcripts-worker.ts'),
          // Tokenomics rebuild: better-sqlite3 indexing worker (forked by fork-tokenomics-worker.ts).
          'tokenomics-worker': resolve(__dirname, 'src/main/tokenomics/tokenomics-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        }
      }
    }
  },
  renderer: {
    plugins: [tailwindcss()],
    root: resolve(__dirname, 'src/renderer'),
    define: {
      __BUILD_TIME__: JSON.stringify(buildTime),
      __BUILD_SHA__: JSON.stringify(buildSha),
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
