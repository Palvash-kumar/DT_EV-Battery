import { Component } from 'react';

// Keeps one broken page from blanking the whole dashboard.
export class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="state state-error" role="alert">
        <strong>This page failed to render.</strong> {String(this.state.error.message || this.state.error)}. Other pages still work.
      </div>
    );
  }
}
