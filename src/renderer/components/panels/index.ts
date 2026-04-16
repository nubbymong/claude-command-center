import { registerPaneComponent } from './PaneRegistry'
import TerminalPane from './TerminalPane'
import DiffViewerPane from './DiffViewerPane'
import PreviewPane from './PreviewPane'

// Register all built-in pane components
// Future phases will add: FileEditorPane
registerPaneComponent('claude-terminal', TerminalPane)
registerPaneComponent('partner-terminal', TerminalPane)
registerPaneComponent('diff-viewer', DiffViewerPane)
registerPaneComponent('preview', PreviewPane)

export { default as PanelContainer } from './PanelContainer'
export { default as PaneHeader } from './PaneHeader'
