import { Link } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, Image, LayoutList } from 'lucide-react';
import { ConnectKitButton } from 'connectkit';
import { useMode } from '../context/ModeContext';
import { useWallet } from '../context/WalletContext';
import { useMyLoans } from '../hooks/useIndexedLoans';
import { HelpLink } from './HelpLink';

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

  return (
    <div>
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

      {loans && loans.length > 0 ? (
        <div className="banner banner-warn" style={{ marginBottom: 16 }}>
          You have {loans.length} active position{loans.length === 1 ? '' : 's'}.{' '}
          <Link to="/positions">Manage them</Link>
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