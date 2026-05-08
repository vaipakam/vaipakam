/**
 * Entry point for the marketing SPA.
 *
 * Provider tree is intentionally minimal — the wallet stack
 * (WagmiProvider, ConnectKitProvider, QueryClientProvider, the
 * Wallet/Chain providers) lives on the connected-app surface. Here
 * we mount only:
 *
 *   - ThemeProvider — dark/light toggle
 *   - ModeProvider — basic/advanced UserGuide variant
 *   - i18n init (side-effect import)
 *
 * No service worker. The connected app registers `/sw.js` for its
 * PWA install flow; the marketing site doesn't need one.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './context/ThemeContext';
import { ModeProvider } from './context/ModeContext';
import './i18n'; // initialise i18next before any component renders
import './styles/global.css';
import './styles/rtl.css'; // RTL polish (Arabic + future RTL locales)
import App from './App.tsx';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Missing #root element in index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider>
      <ModeProvider>
        <App />
      </ModeProvider>
    </ThemeProvider>
  </StrictMode>,
);
