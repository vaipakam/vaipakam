import { type ReactElement } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectKitProvider } from 'connectkit';
import { wagmiConfig } from '../src/lib/wagmiConfig';
import { ThemeProvider } from '../src/context/ThemeContext';
import { WalletProvider } from '../src/context/WalletContext';
import { ChainProvider } from '../src/context/ChainContext';
import { ModeProvider } from '../src/context/ModeContext';

/**
 * Shared render helper — mirrors the REAL provider tree from
 * `src/main.tsx` so components render exactly as they do in the app.
 *
 * WHY the full stack (fixed in #1076): the app's provider tree grew
 * `WagmiProvider` → `QueryClientProvider` → … → `ChainProvider`, but
 * this helper had lagged at Theme/Wallet/Mode only. Every page hook
 * that resolves the read chain (`useReadChain` → `useChainOverride`,
 * and `WalletProvider`'s own `useChainId`) then threw
 * "must be used within …Provider", rotting 38 test files silently
 * (CI never ran defi vitest). Keeping this helper faithful to
 * `main.tsx` is the guardrail against that recurring.
 *
 * DELIBERATELY OMITTED — the three mount-side-effecting providers
 * (`WatermarkProvider`, `RealtimePushProvider`, `DataFreshnessProvider`):
 * they open a per-chain WebSocket, a `setInterval`, and probe timers on
 * mount. The pages under test don't consume them (no
 * `useWatermark`/`useDataFreshness` guard errors in the suite), and
 * pulling them into EVERY render would leak sockets/timers across the
 * whole suite. A test that genuinely needs one wraps it locally.
 *
 * A fresh `QueryClient` per render (retries off, no cache bleed between
 * tests) keeps react-query deterministic.
 */

interface Options extends Omit<RenderOptions, 'wrapper'> {
  route?: string;
  path?: string;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(ui: ReactElement, opts: Options = {}) {
  const { route = '/', path = '*', ...rest } = opts;
  const queryClient = makeQueryClient();
  return render(
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          {/* ConnectKitProvider is required by any component that calls a
              ConnectKit hook (useModal etc.); mirrors main.tsx. */}
          <ConnectKitProvider mode="auto">
            <WalletProvider>
              <ChainProvider>
                <ModeProvider>
                  <MemoryRouter initialEntries={[route]}>
                    <Routes>
                      <Route path={path} element={ui} />
                    </Routes>
                  </MemoryRouter>
                </ModeProvider>
              </ChainProvider>
            </WalletProvider>
          </ConnectKitProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>,
    rest,
  );
}

export function renderWithoutProviders(ui: ReactElement, opts: Omit<Options, 'path' | 'route'> = {}) {
  return render(ui, opts);
}
