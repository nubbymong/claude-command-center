import { utilityProcess } from 'electron'
import { join } from 'node:path'
import type { WorkerTransport, ToWorker, FromWorker } from './log-worker-transport'

/** A forked logging worker handle the supervisor drives.
 *  Mirrors `ForkedChild` from ../services/service-supervisor but uses the
 *  logging WorkerTransport (post/onMessage/kill) message shapes. */
export interface ForkedLogWorker {
  transport: WorkerTransport
  kill: () => void
  onExit: (cb: () => void) => void
}

/** Fork the logging worker (out/main/log-worker.js) as an Electron
 *  utilityProcess and adapt it to the WorkerTransport the supervisor expects.
 *
 *  IMPORTANT: this forks by FILE PATH and must NEVER statically import
 *  `./log-worker` — that module pulls in better-sqlite3, which must stay out of
 *  the main-process bundle (it lives only in the forked worker). This is the
 *  ONLY file in the logging stack that imports electron's `utilityProcess`. */
export function forkLogWorker(): ForkedLogWorker {
  const entry = join(__dirname, 'log-worker.js')
  const proc = utilityProcess.fork(entry, [], { serviceName: 'ccc-logging' })
  const transport: WorkerTransport = {
    post: (msg: ToWorker) => proc.postMessage(msg),
    onMessage: (handler: (m: FromWorker) => void) => proc.on('message', (m) => handler(m as FromWorker)),
    kill: () => { try { proc.kill() } catch { /* already dead */ } },
  }
  return { transport, kill: transport.kill, onExit: (cb) => proc.once('exit', cb) }
}
