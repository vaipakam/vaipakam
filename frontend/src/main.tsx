import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from './context/ThemeContext'
import { WalletProvider } from './context/WalletContext'
import { ChainProvider } from './context/ChainContext'
import { ModeProvider } from './context/ModeContext'
import './styles/global.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <WalletProvider>
        <ChainProvider>
          <ModeProvider>
            <App />
          </ModeProvider>
        </ChainProvider>
      </WalletProvider>
    </ThemeProvider>
  </StrictMode>,
)
