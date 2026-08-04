/**
 * Visual test for the tips system. Launches the built Electron app,
 * seeds a config to show a session header, then iterates through every
 * tip in the library and screenshots the modal.
 *
 * Usage: npx tsx scripts/test-tips-visually.ts
 */

import { _electron as electron } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

const BUILT_APP = path.join(__dirname, '..', 'out', 'main', 'index.js')
const OUTPUT_DIR = path.join(__dirname, '..', '.tip-screenshots')
const PLATFORM_SUFFIX = process.platform === 'darwin' ? '-mac' : '-win'

// Seed + launch against a throwaway data root (never the user's real one), the
// same shape data-paths.ts derives from CCC_E2E_DATA_DIR: data root = <root>,
// resources = <root>/resources. The launch passes CCC_E2E_DATA_DIR=<root> so
// the app reads exactly what we seed here — and that also gates the boot splash
// out (with CCC_FORCE_SPLASH pinned off) so app.firstWindow() is the main window.
const DATA_ROOT = path.join(os.tmpdir(), `ccc-tips-test-${process.pid}`)

function getConfigDir(): string {
  return path.join(DATA_ROOT, 'resources', 'CONFIG')
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  // Seed a minimal config so session header appears
  const configDir = getConfigDir()
  fs.mkdirSync(configDir, { recursive: true })

  const backupSuffix = '.tip-test-bak'
  const files = {
    'configs.json': [{ id: 'test-config', label: 'Test Session', workingDirectory: os.homedir(), model: '', color: '#89B4FA', sessionType: 'local', shellOnly: true }],
    'settings.json': { localMachineName: 'TipTest', terminalFontSize: 14, updateChannel: 'stable', showTips: true },
    'app-meta.json': { setupVersion: '99.99.99', lastTrainingVersion: '99.99.99', lastWhatsNewVersion: '99.99.99', lastSeenVersion: '99.99.99', hasCreatedFirstConfig: true },
    'usage-tracking.json': { features: {}, tipsShown: {}, tipsDismissed: {}, tipsActed: {} },
  }

  const backedUp: string[] = []
  for (const [filename, data] of Object.entries(files)) {
    const fp = path.join(configDir, filename)
    if (fs.existsSync(fp)) {
      fs.copyFileSync(fp, fp + backupSuffix)
      backedUp.push(fp)
    }
    fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  }

  try {
    console.log('[tips-test] Launching app...')
    // Point the app at the throwaway root we seeded; CCC_FORCE_SPLASH pinned
    // off so the splash is gated out and firstWindow is the main window.
    const app = await electron.launch({ args: [BUILT_APP], env: { ...process.env, NODE_ENV: 'production', CCC_E2E_DATA_DIR: DATA_ROOT, CCC_FORCE_SPLASH: '0' } })
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1280, height: 800 })
    await window.waitForTimeout(5000)

    // Dismiss any modals
    for (let i = 0; i < 4; i++) { await window.keyboard.press('Escape'); await window.waitForTimeout(300) }

    // Launch the test session
    await window.evaluate(() => {
      const btn = document.querySelector('button[title="Launch"]')
      if (btn) (btn as HTMLElement).click()
    })
    await window.waitForTimeout(3000)
    await window.keyboard.press('Escape')

    // Get all tip IDs from the library
    const tipIds = await window.evaluate(() => {
      // @ts-ignore
      return (globalThis.__TIPS__ || []).map((t: any) => t.id)
    })

    // Fallback: load from the library directly via DOM import doesn't work easily.
    // We'll iterate by forcing each tip through the store.
    // Parse the library file to extract tip id + requires/excludes for each tip
    const libraryFile = path.join(__dirname, '..', 'src', 'renderer', 'tips-library.ts')
    const libraryContent = fs.readFileSync(libraryFile, 'utf-8')

    // Crude parse: split by `{` blocks that start with an id
    const tipBlocks: Array<{ id: string; requires: string[]; excludes: string[] }> = []
    const idRegex = /id:\s*'(tip\.[^']+)'/g
    let match
    while ((match = idRegex.exec(libraryContent)) !== null) {
      const id = match[1]
      const blockStart = match.index
      // Find the end of this tip's object (next `id:` or end of file)
      idRegex.lastIndex = match.index + match[0].length
      const nextMatch = idRegex.exec(libraryContent)
      idRegex.lastIndex = match.index + match[0].length
      const blockEnd = nextMatch ? nextMatch.index : libraryContent.length
      const block = libraryContent.slice(blockStart, blockEnd)

      const requiresMatch = block.match(/requires:\s*\[([^\]]*)\]/)
      const excludesMatch = block.match(/excludes:\s*\[([^\]]*)\]/)
      const parseList = (s: string) => Array.from(s.matchAll(/'([^']+)'/g), m => m[1])
      tipBlocks.push({
        id,
        requires: requiresMatch ? parseList(requiresMatch[1]) : [],
        excludes: excludesMatch ? parseList(excludesMatch[1]) : [],
      })
    }

    console.log(`[tips-test] Found ${tipBlocks.length} tips to screenshot`)

    for (const { id: tipId, requires, excludes } of tipBlocks) {
      // Build feature state that satisfies requires but NOT excludes
      const features: Record<string, { firstSeenAt: number; lastUsedAt: number; count: number }> = {}
      for (const r of requires) {
        if (!excludes.includes(r)) {
          features[r] = { firstSeenAt: Date.now() - 1000, lastUsedAt: Date.now() - 1000, count: 1 }
        }
      }

      await window.evaluate(([id, feats]: [string, any]) => {
        const store = (window as any).__TIPS_STORE__
        if (!store) return
        store.setState({
          currentTipId: id,
          silencedUntilRestart: false,
          tracking: {
            features: feats,
            tipsShown: { [id]: Date.now() },
            tipsDismissed: {},
            tipsActed: {},
          },
        })
      }, [tipId, features] as any)
      await window.waitForTimeout(300)

      // Click the tip pill in the session header to open the modal
      const pillClicked = await window.evaluate(() => {
        const btns = document.querySelectorAll('button[title="Click for details"]')
        if (btns.length > 0) { (btns[0] as HTMLElement).click(); return true }
        return false
      })

      if (!pillClicked) {
        console.log(`[tips-test] WARNING: no tip pill visible for ${tipId}`)
        continue
      }
      await window.waitForTimeout(500)

      const fname = `${tipId.replace(/\./g, '_')}${PLATFORM_SUFFIX}.jpg`
      await window.screenshot({ path: path.join(OUTPUT_DIR, fname), type: 'jpeg', quality: 85 })
      console.log(`[tips-test] Saved: ${fname}`)

      // Close modal by clicking on backdrop (outside modal content)
      await window.evaluate(() => {
        const backdrop = document.querySelector('.fixed.inset-0.bg-black\\/60')
        if (backdrop) {
          const rect = backdrop.getBoundingClientRect()
          // Click on backdrop but outside modal (top-left corner)
          const evt = new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 })
          backdrop.dispatchEvent(evt)
        }
      })
      await window.waitForTimeout(300)
    }

    await app.close()
  } finally {
    // Restore backups (vestigial now the seed goes to a throwaway root, but
    // harmless), then drop the throwaway root entirely.
    for (const [filename] of Object.entries(files)) {
      const fp = path.join(configDir, filename)
      const bp = fp + backupSuffix
      try {
        if (fs.existsSync(bp)) { fs.copyFileSync(bp, fp); fs.unlinkSync(bp) }
        else if (fs.existsSync(fp)) fs.unlinkSync(fp)
      } catch {}
    }
    try { fs.rmSync(DATA_ROOT, { recursive: true, force: true }) } catch {}
  }

  console.log(`\n[tips-test] Done. Screenshots in ${OUTPUT_DIR}`)
}

main().catch((err) => {
  console.error('[tips-test]', err)
  process.exit(1)
})
