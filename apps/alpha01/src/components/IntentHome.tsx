import { Link } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, Image, LayoutList } from 'lucide-react';
import { ConnectKitButton } from 'connectkit';
import { useMode } from '../context/ModeContext';
import { useWallet } from '../context/WalletContext';
import { useMyLoans } from '../hooks/useIndexedLoans';
import { useMyOffers } from '../hooks/useMyOffers';
import { HelpLink } from './HelpLink';
import { PortfolioStrip } from './PortfolioStrip';
import { DEFI_CLASSIC_LINKS } from '../lib/defiClassicLinks';

const INTENTS = [
  { to: '/borrow', title: 'Borrow assets', body: 'Find a lender and lock collateral to borrow.', icon: ArrowDownLeft },
  { to: '/lend', title: 'Earn by lending', body: 'Post funds and earn interest when matched.', icon: ArrowUpRight },
  { to: '/rent', title: 'Rent or lend an NFT', body: 'Temporary NFT use rights — list or rent with plain-language guidance.', icon: Image },
  { to: '/positions', title: 'My positions', body: 'See active loans and your next action.', icon: LayoutList },
] as const;

export function IntentHome() {
  const { mode } = useMode();
  const { address } = useWallet();
  const { data: loans } = useMyLoans();
  const { data: offers } = useMyOffers();
  const positionCount = (loans?.length ?? 0) + (offers?.length ?? 0);

  return (
    <div className="page-frame">
      <h1 className="page-title">What do you want to do?</h1>
      <p className="page-subtitle">
        {mode === 'basic'
          ? 'Pick a job — we guide you step by step.'
          : 'Intent-first entry with advanced details on demand.'}{' '}
        <HelpLink anchor="getting-started" label="New here? Read the Basic guide" />
      </p>

      {!address ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <p style={{ marginBottom: 12 }}>Connect your wallet to borrow, lend, or manage positions.</p>
          <ConnectKitButton />
        </div>
      ) : null}

      {mode === 'advanced' && address && positionCount > 0 ? (
        <PortfolioStrip loans={loans ?? []} offerCount={offers?.length ?? 0} />
      ) : null}

      {mode === 'advanced' ? (
        <nav className="advanced-shortcuts" aria-label="Advanced shortcuts" data-testid="advanced-shortcuts">
          <Link to="/claims">Claims</Link>
          <a href={DEFI_CLASSIC_LINKS.vpfiVault} target="_blank" rel="noreferrer">
            VPFI vault
          </a>
          <a href={DEFI_CLASSIC_LINKS.allowances} target="_blank" rel="noreferrer">
            Allowances
          </a>
          <a href={DEFI_CLASSIC_LINKS.analytics} target="_blank" rel="noreferrer">
            Analytics
          </a>
        </nav>
      ) : null}

      {positionCount > 0 ? (
        <div className="banner banner-warn" style={{ marginBottom: 16 }}>
          You have {positionCount} open position{positionCount === 1 ? '' : 's'} (loans and
          offers). <Link to="/positions">Manage them</Link>
        </div>
      ) : null}

      <div className="intent-grid">
        {INTENTS.map(({ to, title, body, icon: Icon }) => (
          <Link key={to} to={to} className="intent-card">
            <Icon size={22} color="var(--brand)" />
            <h3>{title}</h3>
            <p>{body}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}