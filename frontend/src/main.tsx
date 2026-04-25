import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConnectKitProvider } from 'connectkit'
import { wagmiConfig, walletConnectAvailable } from './lib/wagmiConfig'
import { ThemeProvider } from './context/ThemeContext'
import { WalletProvider } from './context/WalletContext'
import { ChainProvider } from './context/ChainContext'
import { ModeProvider } from './context/ModeContext'
import './styles/global.css'
import App from './App.tsx'

// Production sanity check. Without a WalletConnect project ID the mobile
// wallet deep-link flow can't populate — ConnectKit falls back to a raw
// QR-code modal with no "Open in [Wallet]" buttons, which users report
// as "nothing happens when I tap a wallet". This surfaces the mis-config
// loudly in the browser console so a Cloudflare deploy with a missing
// `VITE_WALLETCONNECT_PROJECT_ID` env var doesn't ship silently.
if (!walletConnectAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    '[vaipakam] VITE_WALLETCONNECT_PROJECT_ID is not set. Mobile wallet ' +
      'deep-links will not work — users will only see a QR code. ' +
      'Configure the env var on your Cloudflare build to restore the ' +
      'mobile flow.',
  )
}

// Phase 9 PWA — register the service worker so iOS / Android users can
// install Vaipakam to their home screen with a real standalone shell.
// Worker file at /sw.js handles app-shell stale-while-revalidate caching;
// dynamic data (RPC, subgraph, /quote/* worker) bypasses the SW so chain
// state stays fresh. Skipped in dev (Vite HMR + SW conflict) and on
// browsers without serviceWorker support.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[vaipakam] Service worker registration failed:', err)
    })
  })
}

// Single QueryClient for the whole app — wagmi v2 uses React Query for
// connection state, balance polling, contract-read caching. Keeping one
// instance module-scoped so HMR hot-reloads don't discard the cache.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 2,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          {/* ConnectKitProvider reads the current theme from ThemeProvider
              via document.documentElement's `data-theme` (or equivalent)
              set by our theme toggle, so the wallet-picker modal's look
              tracks the rest of the app. `mode="auto"` follows the
              prefers-color-scheme hint as a fallback.

              Mobile UX options:
              - `walletConnectCTA: 'both'` renders both the QR and the
                per-wallet "Open in App" deep-link buttons on mobile, so
                users in Safari/Chrome can jump directly into MetaMask,
                Rainbow, Trust, etc. instead of scanning their own phone.
              - `initialChainId: 0` disables the connect-time chain prompt
                (0 means "whatever chain the wallet is already on"). The
                dashboard's own chain picker handles switching, and
                forcing a chain on first connect is the most common
                cause of "connect button does nothing" reports on iOS.
              - `enforceSupportedChains: false` lets a user whose wallet
                is on an unsupported chain still connect; our existing
                isCorrectChain banner prompts them to switch. Without
                this, ConnectKit silently refuses the connection and
                surfaces nothing to the user. */}
          <ConnectKitProvider
            mode="auto"
            options={{
              walletConnectCTA: 'both',
              walletConnectName: 'All Wallets',
              initialChainId: 0,
              enforceSupportedChains: false,
            }}
          >
            <WalletProvider>
              <ChainProvider>
                <ModeProvider>
                  <App />
                </ModeProvider>
              </ChainProvider>
            </WalletProvider>
          </ConnectKitProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
