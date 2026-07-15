// Runs INSIDE an Electron utilityProcess. MUST NOT import any electron main-API.
// The MessagePort arrives via the Electron global process.parentPort.
import type { HostTransport, FromChildMessage, ToChildMessage } from './service-transport'
import { createHooksHost } from './hooks-host-core'

// process.parentPort is an Electron utilityProcess global not present on Node's
// process type — localize the cast here.
const parentPort = (process as unknown as {
  parentPort: {
    on(ev: 'message', cb: (e: { data: ToChildMessage }) => void): void
    postMessage(msg: FromChildMessage): void
  }
}).parentPort

const transport: HostTransport = {
  post: (msg) => parentPort.postMessage(msg),
  onMessage: (handler) => parentPort.on('message', (e) => handler(e.data)),
}

createHooksHost(transport)
