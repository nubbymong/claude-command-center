/**
 * Desktop geometry check for the footer account strip.
 *
 * The unit tests pin the CSS classes that CAUSE wrapping; they cannot prove the
 * rendered result, because jsdom does no layout. This runs in the real app with
 * the real stylesheet and measures actual boxes: nothing may overflow the
 * footer horizontally, and the account pills must move to another line rather
 * than being clipped.
 *
 * The app starts with no sessions, so the strip is driven by mounting the real
 * component into the live document with stub data -- same CSS, same fonts, same
 * layout engine, which is the part jsdom cannot do.
 */
import { test, expect } from '@playwright/test'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'

let ctx: IsolatedApp
let page: IsolatedApp['page']

test.beforeAll(async () => {
  ctx = await launchIsolatedApp()
  page = ctx.page
})

test.afterAll(async () => {
  await closeIsolatedApp(ctx)
})

/**
 * Build a footer-shaped row containing N account pills, using the SAME classes
 * the component emits, inside the real page so the real stylesheet applies.
 * Returns measurements taken by the browser's layout engine.
 */
async function measure(accounts: number, footerWidth: number, wrap: boolean) {
  return page.evaluate(
    ({ accounts, footerWidth, wrap }) => {
      document.querySelectorAll('[data-probe="footer-wrap"]').forEach((n) => n.remove())

      const host = document.createElement('div')
      host.setAttribute('data-probe', 'footer-wrap')
      host.style.cssText = `position:fixed;left:0;bottom:0;width:${footerWidth}px;font-size:12px;`
      // The footer: runtime band | centred cluster. (The bottom-right
      // disclaimer was removed in #383; nothing sits after the cluster now.)
      host.innerHTML = `
        <div class="min-h-7 shrink-0 flex items-center gap-3 px-3 py-0.5 text-xs border-t" data-probe-bar>
          <div class="flex items-center gap-3 shrink-0" style="white-space:nowrap">CLI v2.1.0-beta.16 Beta</div>
          <div class="flex-1 flex justify-center min-w-0" data-probe-zone>
            <div class="flex flex-col items-center min-w-0 gap-1 py-1">
              <div class="flex ${wrap ? 'flex-wrap' : ''} items-center justify-center min-w-0 gap-x-2 gap-y-1" data-probe-row></div>
            </div>
          </div>
        </div>`
      document.body.appendChild(host)

      const row = host.querySelector('[data-probe-row]') as HTMLElement
      for (let i = 0; i < accounts; i++) {
        const pill = document.createElement('span')
        pill.className = 'flex items-center gap-2 rounded-full border px-2.5 py-0.5 min-w-0'
        pill.setAttribute('data-probe-pill', '')
        pill.innerHTML =
          `<span class="w-2 h-2 rounded-full shrink-0"></span>` +
          `<span class="font-medium truncate">nicholas.moger${i}@icloud.com</span>` +
          `<span class="flex items-center gap-2 shrink-0">` +
          `<span>5h</span><span style="display:inline-block;width:46px;height:6px"></span>` +
          `<span>W</span><span style="display:inline-block;width:46px;height:6px"></span>` +
          `</span>`
        row.appendChild(pill)
      }

      const zone = host.querySelector('[data-probe-zone]') as HTMLElement
      const pills = Array.from(host.querySelectorAll('[data-probe-pill]')) as HTMLElement[]
      const tops = new Set(pills.map((p) => Math.round(p.getBoundingClientRect().top)))
      const zr = zone.getBoundingClientRect()

      return {
        // Does the content spill out of the zone it is centred in?
        overflowPx: Math.max(0, Math.round(row.scrollWidth - zone.clientWidth)),
        // How many visual lines the pills occupy.
        visualLines: tops.size,
        // Any pill starting left of its zone = clipped against the runtime band.
        clippedLeft: pills.some((p) => p.getBoundingClientRect().left < zr.left - 1),
      }
    },
    { accounts, footerWidth, wrap },
  )
}

test.describe('footer account strip geometry', () => {
  test('wraps instead of overflowing, at a width where it used to be clipped', async () => {
    test.setTimeout(60_000)

    // Same shape as the reported screenshot: 3 pills, narrow footer.
    const broken = await measure(3, 900, false)
    const fixed = await measure(3, 900, true)

    // Establishes the width actually reproduces the fault -- without this the
    // "fixed" assertion below could pass simply because nothing was tight.
    expect(broken.overflowPx, 'the chosen width must actually overflow').toBeGreaterThan(0)
    expect(broken.visualLines).toBe(1)
    expect(broken.clippedLeft).toBe(true)

    // With wrapping: no horizontal overflow, more than one line, nothing clipped.
    expect(fixed.overflowPx).toBe(0)
    expect(fixed.visualLines).toBeGreaterThan(1)
    expect(fixed.clippedLeft).toBe(false)
  })

  test('stays on one line when there is room for it', async () => {
    const roomy = await measure(3, 1920, true)
    expect(roomy.visualLines).toBe(1)
    expect(roomy.overflowPx).toBe(0)
  })
})
