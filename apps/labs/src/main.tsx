/**
 * Vaipakam Labs entry point — STUB.
 *
 * Stage 4 of the source-tree refactor will populate src/pages/
 * with the marketing pages (Landing, BuyVPFIMarketing, Overview,
 * UserGuide-Basic, Whitepaper) carved out of apps/defi. Until
 * then this entry mounts a placeholder explaining the state.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('apps/labs: missing #root element in index.html');
}
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
