import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectKitProvider } from 'connectkit';
import { wagmiConfig } from './chain/wagmi';
import { ThemeProvider, useTheme } from './app/ThemeContext';
import { ModeProvider } from './app/ModeContext';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/global.css';

// UX-005 (Codex #1169 r1) — with route-level code splitting, a user who
// keeps the app open across a production deploy holds a STALE entry that
// references old hashed chunk names. Visiting a not-yet-cached lazy route
// then requests a chunk the deploy has replaced; the Worker SPA fallback
// answers with index.html (wrong MIME) and the dynamic import rejects,
// dropping the user into the error card. Vite fires `vite:preloadError`
// for exactly this — reload once to pick up the fresh index.html + chunk
// graph. A session-scoped guard prevents a reload loop if the failure is
// not a stale-chunk 404 (e.g. a truly offline network).
window.addEventListener('vite:preloadError', () => {
  const KEY = 'alpha02.chunkReloadAt';
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    // Only auto-reload if we haven't already tried in the last 10s.
    if (Date.now() - last > 10_000) {
      sessionStorage.setItem(KEY, String(Date.now()));
      window.location.reload();
    }
    // else: fall through — React.lazy's rejection hits the ErrorBoundary,
    // whose "reload" affordance lets the user retry manually.
  } catch {
    window.location.reload();
  }
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Indexer reads already carry their own refetch cadence; avoid
      // aggressive window-focus refetch storms on mobile tab switches.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/** ConnectKit needs the RESOLVED theme (it has no 'system' mode that
 *  tracks ours), so this bridge lives under ThemeProvider. */
function ConnectKitThemed({ children }: { children: React.ReactNode }) {
  const { resolved } = useTheme();
  return (
    <ConnectKitProvider
      mode={resolved}
      // Let wallets on UNSUPPORTED chains connect — alpha02's own
      // NetworkBanner then guides the switch. ConnectKit's default
      // gate would block the connection before the banner can render.
      options={{ initialChainId: 0, enforceSupportedChains: false }}
    >
      {children}
    </ConnectKitProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outermost boundary: ABOVE the provider stack, because a
        boundary only catches its descendants — a throw inside
        ThemeProvider/Wagmi/QueryClient/ConnectKit/router would
        otherwise still white-screen. ErrorBoundary itself uses no
        hooks or context, so it is safe out here. No resetKey —
        reload recovers. */}
    <ErrorBoundary>
    <ThemeProvider>
      <ModeProvider>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <ConnectKitThemed>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </ConnectKitThemed>
          </QueryClientProvider>
        </WagmiProvider>
      </ModeProvider>
    </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
