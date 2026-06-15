// src/main/paste-queue.ts
// FIFO paste queue with a single in-flight slot and an overflow cap.
// Pure + injectable so it is unit-testable without a real PTY.
export class PasteQueue {
  private queue: string[] = []
  private inFlight = false
  private idle: Array<() => void> = []
  private cancelled = false
  constructor(
    private readonly writer: (envelope: string) => Promise<void>,
    private readonly cap = 16,
  ) {}

  // Returns the number of envelopes dropped due to overflow (0 normally).
  enqueue(envelope: string): number {
    let dropped = 0
    this.queue.push(envelope)
    while (this.queue.length > this.cap) { this.queue.shift(); dropped++ }
    void this.pump()
    return dropped
  }
  get length(): number { return this.queue.length + (this.inFlight ? 1 : 0) }

  private async pump(): Promise<void> {
    if (this.cancelled || this.inFlight) return
    const next = this.queue.shift()
    if (next === undefined) { this.idle.splice(0).forEach(r => r()); return }
    this.inFlight = true
    try { await this.writer(next) } catch { /* a failed write must not stall the queue */ } finally { this.inFlight = false; void this.pump() }
  }
  /**
   * Cancel: drop all pending envelopes, release any drain() waiters, and refuse
   * further pumps. An in-flight write self-terminates via writeEnvelopeChunked's
   * identity guard on its next chunk. (Unit 5 P1.5)
   */
  cancel(): void {
    this.cancelled = true
    this.queue.length = 0
    this.idle.splice(0).forEach((r) => r())
  }

  // Test/util: resolves once the queue has fully drained.
  drain(): Promise<void> {
    if (!this.inFlight && this.queue.length === 0) return Promise.resolve()
    return new Promise<void>(res => this.idle.push(res))
  }
}
