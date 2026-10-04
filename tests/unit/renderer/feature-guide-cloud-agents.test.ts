// @vitest-environment jsdom
/**
 * [host] The owner's 2026-10-04 answer: the Feature Guide gets a Cloud Agents
 * card now (it has had none since the Agent Hub card left with #443), for both
 * assistants, noting the limit of a Codex agent's permission tick: it runs
 * Codex's Auto preset (section 10, question 7, answer A), edits only inside
 * its project, and leaves the Codex account's settings (config.toml) as they
 * are. Its image comes from the later VM recapture (step-cloud-agents.jpg);
 * until then it shows the neutral shell shot other uncaptured cards use.
 */
import { describe, it, expect } from 'vitest'
import { trainingSteps, stepsForAssistants, type TrainingStep } from '../../../src/renderer/training-steps'
import { CODEX_AUTO_LABEL, CODEX_AGENT_WINDOWS_NOTE } from '../../../src/renderer/stores/cloudAgentStore'

const card = (steps: readonly TrainingStep[] = trainingSteps) => steps.find((s) => s.id === 'cloud-agents')
const lines = (s: TrainingStep) =>
  [s.title, s.summary ?? '', ...(s.highlights ?? []), ...s.bullets, ...(s.howToTrigger ?? []).map((h) => `${h.label}: ${h.value}`), s.proTip ?? ''].filter(Boolean)

describe('the Cloud Agents card', () => {
  it('[host] exists under Integrations, once, and is shown whichever assistants are in use', () => {
    expect(trainingSteps.filter((s) => s.id === 'cloud-agents')).toHaveLength(1)
    const c = card()!
    expect(c.title).toBe('Cloud Agents')
    expect(c.section).toBe('integrations')
    expect(c.needsClaude).toBeUndefined()
    expect(c.needsCodex).toBeUndefined()
    for (const only of ['claude', 'codex', null] as const) expect(card(stepsForAssistants(trainingSteps, only)), String(only)).toBeDefined()
  })

  it('[host] with both on it names both assistants and how to open and dispatch', () => {
    const text = lines(card()!).join('\n')
    expect(text).toMatch(/Claude Code/)
    expect(text).toMatch(/Codex/)
    expect(text).toMatch(/Cloud Agents -> New agent/)
    expect(text).toMatch(/Skip permission prompts for this run/)
  })

  it('[host] the Codex Auto limit is the one built: Auto, inside the project only, the account\'s settings untouched, and the Windows sandbox', () => {
    const text = lines(card()!).join('\n')
    // The tick's own label starts with the preset's name.
    expect(CODEX_AUTO_LABEL.startsWith('Auto:')).toBe(true)
    expect(text).toMatch(/runs read-only unless you tick \*\*Auto\*\* for that run/)
    expect(text).toMatch(/edits files inside its project only/)
    expect(text).toMatch(/settings \(its config\.toml\) are left as they are/)
    expect(text).not.toMatch(/Unrestricted|danger-full-access|bypass/i)
    // The Windows line says what the dialog's own note says.
    expect(CODEX_AGENT_WINDOWS_NOTE).toMatch(/makes no edits until its sandbox is set up for this Codex account/)
    expect(text).toMatch(/On Windows, a Codex agent on \*\*Auto\*\* makes no edits until Codex's sandbox is set up for its Codex account/)
  })

  it('[host] with Codex alone it reads for Codex, with no line about Claude Code', () => {
    const shown = card(stepsForAssistants(trainingSteps, 'codex'))!
    const text = lines(shown)
    expect(text.filter((l) => /Claude/.test(l))).toEqual([])
    expect(text.join('\n')).toMatch(/runs read-only unless you tick \*\*Auto\*\* for that run/)
  })

  it('[host] its image is the neutral stand-in until the recapture', () => {
    expect(card()!.screenshotFilename).toBe('v2-shell-hero.jpg')
  })
})
