import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LegalGate } from '../../src/components/app/LegalGate';

/*
 * #822 — the Terms gate has no on-chain per-action backstop, so it must fail
 * CLOSED. It may only render the gated children after a SUCCESSFUL read that
 * shows the wallet accepted (or the gate genuinely disabled). While the read
 * is loading, or when it errors, the gate must hold closed and NOT pass the
 * app content through. The hook + wallet are mocked so each state is driven
 * deterministically.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en', changeLanguage: () => Promise.resolve() },
  }),
}));

const walletState = vi.hoisted(() => ({ current: { address: '0xabc' as string | null } }));
vi.mock('../../src/context/WalletContext', () => ({
  useWallet: () => walletState.current,
}));

const tosState = vi.hoisted(() => ({
  current: {
    hasAccepted: false,
    readOk: false,
    currentVersion: 0,
    currentHash: `0x${'0'.repeat(64)}`,
    userVersion: 0,
    loading: true,
    error: null as string | null,
    accept: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    submitting: false,
  },
}));
vi.mock('../../src/hooks/useTosAcceptance', () => ({
  useTosAcceptance: () => tosState.current,
}));

// Keep the gate render free of router / styling deps.
vi.mock('../../src/components/L', () => ({
  L: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('../../src/components/app/ErrorAlert', () => ({
  ErrorAlert: ({ message }: { message: string }) => <div>{message}</div>,
}));

const APP = <div>APP_CONTENT</div>;

function setTos(partial: Partial<typeof tosState.current>) {
  tosState.current = { ...tosState.current, ...partial };
}

describe('LegalGate — #822 Terms gate fails CLOSED', () => {
  beforeEach(() => {
    walletState.current = { address: '0xabc' };
    setTos({
      hasAccepted: false,
      readOk: false,
      currentVersion: 0,
      loading: true,
      error: null,
    });
  });

  it('holds CLOSED while the read is loading (does not pass the app through)', () => {
    setTos({ loading: true, readOk: false, hasAccepted: false });
    render(<LegalGate>{APP}</LegalGate>);
    expect(screen.queryByText('APP_CONTENT')).not.toBeInTheDocument();
    expect(screen.getByText('legalGate.verifying')).toBeInTheDocument();
  });

  it('holds CLOSED when the read fails (fail-closed, not fail-open)', () => {
    setTos({ loading: false, readOk: false, hasAccepted: false, error: 'rpc down' });
    render(<LegalGate>{APP}</LegalGate>);
    expect(screen.queryByText('APP_CONTENT')).not.toBeInTheDocument();
    expect(screen.getByText('legalGate.readErrorTitle')).toBeInTheDocument();
    expect(screen.getByText('rpc down')).toBeInTheDocument();
  });

  it('passes through on a successful read when accepted / gate disabled', () => {
    setTos({ loading: false, readOk: true, hasAccepted: true });
    render(<LegalGate>{APP}</LegalGate>);
    expect(screen.getByText('APP_CONTENT')).toBeInTheDocument();
  });

  it('shows the accept modal on a successful read when enabled + not accepted', () => {
    setTos({ loading: false, readOk: true, hasAccepted: false, currentVersion: 2 });
    render(<LegalGate>{APP}</LegalGate>);
    expect(screen.queryByText('APP_CONTENT')).not.toBeInTheDocument();
    expect(screen.getByText('legalGate.title')).toBeInTheDocument();
  });

  it('passes through with no gate when no wallet is connected', () => {
    walletState.current = { address: null };
    render(<LegalGate>{APP}</LegalGate>);
    expect(screen.getByText('APP_CONTENT')).toBeInTheDocument();
  });
});
