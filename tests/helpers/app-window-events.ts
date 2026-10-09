/**
 * Shared fixtures for the suites that drive the app-window sender rule
 * (src/main/ipc/trusted-sender.ts): a handler answers only the app window's
 * own webContents, from its main frame.
 *
 * One list of the frame shapes that are not that, so a shape added later is
 * added once for every suite, and one reader of main's wiring source.
 */
import { readFileSync } from 'fs'
import path from 'path'

/** The part of a fake webContents the rule reads. */
export interface FakeWebContents {
  mainFrame: unknown
}

/** Every IPC event shape that is not the app window's main frame, each with a label. */
export function notAppMainFrameEvents(webContents: FakeWebContents): Array<[string, unknown]> {
  const { mainFrame } = webContents
  return [
    ['another webContents', { sender: { mainFrame: {} }, senderFrame: {} }],
    ['another webContents presenting the app main frame', { sender: { mainFrame }, senderFrame: mainFrame }],
    ['a sub-frame of the app window', { sender: webContents, senderFrame: { name: 'sub' } }],
    ['the app window with no frame', { sender: webContents, senderFrame: null }],
    ['no sender at all', {}],
  ]
}

/**
 * src/main/index.ts with its comments removed. index.ts cannot be imported in
 * a unit test (it boots the app), so a suite pins how main registers its
 * handlers by reading this source.
 */
export function mainIndexSource(): string {
  return readFileSync(path.resolve(__dirname, '../../src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
}
