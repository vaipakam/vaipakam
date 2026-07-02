import { useMode } from '../context/ModeContext';
import { useTheme } from '../context/ThemeContext';
import { CHAIN_REGISTRY, DEFAULT_CHAIN } from '../lib/chains';

export function SettingsPage() {
  const { mode, setMode } = useMode();
  const { theme, toggleTheme, followingSystem } = useTheme();

  return (
    <div>
      <h1 className="page-title">Settings</h1>

      <div className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginBottom: 8 }}>Experience mode</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className={`btn ${mode === 'basic' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setMode('basic')}
          >
            Basic
          </button>
          <button
            type="button"
            className={`btn ${mode === 'advanced' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setMode('advanced')}
          >
            Advanced
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginBottom: 8 }}>Theme</h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
          Current: {theme}{followingSystem ? ' (following system)' : ''}
        </p>
        <button type="button" className="btn btn-secondary" onClick={toggleTheme}>
          Toggle light / dark
        </button>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 8 }}>Default chain</h3>
        <p style={{ color: 'var(--text-secondary)' }}>
          {DEFAULT_CHAIN.name} ({DEFAULT_CHAIN.chainId}) — {Object.keys(CHAIN_REGISTRY).length} chains in registry
        </p>
      </div>
    </div>
  );
}