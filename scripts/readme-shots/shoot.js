// README capture runner — runs ON the test VM, in its interactive session.
//
// Attaches over CDP to the INSTALLED app that stage/launch.js started on a
// seeded staging root, then for each shot: navigates, lets the UI settle, and
// records N frames at a fixed interval into an APNG (the reference README's
// format: animated, 1600x1100). Frames are captured with
// page.screenshot(clip) so the output is exactly the app window at exactly the
// size asked for, regardless of the desktop.
//
// Usage on the VM, from the checkout (playwright-core and upng-js from the
// runner's own install, e.g. NODE_PATH=<runner>/node_modules):
//   CCC_STAGE_ROOT=<root> node scripts/readme-shots/shoot.js <shot-list.json>
//
// It starts nothing itself (P4.11 review C-4): it refuses unless the staging
// root passes stage/stage-root.js's rules and launch.js's record for it names
// the port of an app started on that root's data folder, so it can never
// drive an app running on the operator's real environment. Before attaching
// it checks that the recorded pid is still the app launch.js started and that
// it holds the recorded port (P4.11 review). Images go to <root>/out, the log
// to <root>/shoot.log (CCC_SHOOT_OUT / CCC_SHOOT_LOG move them, inside the
// root only).
//
// A shot list that has "scan" steps needs the operator's deny list (private
// names, kept outside the repo; stage/scan-text.js): without it the run
// refuses before attaching. Any step that cannot do what it names throws, so
// that shot is logged as SHOT FAILED and written as <name>.FAILED.png.

const { chromium } = require('playwright-core')
const fs = require('fs')
const UPNG = require('upng-js')
const path = require('path')
const S = require('./stage/stage-root')
const SCAN = require('./stage/scan-text')

const REPO = path.resolve(__dirname, '..', '..')

let STAGE, LAUNCH, PATHS
try {
  STAGE = S.resolveStage(process.env)
  S.ensureMarker(STAGE.ROOT, { create: false })
  LAUNCH = S.readLaunchRecord(STAGE)
  PATHS = S.shootPaths(STAGE, process.env)
  S.checkLaunchedApp(LAUNCH)
} catch (e) {
  if (e instanceof S.StageRefusal) { console.error('refusing: ' + e.message); process.exit(2) }
  throw e
}

const OUT = PATHS.OUT
const LOG = PATHS.LOG
const PORT = LAUNCH.port
const W = 1600
const H = 1100
const log = (m) => { const l = new Date().toISOString() + ' ' + m; console.log(l); fs.appendFileSync(LOG, l + '\n') }

fs.mkdirSync(OUT, { recursive: true })

async function attach() {
  log(`attaching to the app launch.js started on ${STAGE.DATA} (pid ${LAUNCH.pid}, port ${PORT})`)
  for (let i = 0; i < 90; i++) {
    try { return await chromium.connectOverCDP('http://127.0.0.1:' + PORT) } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000))
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
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, vis: document.visibilityState }))
  log('viewport: ' + JSON.stringify(vp))
  return vp
}

async function recordApng(page, name, frames, intervalMs, clip) {
  const bufs = []
  for (let i = 0; i < frames; i++) {
    // scale 'css': exactly the clip's size in pixels on a desktop at any DPI.
    const png = await page.screenshot({ type: 'png', clip, omitBackground: false, scale: 'css' })
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

// ---- In-page steps. Each runs alone in the page (no helpers), and THROWS
// when it cannot do what it names, so the shot fails instead of looking fine.

/** Pick the option of a <select data-testid> whose value or text contains `match`. */
function pickOption({ testid, match }) {
  const s = document.querySelector('[data-testid="' + testid + '"]')
  if (!s) throw new Error('no select ' + testid)
  const o = Array.from(s.options).find((x) => x.value.includes(match) || x.text.includes(match))
  if (!o) throw new Error('no option matching "' + match + '" in ' + testid + ': ' + Array.from(s.options).map((x) => x.text).join(' | '))
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value)
  s.dispatchEvent(new Event('change', { bubbles: true }))
  return testid + ' = ' + o.text
}

/** Open the Edit dialog of the config row named `label` (its row's own Edit button). */
function openConfigEdit(label) {
  const rows = Array.from(document.querySelectorAll('[data-testid="config-row"]'))
  const mine = rows.filter((r) => (r.innerText || '').split('\n').map((s) => s.trim()).includes(label))
  const row = mine[mine.length - 1]
  if (!row) throw new Error('no config row "' + label + '" among ' + rows.length)
  const edit = row.querySelector('button[title="Edit"]') || row.querySelector('button[title^="Edit"]')
  if (!edit) throw new Error('no Edit button on "' + label + '"')
  edit.click()
  return 'editing ' + label
}

/** Scroll the visible leaf element whose text starts with `text` to the middle of its scroller. */
function scrollLabelIntoView(text) {
  const el = Array.from(document.querySelectorAll('label, h3, h4, div, span')).find((e) => e.children.length === 0 && e.offsetParent !== null && (e.textContent || '').trim().startsWith(text))
  if (!el) throw new Error('no visible "' + text + '"')
  el.scrollIntoView({ block: 'center' })
  return 'scrolled to ' + text
}

/** Close the open dialog as a user does: its Discard, else its Cancel or Close. */
async function closeOpenDialog() {
  const isOpen = () => Array.from(document.querySelectorAll('[role="dialog"], [data-testid="session-dialog"]')).some((d) => d.offsetParent !== null)
  for (let i = 0; i < 4; i++) {
    if (!isOpen()) return 'dialog closed'
    const b = Array.from(document.querySelectorAll('[role="dialog"] button, [data-testid="session-dialog"] button')).filter((x) => x.offsetParent !== null)
    const pick = b.find((x) => /^(Discard|Discard changes|Don't save)$/i.test((x.textContent || '').trim())) || b.find((x) => /^(Cancel|Close)$/i.test((x.textContent || '').trim()))
    if (pick) pick.click()
    await new Promise((r) => setTimeout(r, 600))
  }
  if (isOpen()) throw new Error('a dialog stayed open')
  return 'dialog closed'
}

/** The Conductor MCP page: wait for the browser to read Connected, pressing its own Start browser once if it reads Stopped. */
async function waitBrowserConnected(ms) {
  const t0 = Date.now()
  let pressed = false
  let last = ''
  while (Date.now() - t0 < ms) {
    const pills = Array.from(document.querySelectorAll('[data-testid="sub-tool-status"]')).map((e) => (e.textContent || '').trim())
    last = pills.join(' | ')
    if (pills.some((p) => /^Connected/i.test(p))) return 'browser ' + last
    const sb = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Start browser' && b.offsetParent !== null)
    if (sb && !pressed && pills.some((p) => /Stopped/i.test(p))) { sb.click(); pressed = true }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('the browser did not read Connected in ' + ms + ' ms (' + last + ')' + (pressed ? ', Start browser pressed' : ''))
}

/** Everything a viewer could read that the DOM holds: the visible text, every title / placeholder / aria-label,
 *  field values, same-origin frames. What it cannot read is counted, never passed: terminals (xterm draws
 *  them), other <canvas> drawings, and frames of another origin (the Agent Canvas page). */
function collectPageText() {
  const texts = [document.body.innerText || '']
  for (const e of document.querySelectorAll('[title], [placeholder], [aria-label], input, textarea')) {
    for (const a of ['title', 'placeholder', 'aria-label']) if (e.getAttribute(a)) texts.push(e.getAttribute(a))
    if (e.value) texts.push(String(e.value))
  }
  let frames = 0
  for (const f of document.querySelectorAll('iframe')) {
    try { texts.push(f.contentDocument.body.innerText || '') } catch { frames++ }
  }
  const vis = (e) => !!(e.offsetParent || e.getClientRects().length)
  const terminals = Array.from(document.querySelectorAll('.xterm')).filter(vis).length
  const drawings = Array.from(document.querySelectorAll('canvas')).filter((c) => vis(c) && !c.closest('.xterm')).length
  return { text: texts.join('\n'), notScanned: { terminals, drawings, frames } }
}

/** The anonymisation scan (stage/scan-text.js): any hit fails the shot. */
async function scan(page, label, deny) {
  if (!deny) throw new Error('scan ' + label + ': no deny list loaded')
  const got = await page.evaluate(collectPageText)
  const hits = SCAN.scanText(got.text, deny.terms)
  const n = Object.keys(hits).length
  const ns = got.notScanned
  const notScanned = [ns.terminals && `${ns.terminals} terminal(s)`, ns.drawings && `${ns.drawings} canvas drawing(s)`, ns.frames && `${ns.frames} cross-origin frame(s)`].filter(Boolean).join(', ')
  log(`scan ${label}: ${got.text.length} chars of page text ${n ? 'HITS ' + JSON.stringify(hits) : 'clean'}; NOT SCANNED: ${notScanned || 'nothing'}`)
  if (n) throw new Error(`scan ${label}: ${n} kind(s) of hit (see the log)`)
}

/** What is on the page now (visible buttons, selects, dialogs, headings): a tool for writing selectors. */
async function dump(page, label) {
  const d = await page.evaluate(() => {
    const vis = (e) => !!(e.offsetParent || e.getClientRects().length)
    const t = (e) => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50)
    const attrs = (e) => ['data-testid', 'data-tour', 'title', 'aria-label', 'role'].map((a) => (e.getAttribute(a) ? a + '=' + e.getAttribute(a).slice(0, 40) : '')).filter(Boolean).join(' ')
    const buttons = Array.from(document.querySelectorAll('button, [role="tab"], a')).filter(vis).map((e) => t(e) + ' {' + attrs(e) + '}')
    const selects = Array.from(document.querySelectorAll('select')).filter(vis).map((e) => (e.getAttribute('data-testid') || '') + ':' + e.value + ' [' + Array.from(e.options).map((o) => o.value + '=' + o.text).join(' | ').slice(0, 400) + ']')
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [data-testid*="dialog"]')).filter(vis).map((e) => t(e))
    const heads = Array.from(document.querySelectorAll('h1, h2, h3')).filter(vis).map(t)
    return { buttons: buttons.slice(0, 140), selects, dialogs, heads: heads.slice(0, 30) }
  })
  log('DUMP ' + label + ' ' + JSON.stringify(d))
}

/** One step. Its keys run in this order: click, hover, move, key, type,
 *  select, editConfig, scrollTo, closeDialog, waitVisionConnected, wait,
 *  eval, evalLog, dump, scan. Targets are any Playwright selector — prefer
 *  data-testid and role/text. */
async function act(page, step, deny) {
  if (step.click) {
    const loc = page.locator(step.click).first()
    await loc.waitFor({ state: 'visible', timeout: 15000 })
    await loc.click()
  }
  if (step.hover) await page.locator(step.hover).first().hover()
  if (step.move) await page.mouse.move(step.move[0], step.move[1])
  if (step.key) await page.keyboard.press(step.key)
  if (step.type) await page.keyboard.type(step.type, { delay: 40 })
  if (step.select) log(await page.evaluate(pickOption, step.select))
  if (step.editConfig) log(await page.evaluate(openConfigEdit, step.editConfig))
  if (step.scrollTo) log(await page.evaluate(scrollLabelIntoView, step.scrollTo))
  if (step.closeDialog) log(await page.evaluate(closeOpenDialog))
  if (step.waitVisionConnected) log(await page.evaluate(waitBrowserConnected, step.waitVisionConnected))
  if (step.wait) await page.waitForTimeout(step.wait)
  if (step.eval) await page.evaluate(step.eval)
  if (step.evalLog) log('evalLog: ' + String(JSON.stringify(await page.evaluate(step.evalLog))).slice(0, 2000))
  if (step.dump) await dump(page, step.dump)
  if (step.scan) await scan(page, step.scan, deny)
}

;(async () => {
  const list = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  // A list that scans refuses to start without the deny list (fail closed).
  let deny = null
  if (list.shots.some((s) => (s.steps || []).some((st) => st.scan))) {
    try { deny = SCAN.loadDenyList(process.env, REPO) } catch (e) { console.error('refusing: ' + e.message); process.exit(2) }
    log(`deny list: ${deny.terms.length} term(s) from ${deny.file}`)
  }
  const browser = await attach()
  const page = mainPage(browser)
  await page.waitForTimeout(8000) // splash → app
  const vp = await sizeWindow(page)
  const clip = { x: 0, y: 0, width: Math.min(W, vp.w), height: Math.min(H, vp.h) }

  for (const shot of list.shots) {
    log('--- ' + shot.name + ' ---')
    try {
      for (const step of shot.steps || []) await act(page, step, deny)
      await page.waitForTimeout(shot.settle ?? 1500)
      const sc = shot.clip || clip
      if (shot.format === 'jpeg') {
        // One frame as <name>.jpg (the Feature Guide's format; quality 85 as the training tool's).
        const file = path.join(OUT, shot.name + '.jpg')
        await page.screenshot({ type: 'jpeg', quality: shot.quality ?? 85, clip: sc, scale: 'css', path: file })
        log(`wrote ${shot.name}.jpg ${sc.width}x${sc.height} ${(fs.statSync(file).size / 1024).toFixed(0)} KB`)
      } else {
        await recordApng(page, shot.name, shot.frames ?? 24, shot.interval ?? 120, sc)
      }
    } catch (e) {
      log('SHOT FAILED ' + shot.name + ': ' + (e && e.message))
      try { await page.screenshot({ path: path.join(OUT, shot.name + '.FAILED.png') }) } catch { /* ignore */ }
    }
  }
  log('done')
  await browser.close()
  process.exit(0)
})().catch((e) => { log('ERR ' + (e && e.stack)); process.exit(1) })
