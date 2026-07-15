// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'

const saveMock = vi.fn<(key: string, data: unknown) => Promise<boolean>>()

beforeEach(() => {
  vi.useFakeTimers()
  saveMock.mockReset()
  ;(window as any).electronAPI = { config: { save: saveMock } }
})

const { saveConfigDebounced, saveConfigNow, flushPendingConfigSaves, retryFailedConfigSaves } =
  await import('../../../src/renderer/utils/config-saver')
const { useConfigHealthStore } = await import('../../../src/renderer/stores/configHealthStore')

function resetHealth() {
  useConfigHealthStore.setState({ failedKeys: [] })
}

describe('config-saver failure surfacing', () => {
  beforeEach(resetHealth)

  it('marks a key failed when the save returns false twice (initial + retry)', async () => {
    saveMock.mockResolvedValue(false)
    saveConfigDebounced('settings', { a: 1 }, 50)
    await vi.advanceTimersByTimeAsync(50)
    await vi.runAllTimersAsync()
    expect(saveMock).toHaveBeenCalledTimes(2)
    expect(useConfigHealthStore.getState().failedKeys).toContain('settings')
  })

  it('does not mark failed when the retry succeeds', async () => {
    saveMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    saveConfigDebounced('settings', { a: 1 }, 50)
    await vi.advanceTimersByTimeAsync(50)
    await vi.runAllTimersAsync()
    expect(saveMock).toHaveBeenCalledTimes(2)
    expect(useConfigHealthStore.getState().failedKeys).toEqual([])
  })

  it('treats a rejected IPC call like a failure and retries it', async () => {
    saveMock.mockRejectedValueOnce(new Error('ipc dead')).mockResolvedValueOnce(true)
    await saveConfigNow('commands', { b: 2 })
    expect(saveMock).toHaveBeenCalledTimes(2)
    expect(useConfigHealthStore.getState().failedKeys).toEqual([])
  })

  it('a later successful save clears the failed mark for that key', async () => {
    saveMock.mockResolvedValue(false)
    await saveConfigNow('settings', { a: 1 })
    expect(useConfigHealthStore.getState().failedKeys).toContain('settings')
    saveMock.mockResolvedValue(true)
    await saveConfigNow('settings', { a: 2 })
    expect(useConfigHealthStore.getState().failedKeys).toEqual([])
  })

  it('retryFailedConfigSaves re-dispatches the last failed payload', async () => {
    saveMock.mockResolvedValue(false)
    await saveConfigNow('settings', { a: 7 })
    expect(useConfigHealthStore.getState().failedKeys).toContain('settings')
    saveMock.mockClear()
    saveMock.mockResolvedValue(true)
    await retryFailedConfigSaves()
    expect(saveMock).toHaveBeenCalledWith('settings', { a: 7 })
    expect(useConfigHealthStore.getState().failedKeys).toEqual([])
  })
})

describe('flushPendingConfigSaves', () => {
  beforeEach(resetHealth)

  it('dispatches every pending debounced save immediately and awaits completion', async () => {
    saveMock.mockResolvedValue(true)
    saveConfigDebounced('settings', { a: 1 }, 5000)
    saveConfigDebounced('commands', { b: 2 }, 5000)
    expect(saveMock).not.toHaveBeenCalled()
    const flush = flushPendingConfigSaves()
    await vi.runAllTimersAsync()
    await flush
    expect(saveMock).toHaveBeenCalledWith('settings', { a: 1 })
    expect(saveMock).toHaveBeenCalledWith('commands', { b: 2 })
    expect(saveMock).toHaveBeenCalledTimes(2)
  })

  it('after a flush the debounce timer does not fire a duplicate save', async () => {
    saveMock.mockResolvedValue(true)
    saveConfigDebounced('settings', { a: 1 }, 50)
    const flush = flushPendingConfigSaves()
    await vi.runAllTimersAsync()
    await flush
    await vi.advanceTimersByTimeAsync(100)
    expect(saveMock).toHaveBeenCalledTimes(1)
  })

  it('saveConfigNow cancels a pending debounced save for the same key (existing contract)', async () => {
    saveMock.mockResolvedValue(true)
    saveConfigDebounced('settings', { a: 1 }, 50)
    await saveConfigNow('settings', { a: 2 })
    await vi.advanceTimersByTimeAsync(100)
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock).toHaveBeenCalledWith('settings', { a: 2 })
  })
})
