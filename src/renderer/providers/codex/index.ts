// Codex renderer provider package: public entry point (WP1, design 7.1).
// Descriptor and copy only; every action is a provider-neutral request.
import type { RendererProviderDescriptor } from '../core'
import { defaultProviderActions } from '../core'

export const codexDescriptor: RendererProviderDescriptor = {
  id: 'codex',
  displayName: 'Codex CLI',
  shortName: 'Codex',
  maturity: 'beta',
  accentToken: '--provider-accent-codex',
  copy: {
    enableQuestion: 'Do you use Codex?',
    enabledSubtitle: 'OpenAI’s Codex CLI side by side with Claude: same workbench, sessions and status line, with its own isolated accounts.',
    cliMissing: 'We couldn’t find the Codex CLI',
    cliMissingHint: 'Install it with the official npm package, then re-check.',
    notSignedIn: 'Not signed in yet',
    signedInHint: 'Signed in through the Codex CLI itself; the Conductor never sees your password or key.',
  },
  setupSteps: [
    { id: 'detect', kind: 'detect', title: 'Find the Codex CLI', capability: 'cli.discovery' },
    { id: 'install', kind: 'install', title: 'Install or update the CLI', capability: 'install.recipes' },
    { id: 'auth', kind: 'auth', title: 'Sign in', capability: 'auth.browser' },
    { id: 'verify', kind: 'verify', title: 'Check the connection', capability: 'auth.status' },
  ],
  authMethods: [
    { method: 'browser', label: 'Sign in with ChatGPT', capability: 'auth.browser' },
    { method: 'device', label: 'Sign in with a device code (beta)', capability: 'auth.device' },
    { method: 'apiKey', label: 'Use an OpenAI API key', capability: 'auth.apiKey' },
  ],
  actions: (ctx) => defaultProviderActions(codexDescriptor, ctx),
}
