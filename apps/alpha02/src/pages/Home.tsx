/**
 * First-run screen: four jobs, plain words, nothing competing with
 * them (BasicUserUXSimplification.md "First-Run App Shape").
 */
import { lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { Coins, HandCoins, Images, ListChecks, Droplets } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';

// UX2-008 — Home's only contract-read (and thus its only Diamond-ABI)
// dependency lives in this lazily-loaded nudge, so the eager Home chunk
// (marketing hero + job grid) paints without pulling the ABI chunk.
const ActivePositionsBanner = lazy(() => import('./home/ActivePositionsBanner'));

const JOBS: Array<{
  to: string;
  icon: LucideIcon;
  title: string;
  blurb: string;
}> = [
  {
    to: '/borrow',
    icon: HandCoins,
    title: copy.home.jobs.borrow.title,
    blurb: copy.home.jobs.borrow.blurb,
  },
  {
    to: '/lend',
    icon: Coins,
    title: copy.home.jobs.lend.title,
    blurb: copy.home.jobs.lend.blurb,
  },
  {
    to: '/rent',
    icon: Images,
    title: copy.home.jobs.rent.title,
    blurb: copy.home.jobs.rent.blurb,
  },
  {
    to: '/positions',
    icon: ListChecks,
    title: copy.home.jobs.manage.title,
    blurb: copy.home.jobs.manage.blurb,
  },
];

export function Home() {
  const { isConnected, readChain } = useActiveChain();

  return (
    <div>
      <h1 className="page-title">{copy.home.title}</h1>
      <p className="page-lede">{copy.home.lede}</p>

      {/* UX2-008 — gate the lazy import on connection, not just render.
          `React.lazy` fetches its chunk the moment the element MOUNTS, so
          rendering the banner unconditionally would pull the ABI chunk on
          every Home visit before the banner could return null for a
          disconnected visitor (Codex #1200). A disconnected wallet has no
          positions to nudge about, so mounting it only when connected
          keeps a disconnected landing paint ABI-free. */}
      {isConnected ? (
        <Suspense fallback={null}>
          <ActivePositionsBanner />
        </Suspense>
      ) : null}

      {/* Only advertise the faucet on a testnet whose bundle actually
          carries the mock assets — an unseeded testnet would land the
          user on an immediate "not set up here" page. */}
      {readChain.testnet && getDeployment(readChain.chainId)?.testnetMocks ? (
        <Link to="/faucet" className="banner banner-info" style={{ display: 'flex' }}>
          <Droplets aria-hidden />
          <span className="banner-body">{copy.home.testnetNudge(readChain.name)}</span>
        </Link>
      ) : null}

      <div className="intent-grid">
        {JOBS.map((job) => (
          <Link key={job.to} to={job.to} className="intent-card">
            <span className="intent-icon">
              <job.icon aria-hidden />
            </span>
            <span>
              <h3>{job.title}</h3>
              <p>{job.blurb}</p>
            </span>
          </Link>
        ))}
      </div>

      <p className="muted" style={{ marginTop: 24 }}>
        {copy.app.tagline} Your assets sit in your own on-chain vault — Vaipakam
        never pools or holds them for you.
      </p>
    </div>
  );
}
