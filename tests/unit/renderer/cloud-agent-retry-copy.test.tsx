// @vitest-environment jsdom
/**
 * [host] P4.11 (the PR 4 review's copy items for the sweep, review C): a Codex
 * Cloud Agent's Retry reuses the launch confirm, which said "Start session";
 * and the Cloud Agents explainer said a headless Claude runs every agent,
 * though a Codex agent runs Codex since P4.5.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { useLaunchAckStore } = await import('../../../src/renderer/stores/launchAckStore')
const { default: LaunchAckConfirm } = await import('../../../src/renderer/components/LaunchAckConfirm')
const { AgentHubExplainer } = await import('../../../src/renderer/components/agent-hub/AgentHubOnboarding')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')

let container: HTMLDivElement
let root: Root
const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useLaunchAckStore.setState({ queue: [] })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  useLaunchAckStore.setState({ queue: [] })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
})

function ask(extra: Record<string, unknown> = {}) {
  void useLaunchAckStore.getState().request({
    sessionId: 'cloud-agent:ca-1', sessionLabel: 'Tidy', accountName: 'Work', external: true, unknown: false, ...extra,
  } as never)
}

describe('the launch confirm', () => {
  it('a session launch reads Start session, with Launch', () => {
    act(() => { ask({ sessionId: 's1', sessionLabel: 'App Dev' }) })
    act(() => { root.render(<LaunchAckConfirm />) })
    expect(byTest('launch-ack-confirm')!.textContent).toContain('Start session')
    expect(byTest('launch-ack-launch')!.textContent).toBe('Launch')
  })

  it('a cloud agent\'s Retry reads Retry agent, with Retry, and never Start session', () => {
    act(() => { ask({ retryAgent: true }) })
    act(() => { root.render(<LaunchAckConfirm />) })
    const text = byTest('launch-ack-confirm')!.textContent ?? ''
    expect(text).toContain('Retry agent')
    expect(text).not.toContain('Start session')
    expect(byTest('launch-ack-question')!.textContent).toBe('Retry Tidy with the Codex sign-in already on this computer?')
    expect(byTest('launch-ack-launch')!.textContent).toBe('Retry')
    expect(byTest('launch-ack-cancel')!.getAttribute('title')).toBe('Do not retry this agent')
  })
})

describe('the Cloud Agents explainer', () => {
  const step2 = () => container.textContent ?? ''
  it('names the assistant that runs the agent: Codex alone, Claude Code alone, or either', () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true }, isLoaded: true })
    act(() => { root.render(<AgentHubExplainer onDismiss={() => {}} />) })
    expect(step2()).toContain('Codex runs it, headless, in your project folder')
    expect(step2()).not.toContain('Claude')
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: true, codexEnabled: false }, isLoaded: true })
    act(() => { root.render(<AgentHubExplainer onDismiss={() => {}} />) })
    expect(step2()).toContain('Claude Code runs it, headless, in your project folder')
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: true, codexEnabled: true }, isLoaded: true })
    act(() => { root.render(<AgentHubExplainer onDismiss={() => {}} />) })
    expect(step2()).toContain('Claude Code or Codex runs it, headless, in your project folder')
  })
})
