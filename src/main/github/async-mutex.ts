/**
 * Minimal FIFO promise-chain mutex. Serializes read-modify-write sequences
 * across concurrent callers sharing the same store instance.
 *
 * NOT RE-ENTRANT. Calling `run()` from inside another `run()` critical
 * section on the same instance will DEADLOCK — the inner call awaits
 * `prev` (the outer's tail), which only resolves after the outer `fn`
 * returns, but the outer `fn` is blocked on the inner. If you need to
 * compose operations that take the lock, build the composition OUTSIDE
 * the mutex and pass a single `fn` to `run()` that performs the whole
 * sequence.
 *
 * This mutex also serializes ALL critical sections (no reader/writer
 * split). Two concurrent `run(reader)` calls still queue one behind the
 * other. Use a dedicated RW-lock if concurrent readers are important.
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
