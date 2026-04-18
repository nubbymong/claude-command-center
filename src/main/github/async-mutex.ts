/**
 * Minimal FIFO promise-chain mutex. Serializes read-modify-write sequences
 * across concurrent callers sharing the same store instance.
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve()

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tail = next
    try {
      await prev
      return await fn()
    } finally {
      release()
    }
  }
}
