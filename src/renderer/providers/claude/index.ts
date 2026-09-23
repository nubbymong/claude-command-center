// Claude renderer provider package: public entry point (WP1, design 7.1).
// Descriptor and copy only; every action is a provider-neutral request.
import type { RendererProviderDescriptor } from '../core'
import { defaultProviderActions } from '../core'

export const claudeDescriptor: RendererProviderDescriptor = {
  id: 'claude',
  displayName: 'Claude Code',
  shortName: 'Claude',
  maturity: 'stable',
  accentToken: '--provider-accent-claude',
  copy: {
    enableQuestion: 'Do you use Claude Code?',
    enabledSubtitle: 'Anthropic’s Claude Code CLI, run in your own terminal sessions with per-account isolation.',
    cliMissing: 'We couldn’t find the Claude Code CLI',
    cliMissingHint: 'Install it from Anthropic’s official instructions, then re-check.',
    notSignedIn: 'Not signed in yet',
    signedInHint: 'Signed in through the Claude Code CLI itself; the Conductor never sees your password.',
  },
  setupSteps: [
    { id: 'detect', kind: 'detect', title: 'Find the Claude Code CLI', capability: 'cli.discovery' },
    { id: 'install', kind: 'install', title: 'Install or update the CLI', capability: 'install.recipes' },
    { id: 'auth', kind: 'auth', title: 'Sign in', capability: 'auth.browser' },
    { id: 'verify', kind: 'verify', title: 'Check the connection', capability: 'auth.status' },
  ],
  authMethods: [
    { method: 'browser', label: 'Sign in with Claude Code', capability: 'auth.browser' },
  ],
  actions: (ctx) => defaultProviderActions(claudeDescriptor, ctx),
}
