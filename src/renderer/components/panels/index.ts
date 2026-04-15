import { registerPaneComponent } from './PaneRegistry'
import TerminalPane from './TerminalPane'

// Register all built-in pane components
// Future phases will add: DiffViewerPane, PreviewPane, FileEditorPane
registerPaneComponent('claude-terminal', TerminalPane)
registerPaneComponent('partner-terminal', TerminalPane)

export { default as PanelContainer } from './PanelContainer'
export { default as PaneHeader } from './PaneHeader'
