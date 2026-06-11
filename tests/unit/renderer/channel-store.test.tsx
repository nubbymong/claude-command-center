// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { useChannelStore } from '../../../src/renderer/stores/channelStore'
import type { LedgerRecord } from '../../../src/shared/channel-types'

const r: LedgerRecord = {
  id: 'l1', ts: 'now', source: 'manual', target: null,
  transport: 'pty', kind: 'bus-fire', summary: 'x',
}

describe('channelStore', () => {
  it('pushLedger prepends the newest record', () => {
    useChannelStore.setState({ ledger: [] })
    useChannelStore.getState().pushLedger(r)
    expect(useChannelStore.getState().ledger).toEqual([r])
  })
})
