import React from 'react'

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Renderer crash:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col h-screen bg-base text-text p-8">
          <h1 className="text-2xl font-bold text-red mb-4">Something went wrong</h1>
          <p className="text-subtext1 mb-4">The app encountered an error. Your sessions are still running in the background.</p>
          <pre className="bg-surface0 p-4 rounded text-sm text-red overflow-auto flex-1 mb-4">
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 bg-blue text-crust rounded hover:bg-blue/80 w-fit"
          >
            Try to recover
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
