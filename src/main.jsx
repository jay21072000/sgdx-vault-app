import { Buffer } from 'buffer'
import process from 'process'

if (typeof window !== 'undefined') {
  window.Buffer = window.Buffer || Buffer
  window.global = window.global || window
  window.process = window.process || process
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Root Error Boundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px 20px',
          maxWidth: '600px',
          margin: '60px auto',
          background: '#1e1b4b',
          color: '#e0e7ff',
          borderRadius: '16px',
          border: '1px solid #6366f1',
          fontFamily: 'sans-serif',
          textAlign: 'center'
        }}>
          <h2 style={{ color: '#f87171', marginBottom: '16px' }}>⚠️ Application Error</h2>
          <p style={{ color: '#c7d2fe', marginBottom: '16px' }}>
            {this.state.error?.message || 'An unexpected rendering error occurred.'}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 20px',
              background: '#6366f1',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: 'bold'
            }}
          >
            🔄 Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
)
