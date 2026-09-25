// @vitest-environment jsdom
/**
 * WP2 commit 6g: the Settings Codex tab is retired. Codex is turned on and
 * off, checked, installed and signed in to from Settings, Accounts (the
 * Providers card's Codex row and the Codex accounts below it).
 *
 *   - the tab list has no Codex tab, and nothing renders one;
 *   - a deep link that still names the retired tab (an app:openSettings
 *     event with tab 'codex') opens Settings, Accounts; a current tab id opens
 *     itself; anything else opens no tab, never a blank page;
 *   - every place that pointed at "Settings -> Codex" (in any spelling) now
 *     points at Settings, Accounts: the launch reason, the review tool card,
 *     the training step, the Codex tip, the Feature Guide and the reply the
 *     code-review tool gives a session that cannot use it. A sweep over the
 *     app source catches any pointer this list forgets.
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveSettingsTab, openSettingsHandler, SETTINGS_TAB_IDS, TabsRail } from '../../../src/renderer/components/SettingsPage'
import { CODEX_OFF_LAUNCH_REASON } from '../../../src/renderer/hooks/useLaunchConfig'
import CodexReviewSubTool from '../../../src/renderer/components/conductor-mcp/CodexReviewSubTool'
import { trainingSteps } from '../../../src/renderer/training-steps'
import { TIPS_LIBRARY } from '../../../src/renderer/tips-library'
import { APP_KNOWLEDGE_SECTIONS } from '../../../src/shared/app-knowledge'

const ROOT = resolve(__dirname, '..', '..', '..')
/** Every old spelling of the pointer: arrows, ">", a comma, "Codex tab". */
const OLD_POINTER = /Settings\s*(?:→|->|>|,)\s*\**\s*Codex\b|\bCodex tab\b/
const NEW_POINTER = 'Settings, Accounts'

describe('the Settings tab list', () => {
  it('has no Codex tab', () => {
    expect(SETTINGS_TAB_IDS as readonly string[]).not.toContain('codex')
    const html = renderToStaticMarkup(<TabsRail activeTab="accounts" onChange={() => {}} />)
    expect(html).toContain('>Accounts<')
    expect(html).not.toMatch(/>Codex</)
  })

  it('SettingsPage renders no Codex tab body (source-level, as custom-commands-tab.test does)', () => {
    const src = readFileSync(resolve(ROOT, 'src/renderer/components/SettingsPage.tsx'), 'utf8')
    expect(src).not.toMatch(/activeTab === 'codex'/)
    expect(src).not.toMatch(/CodexSettingsTab/)
  })
})

describe('a deep link to a Settings tab', () => {
  it('opens a current tab as it is', () => {
    for (const id of SETTINGS_TAB_IDS) expect(resolveSettingsTab(id)).toBe(id)
  })

  it('opens Settings, Accounts for the retired Codex tab', () => {
    expect(resolveSettingsTab('codex')).toBe('accounts')
  })

  it('opens no tab for anything else, prototype names included', () => {
    for (const bad of [undefined, null, 7, {}, ['accounts'], '', 'Codex', 'CODEX', 'nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(resolveSettingsTab(bad), String(bad)).toBeNull()
    }
  })

  it('the app:openSettings listener, driven by real events: the retired tab opens Accounts, a current tab itself, a malformed detail no tab', () => {
    const opened: string[] = []
    let shown = 0
    const listener = openSettingsHandler({ openTab: (t) => opened.push(t), showSettings: () => { shown++ } })
    window.addEventListener('app:openSettings', listener)
    try {
      const fire = (detail?: unknown) => window.dispatchEvent(detail === undefined ? new CustomEvent('app:openSettings') : new CustomEvent('app:openSettings', { detail }))
      fire({ tab: 'codex' })
      fire({ tab: 'github' })
      fire({ tab: 'nope' })
      fire()
      fire({ tab: 7 })
      fire(null)
    } finally {
      window.removeEventListener('app:openSettings', listener)
    }
    expect(opened).toEqual(['accounts', 'github'])
    expect(shown).toBe(6) // Settings opens every time, on no particular tab when none resolves
  })

  it('App registers exactly that listener (source-level: App is the whole app)', () => {
    const src = readFileSync(resolve(ROOT, 'src/renderer/App.tsx'), 'utf8')
    const at = src.indexOf("window.addEventListener('app:openSettings', onOpenSettings)")
    expect(at).toBeGreaterThan(0)
    const handler = src.slice(src.lastIndexOf('const onOpenSettings = ', at), at)
    expect(handler).toMatch(/^const onOpenSettings = openSettingsHandler\(\{ openTab: setPendingSettingsTab, showSettings: \(\) => setView\('settings'\) \}\)/)
  })
})

describe('every pointer to the retired tab now names Settings, Accounts', () => {
  it('the launch reason for a Codex config while Codex is off', () => {
    expect(CODEX_OFF_LAUNCH_REASON).toBe('Codex is off. Turn it on in Settings, Accounts to launch this config.')
  })

  it('the Codex review tool card', () => {
    const html = renderToStaticMarkup(<CodexReviewSubTool />)
    expect(html).toContain('while Codex is on (Settings, Accounts)')
    expect(html).not.toMatch(OLD_POINTER)
  })

  it('the Codex training step', () => {
    const step = trainingSteps.find((s) => s.id === 'codex-provider')!
    expect(step.howToTrigger!.find((h) => h.label === 'Auth')!.value).toBe('Settings, Accounts: add a Codex account')
    expect(step.proTip).toContain(NEW_POINTER)
    expect(JSON.stringify(step)).not.toMatch(OLD_POINTER)
  })

  it('the Codex sessions tip', () => {
    const tip = TIPS_LIBRARY.find((t) => t.id === 'tip.codex-sessions')!
    expect(tip.variants.primary.body).toContain(`**${NEW_POINTER}**`)
    expect(JSON.stringify(tip)).not.toMatch(OLD_POINTER)
  })

  it('the Feature Guide: the Codex section and the troubleshooting section', () => {
    const codex = APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'codex')!
    expect(codex.body).toContain('in Settings, Accounts: sign in with ChatGPT, a device code or an API key')
    for (const s of APP_KNOWLEDGE_SECTIONS) expect(`${s.title} ${s.body}`, s.id).not.toMatch(OLD_POINTER)
    expect(APP_KNOWLEDGE_SECTIONS.some((s) => s.body.includes('check the Codex row in Settings, Accounts'))).toBe(true)
    expect(APP_KNOWLEDGE_SECTIONS.some((s) => s.body.includes('Check sign-in, in an account menu, asks Codex again'))).toBe(true)
  })

  it("the code-review tool's reply to a session that cannot use it (main, source-level)", () => {
    const src = readFileSync(resolve(ROOT, 'src/main/codex-review-mcp-tool.ts'), 'utf8')
    expect(src).toContain('while Codex is on (Settings, Accounts) and Codex review is on (Settings, General, Built-in Tools).')
  })

  it('a sweep of the app source finds no pointer to the retired tab, in copy or in comments', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p, out)
        else if (/\.(tsx?|jsx?|mjs|cjs|html|css|md|json)$/.test(name)) out.push(p)
      }
      return out
    }
    expect(existsSync(resolve(ROOT, 'src'))).toBe(true)
    const hits: string[] = []
    for (const abs of walk(resolve(ROOT, 'src'))) {
      // The changelog is the record of what shipped then; it is not a pointer.
      if (/[\\/]src[\\/]renderer[\\/]changelog\.ts$/.test(abs)) continue
      readFileSync(abs, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (OLD_POINTER.test(line)) hits.push(`${abs.slice(ROOT.length + 1)}:${i + 1}: ${line.trim().slice(0, 140)}`)
      })
    }
    expect(hits, hits.join('\n')).toEqual([])
  })
})
