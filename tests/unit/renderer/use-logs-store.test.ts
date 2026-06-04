import { describe, it, expect, beforeEach } from 'vitest'
import { useLogsStore } from '../../../src/renderer/stores/useLogsStore'

describe('useLogsStore', () => {
  beforeEach(() => {
    useLogsStore.setState({ bySessionId: {} })
  })

  it('toggle opens then closes a session', () => {
    useLogsStore.getState().togglePane('s1')
    expect(useLogsStore.getState().bySessionId['s1'].isOpen).toBe(true)
    useLogsStore.getState().togglePane('s1')
    expect(useLogsStore.getState().bySessionId['s1'].isOpen).toBe(false)
  })

  it('setOpen is idempotent and per-session', () => {
    useLogsStore.getState().setOpen('a', true)
    useLogsStore.getState().setOpen('b', false)
    expect(useLogsStore.getState().bySessionId['a'].isOpen).toBe(true)
    expect(useLogsStore.getState().bySessionId['b'].isOpen).toBe(false)
  })

  it('reset drops a session', () => {
    useLogsStore.getState().setOpen('a', true)
    useLogsStore.getState().reset('a')
    expect(useLogsStore.getState().bySessionId['a']).toBeUndefined()
  })

  it('reconcile sweeps sessions not in the live set', () => {
    useLogsStore.getState().setOpen('keep', true)
    useLogsStore.getState().setOpen('drop', true)
    useLogsStore.getState().reconcile(['keep'])
    expect(useLogsStore.getState().bySessionId['keep']).toBeTruthy()
    expect(useLogsStore.getState().bySessionId['drop']).toBeUndefined()
  })
})
