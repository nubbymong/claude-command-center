import { describe, it, expect, vi } from 'vitest'
import { reportIfStalled } from '../../../src/main/jank-detector'

describe('reportIfStalled', () => {
  it('logs when the gap exceeds the threshold', () => {
    const log = vi.fn()
    reportIfStalled(1500, 250, log, 'tick')   // expected 250ms interval, actual 1500ms gap (> 4x stall threshold)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stalled'))
  })
  it('does not log a normal tick', () => {
    const log = vi.fn()
    reportIfStalled(260, 250, log, 'tick')
    expect(log).not.toHaveBeenCalled()
  })
})
