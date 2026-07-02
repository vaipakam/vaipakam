import { Link } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, Image, LayoutList } from 'lucide-react';
import { useMode } from '../context/ModeContext';
import { useMyLoans } from '../hooks/useIndexedLoans';

const INTENTS = [
  { to: '/borrow', title: 'Borrow assets', body: 'Find a lender and lock collateral to borrow.', icon: ArrowDownLeft },
  { to: '/lend', title: 'Earn by lending', body: 'Post funds and earn interest when matched.', icon: ArrowUpRight },
  { to: '/rent', title: 'Rent or lend an NFT', body: 'NFT rental flows — coming in a later wave.', icon: Image },
  { to: '/positions', title: 'My positions', body: 'See active loans and your next action.', icon: LayoutList },
] as const;

export function IntentHome() {
  const { mode } = useMode();
  const { data: loans } = useMyLoans();

  return (
    <div>
      <h1 className="page-title">What do you want to do?</h1>
      <p className="page-subtitle">
        {mode === 'basic'
          ? 'Pick a job — we guide you step by step.'
          : 'Intent-first entry with advanced details on demand.'}
      </p>

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