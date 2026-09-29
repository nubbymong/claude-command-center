// Screens of the real Codex TUI (0.153.4 and 0.155.1), as the P3.8 VM probe
// recorded them (headless xterm over the raw PTY output; SP vm-p3.8/raw), with
// the paths anonymised. Each line is { text, typed }: `typed` is the text with
// the dim cells blanked, the way the app's screen reader reports it, because
// the composer's placeholder ("Ask Codex to do anything") is drawn dim and a
// user's typing is not. Non-ASCII glyphs are written as escapes.
import type { ScreenLine } from '../../../src/renderer/lib/codexComposer'

const PROMPT = '\u203a'      // the composer glyph
const PROMPT_ULTRA = '\u00bb' // the composer glyph at ultra effort
const DOT = '\u00b7'
const BULLET = '\u2022'
const WORKING = '\u25e6'
const H = '\u2500'
const DIR = 'C:\\Users\\alex\\projects\\demo'

/** A line with no dim cells. */
export const plain = (text: string): ScreenLine => ({ text, typed: text })
/** A line whose cells from `dimFrom` on are dim (a placeholder). */
export const dimFrom = (text: string, from: number): ScreenLine => ({ text, typed: text.slice(0, from) + ' '.repeat(Math.max(0, text.length - from)) })

const banner = (version: string, model = 'gpt-6-astra low'): ScreenLine[] => [
  plain('\u256d' + H.repeat(57) + '\u256e'),
  plain(`\u2502 >_ OpenAI Codex (v${version})                              \u2502`),
  plain('\u2502                                                         \u2502'),
  plain(`\u2502 model:     ${model}   /model to change           \u2502`),
  plain(`\u2502 directory: ${DIR}                   \u2502`),
  plain('\u2570' + H.repeat(57) + '\u256f'),
  plain(''),
  plain('  Tip: New Build faster with Codex.'),
  plain(''),
  plain(''),
]
const placeholder = (glyph = PROMPT): ScreenLine => dimFrom(`${glyph} Ask Codex to do anything`, 2)
const footer = (model = 'gpt-6-astra low', extra = ''): ScreenLine => plain(`  ${model} ${DOT} ${DIR}${extra}`)
const tail = (n: number): ScreenLine[] => Array.from({ length: n }, () => plain(''))

/** Before the model has loaded (drawn before the trust prompt): not ready. */
export const LOADING: ScreenLine[] = [
  plain('\u256d' + H.repeat(39) + '\u256e'),
  plain('\u2502 >_ OpenAI Codex (v0.153.4)            \u2502'),
  plain('\u2502                                       \u2502'),
  plain('\u2502 model:     loading   /model to change \u2502'),
  plain('\u2502 directory: loading                    \u2502'),
  plain('\u2570' + H.repeat(39) + '\u256f'),
  plain(''),
  placeholder(),
  plain(''),
  dimFrom('  ? for shortcuts', 0),
  ...tail(6),
]

/** The folder-trust prompt (an untrusted folder, 0.155.1): not ready. */
export const TRUST: ScreenLine[] = [
  plain(`> You are in ${DIR}`),
  plain(''),
  plain('  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection. Trusting the'),
  plain('  directory allows project-local config, hooks, and exec policies to load.'),
  plain(''),
  plain(`${PROMPT} 1. Yes, continue`),
  plain('  2. No, quit'),
  plain(''),
  plain('  Press enter to continue'),
  ...tail(8),
]

/** The composer, ready and empty (0.155.1, trusted folder). */
export const READY: ScreenLine[] = [...banner('0.155.1'), placeholder(), plain(''), footer(), ...tail(4)]

/** Ready at ultra effort (0.153.4): the glyph differs. */
export const READY_ULTRA: ScreenLine[] = [...banner('0.153.4', 'gpt-6-astra ultra'), placeholder(PROMPT_ULTRA), plain(''), footer('gpt-6-astra ultra'), ...tail(4)]

/** Ready in Plan mode (after /plan): the footer carries the mode on its right. */
export const READY_PLAN: ScreenLine[] = [
  ...banner('0.155.1'),
  plain(`${BULLET} Model changed to gpt-6-astra medium for Plan mode.`),
  plain(' '),
  plain(''),
  placeholder(),
  plain(''),
  footer('gpt-6-astra medium', '                                         Plan mode (shift+tab to cycle)'),
  ...tail(2),
]

/** A resumed conversation: past user lines use the same glyph; the last is the composer. */
export const READY_RESUMED: ScreenLine[] = [
  ...banner('0.155.1'),
  plain(`${PROMPT} /model gpt-5.5`),
  plain(''),
  plain(''),
  plain('\u25a0 Conversation interrupted - tell the model what to do differently.'),
  plain(' '),
  plain(''),
  placeholder(),
  plain(''),
  footer(),
]

/** A turn running: the composer and footer are drawn, the turn is not over. */
export const WORKING_NOW: ScreenLine[] = [
  ...banner('0.155.1'),
  plain(`${PROMPT} hello`),
  plain(' '),
  plain(`${WORKING} Working (2s ${BULLET} esc to interrupt)`),
  plain(''),
  plain(''),
  placeholder(),
  plain(''),
  footer('gpt-6-astra medium', ` ${DOT} renaming...`),
]

/** The user has typed into the composer (not dim): ready, but not empty. */
export const USER_TYPING: ScreenLine[] = [...banner('0.155.1'), plain(`${PROMPT} half a question`), plain(''), footer(), ...tail(4)]

/** `/plan` typed, its popup under it (no footer while the popup shows). */
export const TYPED_PLAN: ScreenLine[] = [...banner('0.155.1'), plain(`${PROMPT} /plan`), plain(''), plain('  /plan  switch to Plan mode'), ...tail(4)]

/** `/compact` typed, its popup under it. */
export const TYPED_COMPACT: ScreenLine[] = [...banner('0.155.1'), plain(`${PROMPT} /compact`), plain(''), plain('  /compact  summarize conversation to prevent hitting the context limit'), ...tail(4)]

/** `/compact` typed after the user's own text: not ours alone. */
export const TYPED_AFTER_USER: ScreenLine[] = [...banner('0.155.1'), plain(`${PROMPT} half a question/compact`), plain(''), footer(), ...tail(4)]

/** Codex's own model picker (after `/model` + Enter): not ready. */
export const MODEL_PICKER: ScreenLine[] = [
  ...banner('0.155.1'),
  plain('  Select Model and Effort'),
  plain('  Access legacy models by running codex -m <model_name> or in your config.toml'),
  plain(''),
  plain(`${PROMPT} 1. gpt-6-astra (current)  Our most capable model for complex, demanding work.`),
  plain('  2. gpt-5.6-sol            Latest frontier agentic coding model.'),
  plain(''),
  plain('  Press enter to confirm or esc to go back'),
]

/** Its second step: not ready. */
export const REASONING_PICKER: ScreenLine[] = [
  ...banner('0.155.1'),
  plain('  Select Reasoning Level for gpt-6-astra'),
  plain(''),
  plain('  1. Low (default)     Fast responses with lighter reasoning'),
  plain(`${PROMPT} 2. Medium (current)  Balances speed and reasoning depth for everyday tasks`),
  plain(''),
  plain('  Press enter to confirm or esc to go back'),
]

/** 0.153.4 at start-up (P3.8 round 3, V1; the VM's round 2 captures): after drawing its prompt, Codex boots its MCP
 *  servers with a status row that reads like a turn ("esc to interrupt"). Still starting: not ready, not busy. */
export const BOOTING_153: ScreenLine[] = [
  ...banner('0.153.4', 'gpt-6-astra'),
  plain(`Booting MCP server: conductor (0s ${BULLET} esc to interrupt)`),
  plain(''),
  plain(''),
  placeholder(),
  plain(''),
  footer('gpt-6-astra default'),
  ...tail(2),
]

/** /plan typed just before the boot row came up (0.153.4, V1): the boot row above it, its popup under it. */
export const TYPED_PLAN_BOOTING_153: ScreenLine[] = [
  ...banner('0.153.4', 'gpt-6-astra'),
  plain(`Booting MCP server: conductor (0s ${BULLET} esc to interrupt)`),
  plain(''),
  plain(''),
  plain(`${PROMPT} /plan`),
  plain(''),
  plain('  /plan  switch to Plan mode'),
]

/** 0.153.4 ready, its MCP servers booted. */
export const READY_153: ScreenLine[] = [...banner('0.153.4', 'gpt-6-astra'), placeholder(), plain(''), footer('gpt-6-astra default'), ...tail(4)]
