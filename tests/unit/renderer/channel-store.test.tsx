// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { useChannelStore } from '../../../src/renderer/stores/channelStore'
import type { PendingPermission } from '../../../src/shared/channel-types'

const p: PendingPermission = { requestId: 'r', sessionId: 's', sessionLabel: 'L', tool: 'Bash',
  payloadPreview: 'ls', capturedAt: 0, transport: 'hook', tierLabel: 'hooks' }

describe('channelStore', () => {
  it('setPending replaces the pending list', () => {
    useChannelStore.getState().setPending([])
    expect(useChannelStore.getState().pending).toEqual([])
    useChannelStore.getState().setPending([p])
    expect(useChannelStore.getState().pending).toEqual([p])
  })
})
