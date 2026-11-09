import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectKitProvider } from 'connectkit';
import { wagmiConfig } from './chain/wagmi';
import { ThemeProvider, useTheme } from './app/ThemeContext';
import { ModeProvider } from './app/ModeContext';
import { CapabilityProvider } from './shared/capability/CapabilityContext';
import { HelpProvider } from './shared/help/HelpContext';
import { WorldRailProvider } from './shared/reads/world/WorldRailContext';
import { ErrorBoundary } from './app/ErrorBoundary';
import { TxStoreProvider } from './shared/tx/txStore';
import { App } from './App';
import { startInstall } from './shared/install/install';
// i18n bootstrap: a side-effect import BEFORE the app renders so the
// detection chain has resolved and <html lang>/dir are right by first paint.
import './i18n';
import './styles/global.css';

// A user who keeps the app open across a deploy holds a stale entry that
// references replaced chunk names; the SPA fallback answers index.html for
// the missing chunk and the dynamic import rejects. Reload ONCE per session
// to pick up the fresh chunk graph; a second failure surfaces the error.
let chunkReloadedThisSession = false;
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'app.chunkReloaded';
  let already = chunkReloadedThisSession;
  try {
    already = already || sessionStorage.getItem(KEY) === '1';
  } catch {
    /* storage blocked: the in-memory flag decides */
  }
  if (already) return;
  event.preventDefault();
  chunkReloadedThisSession = true;
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    /* storage blocked */
  }
  window.location.reload();
});

// ACC-11: the browser's install offer fires once, early, so it is caught
// before the first render; a production build also registers the worker
// that keeps this build's files.
startInstall();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Own-state reads refresh on signals and a bounded interval (RB-RAILS);
      // a window-focus storm is not one of them.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/** ConnectKit takes the RESOLVED theme, so the bridge lives under ThemeProvider. */
function ConnectKitThemed({ children }: { children: React.ReactNode }) {
  const { resolved } = useTheme();
  return (
    <ConnectKitProvider mode={resolved} options={{ hideNoWalletCTA: true, hideQuestionMarkCTA: true }}>
      {children}
    </ConnectKitProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <ConnectKitThemed>
              <ModeProvider>
                <CapabilityProvider>
                  <WorldRailProvider>
                    <HelpProvider>
                      <TxStoreProvider>
                        <BrowserRouter>
                          <App />
                        </BrowserRouter>
                      </TxStoreProvider>
                    </HelpProvider>
                  </WorldRailProvider>
                </CapabilityProvider>
              </ModeProvider>
            </ConnectKitThemed>
          </ThemeProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ErrorBoundary>
  </StrictMode>,
);
