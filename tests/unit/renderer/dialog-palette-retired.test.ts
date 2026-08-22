/**
 * #360 acceptance, encoded: "grep for the old dialog classes in components
 * returns nothing that is a dialog".
 *
 * The per-dialog render tests prove a surface is token-driven along the paths
 * they exercise. This one reads the SOURCE, so a palette class hiding behind a
 * branch no test happens to render is still caught, and a newly written dialog
 * cannot quietly start the second look over again.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const R = (p: string) => resolve(__dirname, '../../../src/renderer', p)

/**
 * Every dialog/modal/confirm/menu/picker migrated in #360, and the four the
 * overnight branch had already moved. These must be palette-free END TO END.
 */
const FULLY_MIGRATED = [
  // primitives + the first family
  'components/ui/Dialog.tsx',
  'components/CloseDialog.tsx',
  'components/SshCloseDialog.tsx',
  'components/SessionDialog.tsx',
  'components/SessionDialog/CodexFormFields.tsx',
  'components/SessionDialog/ProviderSegmentedControl.tsx',
  // large form/settings modals
  'components/codex/CodexSettingsTab.tsx',
  'components/TeamBuilder.tsx',
  'components/SetupDialog.tsx',
  'components/AgentTemplateDialog.tsx',
  // popovers and panels
  'components/AiUsagePopover.tsx',
  'components/ConductorServicesPanel.tsx',
  'components/TrainingWalkthrough.tsx',
  'components/sentinel/SentinelPanel.tsx',
  // overlays, gates, drawers
  'components/SshFlowOverlay.tsx',
  'components/github/config/AddProfileModal.tsx',
  'components/memory/MemoryReadingDrawer.tsx',
  'components/NewAgentDialog.tsx',
  'components/AccountLaunchGate.tsx',
  // context menus
  'components/sidebar/ConfigContextMenu.tsx',
  'components/sidebar/SessionContextMenu.tsx',
  'components/sidebar/GroupContextMenu.tsx',
  'components/sidebar/DockRowMenu.tsx',
  'components/sidebar/ConfigLoadFailedRailIndicator.tsx',
  'components/ScreenshotContextMenu.tsx',
  'components/TerminalContextMenu.tsx',
  'components/CanvasSubjectPicker.tsx',
  // small modals, prompts, confirms
  'components/NewAccountPrompt.tsx',
  'components/ExcalidrawModal.tsx',
  'components/WindowPickerModal.tsx',
  'components/github/config/OAuthDeviceFlow.tsx',
  'components/ToolbarPopup.tsx',
  'components/WhatsNewModal.tsx',
  'components/github/onboarding/OnboardingModal.tsx',
  'components/HideDockFeatureDialog.tsx',
  'components/LoggingConsentPrompt.tsx',
  'components/ResumeSessionsPrompt.tsx',
  'components/LogsWipeModal.tsx',
  'components/tokenomics/SessionDetailDrawer.tsx',
]

/**
 * Files where only PART of the file is a dialog — the surrounding page or
 * chrome is out of scope for #360 and still carries palette classes. Listed
 * here so the exclusion is deliberate and reviewable rather than silent.
 */
const PARTIAL = [
  'App.tsx',
  'components/BottomBar.tsx',
  'components/github/GitHubPanel.tsx',
  'components/AgentLibrary.tsx',
  'components/CloudAgentsPage.tsx',
  'components/TabBar.tsx',
  'components/ScreenshotButton.tsx',
]

const COLOURS =
  'mantle|base|crust|surface[012]|subtext[01]|overlay[012]|text|mauve|blue|red|green|yellow|peach|lavender|sapphire|sky|teal|pink|maroon|flamingo|rosewater'
const PREFIXES = 'bg|text|border|ring|accent|from|to|via|divide|outline|placeholder|fill|stroke|shadow'

/** A palette utility, with any variant prefix (hover:, focus:, group-hover:…)
 *  and any /NN opacity suffix. */
const PALETTE = new RegExp(`\\b(?:[a-z-]+:)*(?:${PREFIXES})-(?:${COLOURS})(?:\\/\\d+)?\\b`, 'g')

/** The pre-rename inline CSS vars (`var(--color-surface1)`). */
const PALETTE_VAR = /var\(\s*--color-[a-z0-9-]+/g

/**
 * `text-base` is NOT a colour. Tailwind resolves `text-*` in the font-size
 * namespace first, so `text-base` is 1rem — which is exactly the bug #360
 * fixed (`bg-blue text-base` buttons inherited their text colour instead of
 * getting a dark one). Genuine font-size uses are legitimate and stay.
 */
const FONT_SIZE_NOT_A_COLOUR = /^text-base$/

/** Strip comments so prose describing the retired classes is not a finding. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function paletteHits(file: string): string[] {
  const abs = R(file)
  if (!existsSync(abs)) throw new Error(`#360 inventory drift: ${file} no longer exists — update this list`)
  const src = stripComments(readFileSync(abs, 'utf8'))
  const hits: string[] = []
  for (const m of src.match(PALETTE) ?? []) {
    const bare = m.replace(/^(?:[a-z-]+:)*/, '')
    if (FONT_SIZE_NOT_A_COLOUR.test(bare)) continue
    hits.push(m)
  }
  hits.push(...(src.match(PALETTE_VAR) ?? []))
  return hits
}

describe('#360 — the old palette is retired from dialogs', () => {
  it.each(FULLY_MIGRATED)('%s has no Catppuccin palette class or --color-* var', (file) => {
    expect(paletteHits(file)).toEqual([])
  })

  it('every partially-migrated file still exists (the exclusion list is honest)', () => {
    for (const file of PARTIAL) {
      expect(existsSync(R(file)), `${file} is on the #360 partial list`).toBe(true)
    }
  })

  it('the detector actually fires — a palette class is not silently passed', () => {
    // Verify-the-verifier: prove the regex catches what it claims to.
    const sample = 'const a = <div className="bg-mantle text-subtext0 hover:bg-surface1/50" />'
    const hits = (stripComments(sample).match(PALETTE) ?? [])
    expect(hits).toEqual(['bg-mantle', 'text-subtext0', 'hover:bg-surface1/50'])
    expect('var(--color-surface1)'.match(PALETTE_VAR)).toHaveLength(1)
    // …and that it does NOT fire on the font-size utility or on a token.
    expect('text-base'.replace(/^(?:[a-z-]+:)*/, '')).toMatch(FONT_SIZE_NOT_A_COLOUR)
    expect('bg-[var(--surface-raised)] text-[var(--text-primary)]'.match(PALETTE)).toBeNull()
  })

  it('ignores the retired class names when they appear in prose', () => {
    expect(stripComments('// was `bg-blue text-base`\nconst x = 1').match(PALETTE)).toBeNull()
    expect(stripComments('/* bg-mantle */ const y = 2').match(PALETTE)).toBeNull()
  })
})

describe('#360 — dialog backdrops never close on click', () => {
  /**
   * Ctrl+C in a terminal fires click events, so a backdrop with
   * `onClick={onClose}` ate the user's dialog. The shipped rule is
   * mousedown-dismiss, with a context-menu gesture dismissing inertly
   * (src/renderer/lib/pointer.ts).
   */
  it.each(FULLY_MIGRATED)('%s has no onClick close on a full-bleed backdrop', (file) => {
    const src = stripComments(readFileSync(R(file), 'utf8'))
    // A `fixed inset-0` / `absolute inset-0` element carrying an onClick that
    // calls a close handler is the banned shape.
    const banned = /className="[^"]*\binset-0\b[^"]*"[^>]*onClick=\{[^}]*\b(onClose|onCancel|setPanelOpen|close)\b/
    expect(banned.test(src), `${file} closes a backdrop on click`).toBe(false)
  })

  it('the backdrop detector actually fires', () => {
    const bad = '<div className="fixed inset-0 z-50" onClick={onClose}>'
    const banned = /className="[^"]*\binset-0\b[^"]*"[^>]*onClick=\{[^}]*\b(onClose|onCancel|setPanelOpen|close)\b/
    expect(banned.test(bad)).toBe(true)
  })
})
