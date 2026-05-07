import { type ReactElement } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from '../src/context/ThemeContext';
import { WalletProvider } from '../src/context/WalletContext';
import { ModeProvider } from '../src/context/ModeContext';

interface Options extends Omit<RenderOptions, 'wrapper'> {
  route?: string;
  path?: string;
}

export function renderWithProviders(ui: ReactElement, opts: Options = {}) {
  const { route = '/', path = '*', ...rest } = opts;
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ThemeProvider>
        <WalletProvider>
          <ModeProvider>
            <Routes>
              <Route path={path} element={ui} />
            </Routes>
          </ModeProvider>
        </WalletProvider>
      </ThemeProvider>
    </MemoryRouter>,
    rest,
  );
}

export function renderWithoutProviders(ui: ReactElement, opts: Omit<Options, 'path' | 'route'> = {}) {
  return render(ui, opts);
}
