import { utilityProcess } from 'electron'
import { join } from 'node:path'
import type { TkWorkerTransport, ToTkWorker, FromTkWorker } from './tk-worker-transport'

export interface ForkedTkWorker { transport: TkWorkerTransport; kill: () => void; onExit: (cb: () => void) => void }

export function forkTokenomicsWorker(): ForkedTkWorker {
  const entry = join(__dirname, 'tokenomics-worker.js')
  const proc = utilityProcess.fork(entry, [], { serviceName: 'ccc-tokenomics' })
  const transport: TkWorkerTransport = {
    post: (msg: ToTkWorker) => proc.postMessage(msg),
    onMessage: (handler) => proc.on('message', (m) => handler(m as FromTkWorker)),
    kill: () => { try { proc.kill() } catch { /* already dead */ } },
  }
  return { transport, kill: transport.kill, onExit: (cb) => proc.once('exit', cb) }
}
