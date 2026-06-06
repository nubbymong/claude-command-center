import { utilityProcess } from 'electron'
import { join } from 'node:path'
import type { TranscriptsWorkerTransport, ToTranscriptsWorker, FromTranscriptsWorker } from './log-worker-transport'

/** A forked transcripts worker handle the supervisor drives.
 *  Mirrors ForkedLogWorker (fork-log-worker.ts) but speaks the v2
 *  TranscriptsWorkerTransport (post/onMessage/kill) message shapes. */
export interface ForkedTranscriptsWorker {
  transport: TranscriptsWorkerTransport
  kill: () => void
  onExit: (cb: () => void) => void
}

/** Fork the transcripts worker (out/main/transcripts-worker.js) as an Electron
 *  utilityProcess and adapt it to the transport the supervisor expects.
 *
 *  IMPORTANT: this forks by FILE PATH and must NEVER statically import
 *  `./transcripts-worker` — that module pulls in better-sqlite3, which must stay
 *  out of the main-process bundle (it lives only in the forked worker). */
export function forkTranscriptsWorker(): ForkedTranscriptsWorker {
  const entry = join(__dirname, 'transcripts-worker.js')
  const proc = utilityProcess.fork(entry, [], { serviceName: 'ccc-transcripts' })
  const transport: TranscriptsWorkerTransport = {
    post: (msg: ToTranscriptsWorker) => proc.postMessage(msg),
    onMessage: (handler: (m: FromTranscriptsWorker) => void) =>
      proc.on('message', (m) => handler(m as FromTranscriptsWorker)),
    kill: () => { try { proc.kill() } catch { /* already dead */ } },
  }
  return { transport, kill: transport.kill, onExit: (cb) => proc.once('exit', cb) }
}
