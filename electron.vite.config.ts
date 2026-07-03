import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Bake the full package version (incl. any -beta.N suffix) into the main
    // process so the updater knows its exact prerelease build (numbered-beta
    // detection). Mirrors the renderer define below.
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
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
      rollupOptions: {
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
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
