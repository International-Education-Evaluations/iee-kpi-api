import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', this.props.scope || 'unknown', error, info?.componentStack);
  }
  handleReload = () => { window.location.reload(); };
  handleClear = () => { this.setState({ error: null }); };

  render() {
    if (!this.state.error) return this.props.children;
    const msg = this.state.error?.message || String(this.state.error);
    const stack = this.state.error?.stack || '';
    return (
      <div className="card-surface bg-red-50 border-red-200 p-4 sm:p-6 max-w-2xl mx-auto my-6">
        <div className="flex items-start gap-3">
          <span className="text-2xl">😞</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-display font-bold text-red-700 mb-1">
              Something broke on this page.
            </div>
            <div className="text-xs text-red-600 mb-3 break-words">{msg}</div>
            <div className="flex gap-2">
              <button onClick={this.handleReload}
                className="text-xs bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-lg font-semibold">
                Reload page
              </button>
              <button onClick={this.handleClear}
                className="text-xs bg-white border border-red-200 text-red-700 hover:bg-red-50 px-3 py-1.5 rounded-lg font-semibold">
                Try again
              </button>
            </div>
            {stack && (
              <details className="mt-3 text-[10px] text-ink-500">
                <summary className="cursor-pointer">Stack trace</summary>
                <pre className="mt-1 whitespace-pre-wrap break-all bg-white p-2 rounded border border-red-100 max-h-48 overflow-auto">{stack}</pre>
              </details>
            )}
          </div>
        </div>
      </div>
    );
  }
}
