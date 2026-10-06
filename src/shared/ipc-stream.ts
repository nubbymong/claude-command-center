// Usage track MP8 round 2 (VM): the end of a stream on a private reply
// channel. Main sends a stream's items with `webContents.send` and its result
// as the `invoke` reply, and Electron does not order the two routes against
// each other: a caller that stopped listening when the reply arrived dropped
// items still on their way (3 of 20 usage streams on the VM, 8 of 10
// offline). Main now sends this marker on the SAME channel after the last
// item, and the preload stops listening only once it has arrived: messages on
// one channel arrive in the order they were sent.

const END_KEY = '__ipcStreamEnd'

/** The marker main sends last on a stream's private channel. */
export function ipcStreamEnd(): Readonly<Record<string, true>> {
  return { [END_KEY]: true }
}

/** Whether a message on a stream's channel is its end marker. */
export function isIpcStreamEnd(message: unknown): boolean {
  return !!message && typeof message === 'object' && (message as Record<string, unknown>)[END_KEY] === true
}

/** How long a preload waits for the end marker after a successful reply
 *  before it stops listening anyway (a renderer that outlived its sender). */
export const IPC_STREAM_END_WAIT_MS = 5_000
