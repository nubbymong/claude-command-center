import { utilityProcess } from 'electron'
import { join } from 'node:path'
import type { ForkedChild } from './service-supervisor'
import type { ChildTransport, FromChildMessage, ToChildMessage } from './service-transport'

/** Fork the hooks gateway child (out/main/hooks-host.js) as an Electron
 *  utilityProcess and adapt it to the ChildTransport the supervisor expects. */
export function forkHooksChild(): ForkedChild {
  const entry = join(__dirname, 'hooks-host.js')
  const proc = utilityProcess.fork(entry, [], { serviceName: 'ccc-hooks-gateway' })
  const transport: ChildTransport = {
    post: (msg: ToChildMessage) => proc.postMessage(msg),
    onMessage: (handler: (m: FromChildMessage) => void) => proc.on('message', (m) => handler(m as FromChildMessage)),
    kill: () => { try { proc.kill() } catch { /* already dead */ } },
  }
  return { transport, kill: transport.kill, onExit: (cb) => proc.once('exit', cb) }
}
