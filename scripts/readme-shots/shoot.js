// README capture runner — runs ON the test VM, in its interactive session.
//
// Launches the INSTALLED app with a debugging port, attaches over CDP, then for
// each shot: navigates, lets the UI settle, and records N frames at a fixed
// interval into an APNG (the reference README's format — animated, 1600x1100).
// Frames are captured with page.screenshot(clip) so the output is exactly the
// app window at exactly the size asked for, regardless of the desktop.
//
// Usage on the VM:  node shoot.js <shot-list.json>
// Every path is forward-slash; this file crosses machines.

const { chromium } = require('playwright-core')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const UPNG = require('upng-js')

const EXE = 'C:/Users/user/AppData/Local/Programs/AI Code Conductor/AI Code Conductor.exe'
const OUT = 'C:/Users/user/ccc-cap/out'
const PORT = 9333
const W = 1600
const H = 1100
const log = (m) => { const l = new Date().toISOString() + ' ' + m; console.log(l); fs.appendFileSync('C:/Users/user/ccc-cap/shoot.log', l + '\n') }

fs.mkdirSync(OUT, { recursive: true })

async function attach() {
  log('spawning app')
  const child = spawn(EXE, ['--remote-debugging-port=' + PORT], { detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    try { return await chromium.connectOverCDP('http://127.0.0.1:' + PORT) } catch { /* not up yet */ }
  }
  throw new Error('app never came up on the debug port')
}

function mainPage(browser) {
  const pages = browser.contexts().flatMap((c) => c.pages())
  const p = pages.find((x) => /out\/renderer\/index\.html/.test(x.url()))
  if (!p) throw new Error('renderer page not found: ' + pages.map((x) => x.url()).join(' | '))
  return p
}

/**
 * The window size is set BEFORE launch by writing the app's own
 * window-state.json (Electron's CDP does not expose Browser.setWindowBounds).
 * The frameless window IS the viewport, so a WxH window is a WxH capture.
 * Here we only confirm what we got.
 */
async function sizeWindow(page) {
  await page.waitForTimeout(600)
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  log('viewport: ' + JSON.stringify(vp))
  return vp
}

async function recordApng(page, name, frames, intervalMs, clip) {
  const bufs = []
  for (let i = 0; i < frames; i++) {
    const png = await page.screenshot({ type: 'png', clip, omitBackground: false })
    bufs.push(png)
    await page.waitForTimeout(intervalMs)
  }
  // Decode each PNG to RGBA and re-encode the set as one APNG.
  const rgba = []
  let w = 0, h = 0
  for (const b of bufs) {
    const img = UPNG.decode(b)
    w = img.width; h = img.height
    rgba.push(UPNG.toRGBA8(img)[0])
  }
  const delays = new Array(rgba.length).fill(intervalMs)
  // cnum 0 = lossless. Frames of a mostly-static UI compress well.
  const apng = UPNG.encode(rgba, w, h, 0, delays)
  const file = path.join(OUT, name + '.png')
  fs.writeFileSync(file, Buffer.from(apng))
  log(`wrote ${name}.png ${w}x${h} frames=${rgba.length} ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`)
}

/** One click by data-testid, aria label, or text — whatever the shot list names. */
async function act(page, step) {
  if (step.click) {
    const loc = page.locator(step.click).first()
    await loc.waitFor({ state: 'visible', timeout: 15000 })
    await loc.click()
  }
  if (step.hover) await page.locator(step.hover).first().hover()
  if (step.key) await page.keyboard.press(step.key)
  if (step.type) await page.keyboard.type(step.type, { delay: 40 })
  if (step.wait) await page.waitForTimeout(step.wait)
  if (step.eval) await page.evaluate(step.eval)
}

;(async () => {
  const list = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  const browser = await attach()
  const page = mainPage(browser)
  await page.waitForTimeout(8000) // splash → app
  const vp = await sizeWindow(page)
  const clip = { x: 0, y: 0, width: Math.min(W, vp.w), height: Math.min(H, vp.h) }

  for (const shot of list.shots) {
    log('--- ' + shot.name + ' ---')
    try {
      for (const step of shot.steps || []) await act(page, step)
      await page.waitForTimeout(shot.settle ?? 1500)
      const sc = shot.clip || clip
      await recordApng(page, shot.name, shot.frames ?? 24, shot.interval ?? 120, sc)
    } catch (e) {
      log('SHOT FAILED ' + shot.name + ': ' + (e && e.message))
      try { await page.screenshot({ path: path.join(OUT, shot.name + '.FAILED.png') }) } catch { /* ignore */ }
    }
  }
  log('done')
  await browser.close()
  process.exit(0)
})().catch((e) => { log('ERR ' + (e && e.stack)); process.exit(1) })
