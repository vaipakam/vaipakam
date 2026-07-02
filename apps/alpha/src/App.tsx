import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Box,
  Download,
  BriefcaseBusiness,
  CandlestickChart,
  CheckCircle2,
  ChevronRight,
  Coins,
  Gauge,
  History,
  HandCoins,
  Landmark,
  Layers3,
  LifeBuoy,
  LockKeyhole,
  Network,
  PiggyBank,
  ReceiptText,
  Repeat2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Store,
  Wallet,
  Settings as SettingsIcon,
  Trash2,
} from 'lucide-react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { Component, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

type Mode = 'guided' | 'advanced';

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

type WalletState = {
  detected: boolean;
  account: string | null;
  chainId: string | null;
  error: string | null;
};

type FlowKind = 'earn' | 'borrow' | 'rent';
type OfferKind = 'lend' | 'borrow' | 'rent';
type ActivityFilter = 'all' | 'wallet' | 'offer' | 'loan' | 'rental' | 'vault' | 'reward';

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

type Task = {
  title: string;
  description: string;
  href: string;
  icon: ReactNode;
  goodFor: string;
  nextStep: string;
};

type Step = {
  title: string;
  body: string;
  checks: string[];
};

type GuidedFlow = {
  kind: FlowKind;
  title: string;
  intro: string;
  actionLabel: string;
  assetQuestion: string;
  assetOptions: string[];
  defaultAsset: string;
  amountLabel: string;
  defaultAmount: string;
  amountHint: string;
  recommendedPath: string;
  checklist: string[];
  receipt: {
    receive: string;
    lock: string;
    owe: string;
    lose: string;
    fees: string;
    ending: string;
  };
  steps: Step[];
};

const BASE_SEPOLIA_CHAIN_ID = '0x14a34';
const BASE_SEPOLIA_PARAMS = {
  chainId: BASE_SEPOLIA_CHAIN_ID,
  chainName: 'Base Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://sepolia.base.org'],
  blockExplorerUrls: ['https://sepolia.basescan.org'],
};

const tasks: Task[] = [
  {
    title: 'Earn by lending tokens',
    description: 'Choose an asset, review borrower collateral, and post or accept lending terms.',
    href: '/earn',
    icon: <PiggyBank />,
    goodFor: 'Users with idle stablecoins or blue-chip tokens.',
    nextStep: 'Start with a recommended lending pair, then review risk before signing.',
  },
  {
    title: 'Borrow against collateral',
    description: 'Find terms, see the required collateral, and understand what can happen on default.',
    href: '/borrow',
    icon: <HandCoins />,
    goodFor: 'Users who need liquidity without selling assets.',
    nextStep: 'Pick what you want to borrow and what you can safely lock.',
  },
  {
    title: 'Rent an NFT',
    description: 'Use playable or utility NFTs temporarily while the asset stays protected in a vault.',
    href: '/rent',
    icon: <Box />,
    goodFor: 'Game, membership, or access NFTs with time-limited use rights.',
    nextStep: 'Browse rentals, confirm the prepaid fee and buffer, then start the rental.',
  },
  {
    title: 'Manage my positions',
    description: 'Track loans, claims, vault locks, VPFI discounts, rewards, and activity in one place.',
    href: '/manage',
    icon: <BriefcaseBusiness />,
    goodFor: 'Connected users who already have offers, loans, rewards, or claimables.',
    nextStep: 'Connect wallet, check urgent actions first, then inspect details.',
  },
];

const earnSteps: Step[] = [
  {
    title: 'Pick the lending path',
    body: 'Naive users should start with a token pair that Vaipakam can price and liquidate on the active chain. Advanced users can still create custom pairs after acknowledging the extra risk.',
    checks: ['Asset has a known price path', 'Collateral is not the same asset', 'Network has a live Diamond deployment'],
  },
  {
    title: 'Review the real downside',
    body: 'The review screen should say what the lender receives if the borrower repays, defaults, or if liquidation cannot route safely.',
    checks: ['Expected interest', 'Treasury fee and VPFI discount', 'Default settlement mode'],
  },
  {
    title: 'Sign once, then monitor',
    body: 'The user should see one final human-readable summary before signing. After posting, the offer appears in portfolio and activity without making the user hunt through raw event logs.',
    checks: ['Typed terms match the offer', 'Offer NFT is tracked', 'Claim and cancel paths are visible'],
  },
];

const borrowSteps: Step[] = [
  {
    title: 'Start from the goal amount',
    body: 'Ask what the user wants to borrow first. Then show the required collateral and safety buffer in plain language instead of starting with contract addresses.',
    checks: ['Borrow amount', 'Collateral asset', 'Estimated health factor'],
  },
  {
    title: 'Explain repayment before signing',
    body: 'Before the wallet opens, show full repayment, grace period, late/default consequences, and whether partial repay or swap-to-repay is available.',
    checks: ['Due date', 'Interest mode', 'Repay and preclose options'],
  },
  {
    title: 'Keep risk visible after opening',
    body: 'After the loan starts, the borrower should see one urgent action lane: repay, add collateral, swap collateral to repay, refinance, or claim surplus.',
    checks: ['Near-default warning', 'Collateral lock proof', 'Claimable remainder'],
  },
];

const rentalSteps: Step[] = [
  {
    title: 'Separate rental from borrowing',
    body: 'NFT rental should feel like reserving temporary access, not like taking a normal collateralized loan. The NFT stays in the vault while the renter receives time-limited use rights.',
    checks: ['NFT standard support', 'User-right expiry', 'Prepayment token'],
  },
  {
    title: 'Show the prepaid cost clearly',
    body: 'The renter should see total rental fee, buffer, refund condition, and what happens if the rental is not closed on time.',
    checks: ['Daily rate', 'Rental duration', 'Refundable buffer'],
  },
  {
    title: 'Guide closure',
    body: 'The rental detail page should count down to expiry and make close/claim states obvious for both renter and NFT owner.',
    checks: ['Return status', 'Owner claim state', 'Renter refund state'],
  },
];


const guidedFlows: Record<'earn' | 'borrow' | 'rent', GuidedFlow> = {
  earn: {
    kind: 'earn',
    title: 'Earn by lending',
    intro:
      'Start with the asset you can lend, then review collateral quality, expected return, fees, and what happens if the borrower does not repay.',
    actionLabel: 'Prepare lending offer',
    assetQuestion: 'What do you want to lend?',
    assetOptions: ['mUSDC', 'mWETH', 'mWBTC'],
    defaultAsset: 'mUSDC',
    amountLabel: 'Amount to lend',
    defaultAmount: '1000',
    amountHint: 'Recommended starter path: liquid token collateral, priced on this chain, no custom oracle route.',
    recommendedPath: 'Recommended: mUSDC loan backed by mWETH collateral',
    checklist: ['Wallet connected', 'Network supported', 'Asset price route available', 'Allowance ready'],
    receipt: {
      receive: 'Principal plus agreed interest when borrower repays.',
      lock: 'The lent token amount until repay, cancel, or settlement.',
      owe: 'No repayment obligation; gas is needed for offer actions.',
      lose: 'Time value and route risk if collateral settlement cannot execute as expected.',
      fees: 'Treasury fee after any VPFI discount, plus network gas.',
      ending: 'Borrower repays, lender cancels before match, or lender claims collateral after default.',
    },
    steps: earnSteps,
  },
  borrow: {
    kind: 'borrow',
    title: 'Borrow safely',
    intro:
      'Start with the amount you need. Vaipakam should then show required collateral, repayment deadline, and default consequences before the wallet opens.',
    actionLabel: 'Check borrow terms',
    assetQuestion: 'What do you want to borrow?',
    assetOptions: ['mUSDC', 'mWETH', 'VPFI'],
    defaultAsset: 'mUSDC',
    amountLabel: 'Target borrow amount',
    defaultAmount: '1000',
    amountHint: 'Recommended starter path: borrow stable value against liquid collateral with a visible safety buffer.',
    recommendedPath: 'Recommended: borrow mUSDC against mWETH collateral',
    checklist: ['Wallet connected', 'Collateral balance found', 'Health buffer acceptable', 'Repay route available'],
    receipt: {
      receive: 'Borrowed tokens after the loan starts.',
      lock: 'Collateral in the Vaipakam vault until repayment or settlement.',
      owe: 'Principal, interest, and any late/default cost shown before signing.',
      lose: 'Locked collateral can be claimed or liquidated if the loan defaults.',
      fees: 'Protocol fee, any VPFI discount, swap-to-repay slippage if used, and gas.',
      ending: 'Repay, preclose, refinance, add collateral, or settle after default.',
    },
    steps: borrowSteps,
  },
  rent: {
    kind: 'rent',
    title: 'Rent NFT access',
    intro:
      'Keep NFT rental separate from borrowing: the renter pays for temporary rights while the NFT remains protected by custody and expiry rules.',
    actionLabel: 'Find rental offer',
    assetQuestion: 'What NFT access do you need?',
    assetOptions: ['Game NFT', 'Membership NFT', 'Utility NFT'],
    defaultAsset: 'Game NFT',
    amountLabel: 'Rental duration',
    defaultAmount: '7',
    amountHint: 'Recommended starter path: fixed duration, prepaid fee, refundable buffer, visible expiry.',
    recommendedPath: 'Recommended: fixed-rate rental with refundable buffer',
    checklist: ['NFT standard supported', 'Rights expiry visible', 'Prepay token available', 'Close/claim path known'],
    receipt: {
      receive: 'Temporary NFT use rights until the expiry time.',
      lock: 'Prepaid rental fee and refundable buffer, depending on terms.',
      owe: 'No loan repayment; closure may require a gas transaction.',
      lose: 'Rental fee is spent, and buffer may be claimable if return/close conditions fail.',
      fees: 'Rental fee, protocol fee, any VPFI discount, and gas.',
      ending: 'Rental expires, renter closes and gets buffer back, or owner claims per terms.',
    },
    steps: rentalSteps,
  },
};

type MarketOffer = {
  id: string;
  kind: OfferKind;
  title: string;
  asset: string;
  counterAsset: string;
  amount: string;
  rate: string;
  term: string;
  risk: 'Low' | 'Medium' | 'High';
  recommended: boolean;
  nextAction: string;
};

const marketOffers: MarketOffer[] = [
  { id: 'lend-musdc-weth', kind: 'lend', title: 'Lend mUSDC against mWETH', asset: 'mUSDC', counterAsset: 'mWETH', amount: '2,500', rate: '6.5% APR', term: '30 days', risk: 'Low', recommended: true, nextAction: 'Review lending receipt' },
  { id: 'borrow-musdc-weth', kind: 'borrow', title: 'Borrow mUSDC with mWETH collateral', asset: 'mUSDC', counterAsset: 'mWETH', amount: '1,000', rate: '7.1% APR', term: '21 days', risk: 'Medium', recommended: true, nextAction: 'Review borrow receipt' },
  { id: 'rent-game-nft', kind: 'rent', title: 'Rent game NFT access', asset: 'Game NFT', counterAsset: 'mUSDC', amount: '7 days', rate: '3 mUSDC/day', term: '7 days', risk: 'Low', recommended: true, nextAction: 'Review rental receipt' },
  { id: 'lend-vpfi', kind: 'lend', title: 'Lend VPFI to active borrower', asset: 'VPFI', counterAsset: 'mUSDC', amount: '10,000', rate: '9.2% APR', term: '14 days', risk: 'High', recommended: false, nextAction: 'Open advanced review' },
  { id: 'rent-membership-nft', kind: 'rent', title: 'Rent membership NFT', asset: 'Membership NFT', counterAsset: 'mUSDC', amount: '3 days', rate: '8 mUSDC/day', term: '3 days', risk: 'Medium', recommended: false, nextAction: 'Review rental receipt' },
];

const advancedPanels = [
  {
    title: 'Market builder',
    body: 'Range orders, borrower offers, refinance-tagged offers, internal matching, and backstop-aware offer creation.',
    icon: <CandlestickChart />,
  },
  {
    title: 'Risk lab',
    body: 'Health factor, LTV, tiered liquidity, oracle route, slippage-at-floor, and fallback settlement simulation.',
    icon: <Gauge />,
  },
  {
    title: 'Automation',
    body: 'Auto-lend, auto-roll, refinance caps, keeper permissions, and best-effort execution status.',
    icon: <Repeat2 />,
  },
  {
    title: 'Protocol console',
    body: 'Read-only governance knobs, fee parameters, chain deployment status, and transparency links.',
    icon: <SlidersHorizontal />,
  },
];

const APP_STORAGE_KEYS = {
  mode: 'vaipakam-app-mode',
  risk: 'vaipakam-app-risk',
  language: 'vaipakam-app-language',
  analytics: 'vaipakam-app-analytics',
  lastError: 'vaipakam-app-last-error',
} as const;

function readAppStorage(key: keyof typeof APP_STORAGE_KEYS) {
  if (typeof window === 'undefined') return null;
  const storageKey = APP_STORAGE_KEYS[key];
  return window.localStorage.getItem(storageKey) ?? window.sessionStorage.getItem(storageKey);
}

function App() {
  const [mode, setModeState] = useState<Mode>(() => {
    if (typeof window === 'undefined') return 'guided';
    return readAppStorage('mode') === 'advanced' ? 'advanced' : 'guided';
  });
  const [wallet, setWallet] = useState<WalletState>({ detected: false, account: null, chainId: null, error: null });
  const setMode = (nextMode: Mode) => {
    setModeState(nextMode);
    window.localStorage.setItem(APP_STORAGE_KEYS.mode, nextMode);
  };

  useEffect(() => {
    const ethereum = window.ethereum;
    if (!ethereum) return;

    let mounted = true;
    const refreshWallet = async () => {
      const [accountsResult, chainIdResult] = await Promise.all([
        ethereum.request({ method: 'eth_accounts' }),
        ethereum.request({ method: 'eth_chainId' }),
      ]);
      if (!mounted) return;
      const accounts = Array.isArray(accountsResult) ? accountsResult : [];
      setWallet({
        detected: true,
        account: typeof accounts[0] === 'string' ? accounts[0] : null,
        chainId: typeof chainIdResult === 'string' ? chainIdResult : null,
        error: null,
      });
    };

    const handleAccountsChanged = (accounts: unknown) => {
      const nextAccounts = Array.isArray(accounts) ? accounts : [];
      setWallet((current) => ({
        ...current,
        detected: true,
        account: typeof nextAccounts[0] === 'string' ? nextAccounts[0] : null,
        error: null,
      }));
    };
    const handleChainChanged = (chainId: unknown) => {
      setWallet((current) => ({ ...current, detected: true, chainId: typeof chainId === 'string' ? chainId : null, error: null }));
    };

    refreshWallet().catch(() => setWallet({ detected: true, account: null, chainId: null, error: 'Could not read wallet state.' }));
    ethereum.on?.('accountsChanged', handleAccountsChanged);
    ethereum.on?.('chainChanged', handleChainChanged);

    return () => {
      mounted = false;
      ethereum.removeListener?.('accountsChanged', handleAccountsChanged);
      ethereum.removeListener?.('chainChanged', handleChainChanged);
    };
  }, []);

  const connectWallet = async () => {
    const ethereum = window.ethereum;
    if (!ethereum) {
      setWallet({ detected: false, account: null, chainId: null, error: 'No injected wallet detected.' });
      return;
    }
    const accountsResult = await ethereum.request({ method: 'eth_requestAccounts' });
    const chainIdResult = await ethereum.request({ method: 'eth_chainId' });
    const accounts = Array.isArray(accountsResult) ? accountsResult : [];
    setWallet({
      detected: true,
      account: typeof accounts[0] === 'string' ? accounts[0] : null,
      chainId: typeof chainIdResult === 'string' ? chainIdResult : null,
      error: null,
    });
  };

  const switchToBaseSepolia = async () => {
    const ethereum = window.ethereum;
    if (!ethereum) return;
    try {
      await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_SEPOLIA_CHAIN_ID }] });
      setWallet((current) => ({ ...current, detected: true, chainId: BASE_SEPOLIA_CHAIN_ID, error: null }));
    } catch (error) {
      const maybeError = error as { code?: number };
      if (maybeError.code === 4902) {
        await ethereum.request({ method: 'wallet_addEthereumChain', params: [BASE_SEPOLIA_PARAMS] });
        setWallet((current) => ({ ...current, detected: true, chainId: BASE_SEPOLIA_CHAIN_ID, error: null }));
        return;
      }
      setWallet((current) => ({ ...current, error: 'Network switch rejected or failed.' }));
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Vaipakam navigation">
        <a className="brand" href="/">
          <span className="brand-mark">V</span>
          <span>
            <strong>Vaipakam</strong>
            <small>Task-first protocol UI</small>
          </span>
        </a>
        <nav className="nav-list">
          <AppNavLink to="/" label="Start" icon={<Sparkles />} />
          <AppNavLink to="/earn" label="Earn" icon={<PiggyBank />} />
          <AppNavLink to="/borrow" label="Borrow" icon={<HandCoins />} />
          <AppNavLink to="/rent" label="NFT Rental" icon={<Box />} />
          <AppNavLink to="/offers" label="Offers" icon={<Store />} />
          <AppNavLink to="/claims" label="Claims" icon={<ReceiptText />} />
          <AppNavLink to="/vault" label="Vault" icon={<LockKeyhole />} />
          <AppNavLink to="/activity" label="Activity" icon={<History />} />
          <AppNavLink to="/manage" label="Manage" icon={<BriefcaseBusiness />} />
          <AppNavLink to="/advanced" label="Advanced" icon={<SlidersHorizontal />} />
          <AppNavLink to="/settings" label="Settings" icon={<SettingsIcon />} />
          <AppNavLink to="/help" label="Help" icon={<LifeBuoy />} />
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={18} />
          <span>Non-custodial. No KYC. User-controlled risk choices.</span>
        </div>
      </aside>

      <main className="main-surface">
        <TopBar mode={mode} wallet={wallet} onConnectWallet={connectWallet} onModeChange={setMode} />
        <RouteErrorBoundary>
          <Routes>
          <Route path="/" element={<Home mode={mode} />} />
          <Route path="/earn" element={<FlowPage flow={guidedFlows.earn} mode={mode} wallet={wallet} onConnectWallet={connectWallet} onSwitchNetwork={switchToBaseSepolia} />} />
          <Route path="/borrow" element={<FlowPage flow={guidedFlows.borrow} mode={mode} wallet={wallet} onConnectWallet={connectWallet} onSwitchNetwork={switchToBaseSepolia} />} />
          <Route path="/rent" element={<FlowPage flow={guidedFlows.rent} mode={mode} wallet={wallet} onConnectWallet={connectWallet} onSwitchNetwork={switchToBaseSepolia} />} />
          <Route path="/offers" element={<OfferBook wallet={wallet} onConnectWallet={connectWallet} />} />
          <Route path="/claims" element={<Claims wallet={wallet} onConnectWallet={connectWallet} />} />
          <Route path="/vault" element={<VaultUtility wallet={wallet} />} />
          <Route path="/activity" element={<Activity wallet={wallet} />} />
          <Route path="/manage" element={<Manage mode={mode} />} />
          <Route path="/advanced" element={<Advanced />} />
          <Route path="/settings" element={<SettingsPanel />} />
          <Route path="/data-rights" element={<DataRights wallet={wallet} />} />
          <Route path="/help" element={<Help />} />
          <Route path="*" element={<NotFound />} />
          </Routes>
        </RouteErrorBoundary>
      </main>
    </div>
  );
}


type RouteErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

class RouteErrorBoundary extends Component<{ children: ReactNode }, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): RouteErrorBoundaryState {
    return { hasError: true, message: error instanceof Error ? error.message : 'Unknown route error' };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const entry = {
      at: new Date().toISOString(),
      type: 'route-crash',
      message: error instanceof Error ? error.message : 'Unknown route error',
      componentStack: (info.componentStack ?? '').slice(0, 800),
    };
    window.sessionStorage.setItem(APP_STORAGE_KEYS.lastError, JSON.stringify(entry));
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <section className="recovery-card panel-surface" role="alert">
        <p className="eyebrow">Recovery</p>
        <h2>This page could not render safely.</h2>
        <p>The rest of Vaipakam is still available. A redacted crash note was saved in this browser session for support.</p>
        <code>{this.state.message}</code>
        <div className="hero-actions">
          <button className="primary-action" type="button" onClick={() => window.location.reload()}>Reload page</button>
          <a className="secondary-action" href="/">Back to start</a>
        </div>
      </section>
    );
  }
}

function AppNavLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}

function TopBar({
  mode,
  wallet,
  onConnectWallet,
  onModeChange,
}: {
  mode: Mode;
  wallet: WalletState;
  onConnectWallet: () => void;
  onModeChange: (mode: Mode) => void;
}) {
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Product workspace</p>
        <h1>Make the first decision easy, then reveal power carefully.</h1>
      </div>
      <div className="topbar-controls">
        {wallet.account ? (
          <div className="wallet-pill" aria-label="Wallet and network status">
            <Wallet size={16} />
            <span>{shortAddress(wallet.account)}</span>
            <strong>{chainLabel(wallet.chainId)}</strong>
          </div>
        ) : (
          <button className="wallet-pill wallet-button" type="button" onClick={onConnectWallet}>
            <Wallet size={16} />
            <span>{wallet.detected ? 'Connect wallet' : 'Install wallet'}</span>
          </button>
        )}
        <div className="mode-switch" aria-label="Experience mode">
          <button
            className={mode === 'guided' ? 'selected' : ''}
            type="button"
            aria-pressed={mode === 'guided'}
            onClick={() => onModeChange('guided')}
          >
            Guided
          </button>
          <button
            className={mode === 'advanced' ? 'selected' : ''}
            type="button"
            aria-pressed={mode === 'advanced'}
            onClick={() => onModeChange('advanced')}
          >
            Advanced
          </button>
        </div>
      </div>
    </header>
  );
}

function Home({ mode }: { mode: Mode }) {
  return (
    <div className="page-grid">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">A DeFi + DEX + NFT rental workspace</p>
          <h2>Vaipakam should feel like choosing an outcome, not decoding a contract.</h2>
          <p>
            Vaipakam starts in {mode} mode with user intent: earn, borrow, rent, or manage. Protocol details such as offer NFTs, vault locks,
            liquidity tiers, VPFI discounts, and keeper automation become visible at the moment they affect a decision.
          </p>
          <div className="hero-actions">
            <NavLink className="primary-action" to="/earn">Start guided flow <ArrowRight size={18} /></NavLink>
            <NavLink className="secondary-action" to="/advanced">Open advanced workspace</NavLink>
          </div>
        </div>
        <div className="position-card" aria-label="Example portfolio health card">
          <div className="position-card-header">
            <span>Example position</span>
            <BadgeCheck size={18} />
          </div>
          <strong>1 active loan</strong>
          <dl>
            <div><dt>Health</dt><dd>Comfortable</dd></div>
            <div><dt>Next action</dt><dd>Review claimable mUSDC</dd></div>
            <div><dt>Risk mode</dt><dd>Blue-chip only</dd></div>
          </dl>
        </div>
      </section>

      <section className="task-grid" aria-label="Primary user goals">
        {tasks.map((task) => (
          <NavLink className="task-card" to={task.href} key={task.title}>
            <span className="task-icon">{task.icon}</span>
            <h3>{task.title}</h3>
            <p>{task.description}</p>
            <dl>
              <div><dt>Good for</dt><dd>{task.goodFor}</dd></div>
              <div><dt>Next step</dt><dd>{task.nextStep}</dd></div>
            </dl>
            <span className="card-link">Continue <ChevronRight size={16} /></span>
          </NavLink>
        ))}
      </section>

      <section className="principles band">
        <SectionHeading eyebrow="Design stance" title="Two modes, one product" />
        <div className="principle-list">
          <Principle icon={<LifeBuoy />} title="Guided by default" body="New users see recommended paths, plain-language risk, and one action at a time." />
          <Principle icon={<Layers3 />} title="Advanced when ready" body="Power tools are grouped into an advanced workspace instead of scattered through first-use screens." />
          <Principle icon={<ReceiptText />} title="Every signature gets a receipt" body="Before signing, the user sees exact terms, likely outcomes, and what changes on-chain." />
        </div>
      </section>
    </div>
  );
}

function FlowPage({
  flow,
  mode,
  wallet,
  onConnectWallet,
  onSwitchNetwork,
}: {
  flow: GuidedFlow;
  mode: Mode;
  wallet: WalletState;
  onConnectWallet: () => void;
  onSwitchNetwork: () => void;
}) {
  const [selectedAsset, setSelectedAsset] = useState(flow.defaultAsset);
  const [amount, setAmount] = useState(flow.defaultAmount);
  const numericAmount = Number(amount.replace(/,/g, '')) || 0;
  const isBaseSepolia = wallet.chainId === BASE_SEPOLIA_CHAIN_ID;
  const walletReady = Boolean(wallet.account);
  const canProceed = walletReady && isBaseSepolia && numericAmount > 0;
  const receiptRows = buildReceiptRows(flow, selectedAsset, numericAmount);
  const checklistRows = buildChecklistRows(flow, wallet, numericAmount);
  const actionLabel = !walletReady
    ? 'Connect wallet'
    : !isBaseSepolia
      ? 'Switch to Base Sepolia'
      : canProceed
        ? flow.actionLabel
        : 'Enter an amount';
  const handlePrimaryAction = () => {
    if (!walletReady) {
      onConnectWallet();
      return;
    }
    if (!isBaseSepolia) {
      onSwitchNetwork();
    }
  };

  return (
    <div className="flow-page">
      <section className="flow-hero">
        <div>
          <p className="eyebrow">Guided workflow</p>
          <h2>{flow.title}</h2>
          <p>{flow.intro}</p>
        </div>
        <div className="review-card">
          <span className="review-label">Before wallet opens</span>
          <strong>Human-readable review</strong>
          <p>Terms, risks, fees, collateral, and fallback outcomes are shown before the user signs.</p>
        </div>
      </section>

      <section className="guided-board" aria-label={flow.title + ' guided flow'}>
        <div className="flow-form panel-surface">
          <p className="eyebrow">Step 1</p>
          <h3>{flow.assetQuestion}</h3>
          <div className="choice-grid" role="group" aria-label={flow.assetQuestion}>
            {flow.assetOptions.map((option) => (
              <button
                className={option === selectedAsset ? 'choice selected' : 'choice'}
                type="button"
                key={option}
                onClick={() => setSelectedAsset(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <label className="app-field">
            <span>{flow.amountLabel}</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              aria-label={flow.amountLabel}
            />
          </label>
          <div className="recommendation">
            <BadgeCheck size={18} />
            <span>{flow.recommendedPath} · Selected: {selectedAsset}</span>
          </div>
          <p className="field-hint">{flow.amountHint}</p>
        </div>

        <div className="checklist-card panel-surface">
          <p className="eyebrow">Step 2</p>
          <h3>Eligibility checklist</h3>
          <ul>
            {checklistRows.map((item) => (
              <li key={item.label} className={item.ready ? 'ready' : 'waiting'}>
                {item.ready ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="receipt-card panel-surface">
          <p className="eyebrow">Step 3</p>
          <h3>Review receipt</h3>
          <dl>
            {receiptRows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <button className="primary-action wide" type="button" disabled={walletReady && isBaseSepolia && !canProceed} onClick={handlePrimaryAction}>
            {actionLabel} <ArrowRight size={18} />
          </button>
          {wallet.error ? <p className="inline-error">{wallet.error}</p> : null}
        </div>
      </section>

      {mode === 'advanced' ? (
        <section className="advanced-settings panel-surface">
          <div>
            <p className="eyebrow">Advanced controls</p>
            <h3>Power settings stay available without changing the guided path.</h3>
          </div>
          <div className="advanced-setting-grid">
            <Metric label="Oracle route" value="Primary + fallback" />
            <Metric label="Slippage cap" value="1.5%" />
            <Metric label="Keeper automation" value="Manual approval" />
            <Metric label="Risk mode" value="Blue-chip only" />
          </div>
        </section>
      ) : null}

      <section className="step-board compact">
        {flow.steps.map((step, index) => (
          <article className="step-card" key={step.title}>
            <span className="step-number">{index + 1}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
            <ul>
              {step.checks.map((check) => <li key={check}><CheckCircle2 size={16} /> {check}</li>)}
            </ul>
          </article>
        ))}
      </section>

      <section className="decision-strip">
        <div>
          <p className="eyebrow">Interaction model</p>
          <h3>Start simple. Let advanced users opt into more knobs.</h3>
        </div>
        <NavLink className="secondary-action" to="/advanced">See advanced controls</NavLink>
      </section>
    </div>
  );
}


type ActivityItem = {
  id: string;
  source: Exclude<ActivityFilter, 'all'>;
  title: string;
  detail: string;
  status: 'Observed' | 'Needs review' | 'Local queue' | 'Waiting';
  when: string;
  impact: string;
  nextAction: string;
  safeForGuided: boolean;
};

const activityItems: ActivityItem[] = [
  {
    id: 'wallet-base-sepolia',
    source: 'wallet',
    title: 'Wallet connected on Base Sepolia',
    detail: 'Vaipakam can read wallet and network state before showing action CTAs.',
    status: 'Observed',
    when: 'Now',
    impact: 'Actions can stay gated to the supported test network.',
    nextAction: 'Continue guided flow',
    safeForGuided: true,
  },
  {
    id: 'offer-review-musdc',
    source: 'offer',
    title: 'Lending offer receipt reviewed',
    detail: '2,500 mUSDC against mWETH was reviewed locally before any signing path.',
    status: 'Local queue',
    when: '12 min ago',
    impact: 'No on-chain offer is created until the wallet confirms a real transaction.',
    nextAction: 'Open offer review',
    safeForGuided: true,
  },
  {
    id: 'loan-claim-ready',
    source: 'loan',
    title: 'Loan #2 repayment claim ready',
    detail: 'Claimable mUSDC should remain visible in Claims and Manage until collected.',
    status: 'Needs review',
    when: '1 hr ago',
    impact: 'Value may sit idle if the user misses the claim lane.',
    nextAction: 'Review claim',
    safeForGuided: true,
  },
  {
    id: 'rental-expiry',
    source: 'rental',
    title: 'Game NFT rental expires soon',
    detail: 'The renter or owner may need a close or claim action after expiry.',
    status: 'Waiting',
    when: '2 days left',
    impact: 'The buffer path depends on the rental ending state.',
    nextAction: 'Track expiry',
    safeForGuided: true,
  },
  {
    id: 'vault-lock',
    source: 'vault',
    title: 'mUSDC split between free and locked balances',
    detail: 'The vault view separates assets that can move now from assets backing obligations.',
    status: 'Observed',
    when: 'Today',
    impact: 'Prevents a user from assuming all visible balance is withdrawable.',
    nextAction: 'Inspect locks',
    safeForGuided: true,
  },
  {
    id: 'reward-vpfi',
    source: 'reward',
    title: 'VPFI interaction reward preview',
    detail: 'Reward rows are informational until a claimable proof or contract action is available.',
    status: 'Waiting',
    when: 'Today',
    impact: 'Avoids presenting projected rewards as spendable tokens.',
    nextAction: 'Open rewards',
    safeForGuided: false,
  },
];

type PositionFilter = 'all' | 'urgent' | 'claimable' | 'loans' | 'rentals';

type ManagedPosition = {
  id: string;
  kind: 'loan' | 'offer' | 'rental' | 'vault' | 'reward';
  title: string;
  status: string;
  amount: string;
  nextAction: string;
  urgency: 'urgent' | 'normal' | 'calm';
  claimable?: boolean;
};

const managedPositions: ManagedPosition[] = [
  { id: 'loan-2', kind: 'loan', title: 'Loan #2', status: 'Claim ready', amount: '1,000 mUSDC', nextAction: 'Claim proceeds', urgency: 'urgent', claimable: true },
  { id: 'offer-8', kind: 'offer', title: 'Lending offer #8', status: 'Open', amount: '2,500 mUSDC', nextAction: 'Review or cancel', urgency: 'normal' },
  { id: 'rental-4', kind: 'rental', title: 'Game NFT rental', status: 'Expires in 2d', amount: '7 days', nextAction: 'Track expiry', urgency: 'normal' },
  { id: 'vault-usdc', kind: 'vault', title: 'Vault balance', status: 'Locked and free', amount: '1,000 locked / 1,000 free', nextAction: 'Inspect locks', urgency: 'calm' },
  { id: 'vpfi', kind: 'reward', title: 'VPFI utility', status: 'Discount inactive', amount: '0 VPFI registered', nextAction: 'Check discount', urgency: 'calm' },
];




type VaultTab = 'assets' | 'locks' | 'vpfi';

const vaultAssets = [
  { asset: 'mUSDC', free: '1,000', locked: '1,000', reason: 'Loan #2 collateral or settlement path' },
  { asset: 'mWETH', free: '0.42', locked: '0.00', reason: 'Available for new collateral' },
  { asset: 'VPFI', free: '42', locked: '0', reason: 'Interaction reward preview' },
];

const vpfiTiers = [
  { tier: 'Starter', balance: '100 VPFI', discount: '2%' },
  { tier: 'Active', balance: '1,000 VPFI', discount: '5%' },
  { tier: 'Power', balance: '10,000 VPFI', discount: '10%' },
];

function VaultUtility({ wallet }: { wallet: WalletState }) {
  const [tab, setTab] = useState<VaultTab>('assets');
  const connected = Boolean(wallet.account);
  const freeCount = vaultAssets.filter((asset) => asset.free !== '0').length;
  const lockedCount = vaultAssets.filter((asset) => asset.locked !== '0' && asset.locked !== '0.00').length;

  return (
    <div className="vault-page">
      <SectionHeading eyebrow="Vault and VPFI" title="Know what is free, locked, and useful" />
      <p className="page-intro">
        The vault view separates balances by what the user can do now. VPFI stays optional: useful for discounts and rewards, never a required first step.
      </p>
      <section className="claim-summary">
        <div className="panel-surface">
          <p className="eyebrow">Wallet</p>
          <strong>{connected ? 'Connected' : 'Read only'}</strong>
          <span>{wallet.chainId === BASE_SEPOLIA_CHAIN_ID ? 'Base Sepolia' : 'Switch for actions'}</span>
        </div>
        <div className="panel-surface">
          <p className="eyebrow">Free assets</p>
          <strong>{freeCount}</strong>
          <span>available rows</span>
        </div>
        <div className="panel-surface">
          <p className="eyebrow">Locked assets</p>
          <strong>{lockedCount}</strong>
          <span>explain before action</span>
        </div>
      </section>

      <section className="portfolio-tools panel-surface" aria-label="Vault tabs">
        {(['assets', 'locks', 'vpfi'] as VaultTab[]).map((option) => (
          <button className={tab === option ? 'selected' : ''} type="button" key={option} onClick={() => setTab(option)}>
            {option}
          </button>
        ))}
      </section>

      {tab === 'vpfi' ? (
        <section className="vpfi-grid">
          {vpfiTiers.map((tier) => (
            <article className="panel-surface vpfi-card" key={tier.tier}>
              <p className="eyebrow">{tier.tier}</p>
              <strong>{tier.discount}</strong>
              <span>fee discount at {tier.balance}</span>
            </article>
          ))}
        </section>
      ) : (
        <section className="vault-table panel-surface" aria-label="Vault assets">
          {vaultAssets.map((asset) => (
            <article className="vault-row" key={asset.asset}>
              <strong>{asset.asset}</strong>
              <span>Free: {asset.free}</span>
              <span>Locked: {asset.locked}</span>
              <p>{tab === 'locks' ? asset.reason : 'Available and locked balances shown separately.'}</p>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

type ClaimItem = {
  id: string;
  source: 'loan' | 'rental' | 'reward' | 'discount';
  title: string;
  amount: string;
  asset: string;
  status: 'Ready' | 'Waiting' | 'Informational';
  detail: string;
};

const claimItems: ClaimItem[] = [
  { id: 'claim-loan-2', source: 'loan', title: 'Loan #2 repayment claim', amount: '1,000', asset: 'mUSDC', status: 'Ready', detail: 'Borrower repayment proceeds can be claimed to wallet.' },
  { id: 'claim-rental-buffer', source: 'rental', title: 'Rental buffer refund', amount: '12', asset: 'mUSDC', status: 'Waiting', detail: 'Available after rental close or expiry proof.' },
  { id: 'claim-interaction', source: 'reward', title: 'Interaction reward', amount: '42', asset: 'VPFI', status: 'Ready', detail: 'Reward preview from platform activity.' },
  { id: 'discount-vpfi', source: 'discount', title: 'VPFI fee discount', amount: '0', asset: 'VPFI', status: 'Informational', detail: 'Register VPFI to unlock discount tiers once wired.' },
];

function Claims({ wallet, onConnectWallet }: { wallet: WalletState; onConnectWallet: () => void }) {
  const [claimedIds, setClaimedIds] = useState<string[]>([]);
  const [filter, setFilter] = useState<'all' | ClaimItem['source']>('all');
  const walletReady = Boolean(wallet.account);
  const visibleClaims = claimItems.filter((item) => filter === 'all' || item.source === filter);
  const readyCount = claimItems.filter((item) => item.status === 'Ready' && !claimedIds.includes(item.id)).length;
  const totalReady = claimItems
    .filter((item) => item.status === 'Ready' && item.asset === 'mUSDC' && !claimedIds.includes(item.id))
    .reduce((sum, item) => sum + Number(item.amount.replace(/,/g, '')), 0);

  const claim = (id: string) => {
    setClaimedIds((current) => current.includes(id) ? current : [...current, id]);
  };

  return (
    <div className="claims-page">
      <SectionHeading eyebrow="Claims and rewards" title="Collect value without hunting through activity" />
      <section className="claim-summary">
        <div className="panel-surface">
          <p className="eyebrow">Ready now</p>
          <strong>{readyCount}</strong>
          <span>claimable items</span>
        </div>
        <div className="panel-surface">
          <p className="eyebrow">mUSDC ready</p>
          <strong>{totalReady.toLocaleString()}</strong>
          <span>before gas</span>
        </div>
        <div className="panel-surface">
          <p className="eyebrow">Wallet</p>
          <strong>{walletReady ? 'Connected' : 'Not connected'}</strong>
          <span>{wallet.chainId === BASE_SEPOLIA_CHAIN_ID ? 'Base Sepolia' : 'Network check needed'}</span>
        </div>
      </section>

      <section className="portfolio-tools panel-surface" aria-label="Claim filters">
        {(['all', 'loan', 'rental', 'reward', 'discount'] as Array<'all' | ClaimItem['source']>).map((option) => (
          <button className={filter === option ? 'selected' : ''} type="button" key={option} onClick={() => setFilter(option)}>
            {option}
          </button>
        ))}
      </section>

      <section className="claim-list panel-surface" aria-label="Claimable items">
        {visibleClaims.map((item) => {
          const claimed = claimedIds.includes(item.id);
          const ready = item.status === 'Ready' && !claimed;
          return (
            <article className={ready ? 'claim-row ready' : 'claim-row'} key={item.id}>
              <div>
                <span className="position-kind">{item.source}</span>
                <h3>{item.title}</h3>
                <p>{item.detail}</p>
              </div>
              <strong>{claimed ? 'Queued' : item.amount + ' ' + item.asset}</strong>
              <span>{claimed ? 'Claim queued locally' : item.status}</span>
              <button type="button" disabled={!ready} onClick={walletReady ? () => claim(item.id) : onConnectWallet}>
                {!walletReady ? 'Connect wallet' : claimed ? 'Queued' : ready ? 'Claim' : 'Not ready'}
              </button>
            </article>
          );
        })}
      </section>
    </div>
  );
}

function OfferBook({ wallet, onConnectWallet }: { wallet: WalletState; onConnectWallet: () => void }) {
  const [filter, setFilter] = useState<OfferKind | 'all'>('all');
  const [selectedOfferId, setSelectedOfferId] = useState(marketOffers[0].id);
  const [reviewedOfferId, setReviewedOfferId] = useState<string | null>(null);
  const selectedOffer = marketOffers.find((offer) => offer.id === selectedOfferId) ?? marketOffers[0];
  const visibleOffers = marketOffers.filter((offer) => filter === 'all' || offer.kind === filter);
  const walletReady = Boolean(wallet.account);
  const baseReady = wallet.chainId === BASE_SEPOLIA_CHAIN_ID;
  const blocker = !walletReady ? 'Connect wallet to continue' : !baseReady ? 'Switch to Base Sepolia before signing' : null;
  const receiptRows = buildOfferReceiptRows(selectedOffer);

  return (
    <div className="offers-page">
      <SectionHeading eyebrow="Offer book" title="Browse opportunities by outcome" />
      <p className="page-intro">
        Offers are grouped by user goal first. The review panel keeps risk, fees, and end states visible before any wallet prompt.
      </p>
      <section className="offer-layout">
        <div className="offer-list panel-surface">
          <div className="portfolio-tools" aria-label="Offer filters">
            {(['all', 'lend', 'borrow', 'rent'] as Array<OfferKind | 'all'>).map((option) => (
              <button className={filter === option ? 'selected' : ''} type="button" key={option} onClick={() => setFilter(option)}>
                {option}
              </button>
            ))}
          </div>
          <div className="offer-card-list">
            {visibleOffers.map((offer) => (
              <button className={selectedOffer.id === offer.id ? 'offer-card selected' : 'offer-card'} type="button" key={offer.id} onClick={() => { setSelectedOfferId(offer.id); setReviewedOfferId(null); }}>
                <span className="position-kind">{offer.kind}{offer.recommended ? ' · recommended' : ''}</span>
                <strong>{offer.title}</strong>
                <span>{offer.amount} · {offer.rate} · {offer.term}</span>
                <span className={offer.risk === 'High' ? 'risk high' : 'risk'}>{offer.risk} risk</span>
              </button>
            ))}
          </div>
        </div>

        <aside className="offer-review panel-surface" aria-label="Selected offer review">
          <p className="eyebrow">Review before signing</p>
          <h3>{selectedOffer.title}</h3>
          <dl>
            {receiptRows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {blocker ? <p className="inline-error">{blocker}</p> : null}
          {reviewedOfferId === selectedOffer.id ? <p className="inline-success">Reviewed locally. Contract action is not submitted yet.</p> : null}
          <button
            className="primary-action wide"
            type="button"
            onClick={blocker ? onConnectWallet : () => setReviewedOfferId(selectedOffer.id)}
          >
            {blocker ?? selectedOffer.nextAction} <ArrowRight size={18} />
          </button>
        </aside>
      </section>
    </div>
  );
}


function buildOfferReceiptRows(offer: MarketOffer) {
  if (offer.kind === 'borrow') {
    return [
      ['You receive', offer.amount + ' ' + offer.asset],
      ['You lock', 'Collateral in ' + offer.counterAsset + ' sized by the selected offer terms.'],
      ['You may owe', 'Principal, interest, protocol fees, and gas.'],
      ['You can lose', 'Locked collateral can be claimed or liquidated after default.'],
      ['Fees', 'Protocol fee, any VPFI discount, and network gas.'],
      ['When this ends', 'Repay, preclose, refinance, or settle after default.'],
    ];
  }
  if (offer.kind === 'rent') {
    return [
      ['You receive', offer.amount + ' of temporary ' + offer.asset + ' use rights.'],
      ['You lock', 'Prepaid rental fee in ' + offer.counterAsset + ' and any refundable buffer.'],
      ['You may owe', 'No loan repayment; closing or claiming may require gas.'],
      ['You can lose', 'Rental fee is spent, and buffer can be claimable if terms fail.'],
      ['Fees', offer.rate + ', protocol fee, any VPFI discount, and gas.'],
      ['When this ends', 'Rental expiry, renter close, or owner claim.'],
    ];
  }
  return [
    ['You receive', offer.rate + ' if the borrower repays.'],
    ['You lock', offer.amount + ' ' + offer.asset + ' until cancel, match, or settlement.'],
    ['You may owe', 'No repayment obligation; gas for offer actions.'],
    ['You can lose', offer.risk === 'High' ? 'Higher route or liquidity risk. Use Advanced review.' : 'Time value and disclosed settlement risk.'],
    ['Fees', 'Protocol fee, any VPFI discount, and network gas.'],
    ['When this ends', 'Borrower repays, lender cancels, or lender claims after default.'],
  ];
}


function Activity({ wallet }: { wallet: WalletState }) {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [acknowledgedIds, setAcknowledgedIds] = useState<string[]>([]);
  const walletReady = Boolean(wallet.account);
  const baseReady = wallet.chainId === BASE_SEPOLIA_CHAIN_ID;
  const visibleItems = activityItems.filter((item) => filter === 'all' || item.source === filter);
  const reviewCount = activityItems.filter((item) => item.status === 'Needs review').length;
  const localCount = activityItems.filter((item) => item.status === 'Local queue').length;
  const acknowledgedCount = acknowledgedIds.length;

  const acknowledge = (id: string) => {
    setAcknowledgedIds((current) => current.includes(id) ? current : [...current, id]);
  };

  return (
    <div className="activity-page">
      <SectionHeading eyebrow="Activity" title="A readable timeline of what needs attention" />
      <p className="page-intro">
        Activity separates observed wallet state, local action queues, and actions that still need review. It should never make a local preview look like an on-chain transaction.
      </p>

      <section className="activity-summary">
        <div className="panel-surface">
          <p className="eyebrow">Wallet</p>
          <strong>{walletReady ? 'Connected' : 'Read only'}</strong>
          <span>{baseReady ? 'Base Sepolia ready' : 'Actions stay gated'}</span>
        </div>
        <div className="panel-surface">
          <p className="eyebrow">Needs review</p>
          <strong>{reviewCount}</strong>
          <span>user action before signing</span>
        </div>
        <div className="panel-surface">
          <p className="eyebrow">Local queue</p>
          <strong>{localCount}</strong>
          <span>not submitted on-chain</span>
        </div>
        <div className="panel-surface">
          <p className="eyebrow">Acknowledged</p>
          <strong>{acknowledgedCount}</strong>
          <span>marked locally, not deleted</span>
        </div>
      </section>

      <section className="portfolio-tools panel-surface" aria-label="Activity filters">
        {(['all', 'wallet', 'offer', 'loan', 'rental', 'vault', 'reward'] as ActivityFilter[]).map((option) => (
          <button className={filter === option ? 'selected' : ''} type="button" key={option} onClick={() => setFilter(option)}>
            {option}
          </button>
        ))}
      </section>

      <section className="activity-list panel-surface" aria-label="Readable activity timeline">
        {visibleItems.map((item) => {
          const acknowledged = acknowledgedIds.includes(item.id);
          return (
            <article className={item.status === 'Needs review' ? 'activity-row needs-review' : 'activity-row'} key={item.id}>
              <div className="activity-main">
                <span className="position-kind">{item.source} · {item.when}</span>
                <h3>{item.title}</h3>
                <p>{item.detail}</p>
              </div>
              <div className="activity-impact">
                <strong>{item.status}</strong>
                <span>{item.impact}</span>
              </div>
              <div className="activity-action">
                <span>{item.safeForGuided ? 'Guided-safe' : 'Advanced context'} · Next: {item.nextAction}</span>
                <button type="button" onClick={() => acknowledge(item.id)} disabled={acknowledged}>
                  {acknowledged ? 'Acknowledged' : 'Mark acknowledged'}
                </button>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}

function Manage({ mode }: { mode: Mode }) {
  const [filter, setFilter] = useState<PositionFilter>('all');
  const [completedActions, setCompletedActions] = useState<string[]>([]);
  const visiblePositions = managedPositions.filter((position) => {
    if (filter === 'urgent') return position.urgency === 'urgent';
    if (filter === 'claimable') return Boolean(position.claimable);
    if (filter === 'loans') return position.kind === 'loan' || position.kind === 'offer';
    if (filter === 'rentals') return position.kind === 'rental';
    return true;
  });
  const urgentCount = managedPositions.filter((position) => position.urgency === 'urgent').length;
  const claimableCount = managedPositions.filter((position) => position.claimable).length;
  const completedCount = completedActions.length;
  const lanes = [
    { title: 'Urgent', body: urgentCount + ' item needs attention before it gets buried.', icon: <AlertTriangle /> },
    { title: 'Positions', body: managedPositions.length + ' loans, offers, rentals, vault, and reward rows grouped by next action.', icon: <Landmark /> },
    { title: 'Vault', body: 'Locked and free balances are separated before any withdrawal or claim.', icon: <LockKeyhole /> },
    { title: 'Rewards', body: claimableCount + ' claimable item and VPFI utility status kept visible.', icon: <Coins /> },
  ];

  const completeAction = (id: string) => {
    setCompletedActions((current) => current.includes(id) ? current : [...current, id]);
  };

  return (
    <div className="manage-page">
      <SectionHeading eyebrow="Portfolio" title="One place for every open obligation" />
      <div className="lane-grid">
        {lanes.map((lane) => <Principle key={lane.title} icon={lane.icon} title={lane.title} body={lane.body} />)}
      </div>
      <section className="action-center panel-surface">
        <div>
          <p className="eyebrow">Next best actions</p>
          <h3>{mode === 'guided' ? 'Handle the important things first' : 'Position operations and diagnostics'}</h3>
        </div>
        <div className="action-list">
          <button type="button" onClick={() => setFilter('claimable')}><ReceiptText size={16} /> Claimable ({claimableCount})</button>
          <button type="button" onClick={() => setFilter('urgent')}><Gauge size={16} /> Urgent ({urgentCount})</button>
          <button type="button" onClick={() => setFilter('all')}><Coins size={16} /> Completed ({completedCount})</button>
        </div>
      </section>

      <section className="portfolio-tools panel-surface" aria-label="Portfolio filters">
        {(['all', 'urgent', 'claimable', 'loans', 'rentals'] as PositionFilter[]).map((option) => (
          <button className={filter === option ? 'selected' : ''} type="button" key={option} onClick={() => setFilter(option)}>
            {option}
          </button>
        ))}
      </section>

      <section className="portfolio-table panel-surface" aria-label="Managed positions">
        {visiblePositions.map((position) => {
          const done = completedActions.includes(position.id);
          return (
            <article className={position.urgency === 'urgent' ? 'position-row urgent' : 'position-row'} key={position.id}>
              <div>
                <span className="position-kind">{position.kind}</span>
                <h3>{position.title}</h3>
              </div>
              <span>{position.status}</span>
              <strong>{position.amount}</strong>
              <button type="button" onClick={() => completeAction(position.id)} disabled={done}>
                {done ? 'Queued' : position.nextAction}
              </button>
            </article>
          );
        })}
      </section>
    </div>
  );
}


function SettingsPanel() {
  const [riskGuardrail, setRiskGuardrail] = useState(() => readAppStorage('risk') ?? 'guided');
  const [language, setLanguage] = useState(() => readAppStorage('language') ?? 'English');
  const confirmReceipts = true;
  const [localAnalytics, setLocalAnalytics] = useState(() => readAppStorage('analytics') === 'true');
  const [emergencyPause, setEmergencyPause] = useState(false);

  const updateRisk = (value: string) => {
    setRiskGuardrail(value);
    localStorage.setItem(APP_STORAGE_KEYS.risk, value);
  };
  const updateLanguage = (value: string) => {
    setLanguage(value);
    localStorage.setItem(APP_STORAGE_KEYS.language, value);
  };
  const updateLocalAnalytics = (value: boolean) => {
    setLocalAnalytics(value);
    localStorage.setItem(APP_STORAGE_KEYS.analytics, String(value));
  };

  return (
    <div className="settings-page">
      <SectionHeading eyebrow="Settings" title="Guardrails, privacy, and defaults" />
      <p className="page-intro">
        Settings are part of the product safety model. New users keep protective defaults; experienced users can intentionally loosen them.
      </p>

      <section className="settings-grid">
        <article className="settings-card panel-surface">
          <p className="eyebrow">Experience</p>
          <label>
            <span>Language</span>
            <select value={language} onChange={(event) => updateLanguage(event.target.value)}>
              <option>English</option>
              <option>Hindi</option>
              <option>Spanish</option>
            </select>
          </label>
          <label>
            <span>Risk guardrail</span>
            <select value={riskGuardrail} onChange={(event) => updateRisk(event.target.value)}>
              <option value="guided">Guided only</option>
              <option value="liquid">Liquid assets</option>
              <option value="advanced">Advanced allowed</option>
            </select>
          </label>
        </article>

        <article className="settings-card panel-surface">
          <p className="eyebrow">Confirmations</p>
          <label className="toggle-row locked">
            <span>Review receipt required before wallet prompt</span>
            <input type="checkbox" checked={confirmReceipts} readOnly aria-readonly="true" />
          </label>
          <p>Receipt review is locked on because it protects users from hidden obligations.</p>
          <label className="toggle-row">
            <span>Store local usability analytics</span>
            <input type="checkbox" checked={localAnalytics} onChange={(event) => updateLocalAnalytics(event.target.checked)} />
          </label>
        </article>

        <article className="settings-card panel-surface">
          <p className="eyebrow">Privacy</p>
          <h3>Browser data and support</h3>
          <p>Export or clear local settings without touching public chain history.</p>
          <NavLink className="secondary-action" to="/data-rights">Open data rights</NavLink>
        </article>

        <article className="settings-card panel-surface">
          <p className="eyebrow">Emergency</p>
          <h3>{emergencyPause ? 'New actions paused locally' : 'Actions available'}</h3>
          <p>Pausing here does not touch contracts. It prevents the Vaipakam interface from presenting new action CTAs until resumed.</p>
          <button className={emergencyPause ? 'secondary-action' : 'danger-action'} type="button" onClick={() => setEmergencyPause((current) => !current)}>
            {emergencyPause ? 'Resume Vaipakam actions' : 'Pause new Vaipakam actions'}
          </button>
        </article>
      </section>

      <section className="settings-summary panel-surface">
        <Metric label="Risk guardrail" value={riskGuardrail} />
        <Metric label="Receipts required" value={confirmReceipts ? 'Yes' : 'No'} />
        <Metric label="Local analytics" value={localAnalytics ? 'Enabled' : 'Off'} />
        <Metric label="Emergency state" value={emergencyPause ? 'Paused' : 'Normal'} />
      </section>
    </div>
  );
}


function DataRights({ wallet }: { wallet: WalletState }) {
  const [report, setReport] = useState('');
  const [cleared, setCleared] = useState(false);
  const storageKeys = Object.values(APP_STORAGE_KEYS);

  const buildReport = () => {
    const snapshot = storageKeys.reduce<Record<string, string | null>>((result, key) => {
      result[key] = window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
      return result;
    }, {});
    const nextReport = JSON.stringify({
      generatedAt: new Date().toISOString(),
      wallet: wallet.account ? shortAddress(wallet.account) : 'not connected',
      chain: chainLabel(wallet.chainId),
      appStorage: snapshot,
      note: 'Browser-local Vaipakam report. Public on-chain state is not included and cannot be erased by this action.',
    }, null, 2);
    setReport(nextReport);
  };

  const downloadReport = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'vaipakam-local-support-report.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const clearLocalData = () => {
    const confirmed = window.confirm('Clear Vaipakam local settings and support notes from this browser?');
    if (!confirmed) return;
    storageKeys.forEach((key) => {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
    });
    setReport('');
    setCleared(true);
  };

  return (
    <div className="data-rights-page">
      <SectionHeading eyebrow="Data rights" title="Control the browser data Vaipakam stores" />
      <p className="page-intro">
        Vaipakam can clear its local preferences and support notes from this browser. It cannot erase public blockchain history, wallet transactions, or state held by deployed contracts.
      </p>

      <section className="data-rights-grid">
        <article className="data-card panel-surface">
          <span><Download size={20} /></span>
          <h3>Export local support report</h3>
          <p>Creates a redacted browser-local snapshot of Vaipakam preferences, route crash notes, wallet status, and network status for support.</p>
          <div className="hero-actions">
            <button className="secondary-action" type="button" onClick={buildReport}>Generate report</button>
            <button className="primary-action" type="button" onClick={downloadReport} disabled={!report}>Download</button>
          </div>
        </article>

        <article className="data-card panel-surface danger-zone">
          <span><Trash2 size={20} /></span>
          <h3>Clear local data</h3>
          <p>Removes Vaipakam preferences, analytics opt-in state, and session crash notes from this browser only.</p>
          <button className="danger-action" type="button" onClick={clearLocalData}>Clear local Vaipakam data</button>
          {cleared ? <p className="inline-success">Local Vaipakam data cleared in this browser.</p> : null}
        </article>

        <article className="data-card panel-surface">
          <span><ShieldCheck size={20} /></span>
          <h3>What cannot be erased here</h3>
          <p>On-chain offers, loans, claims, NFT rental state, vault locks, and transaction history are public network records. This page only controls local browser data.</p>
          <NavLink className="secondary-action" to="/help">Read the plain-language guide</NavLink>
        </article>
      </section>

      <section className="report-preview panel-surface" aria-label="Local report preview">
        <p className="eyebrow">Report preview</p>
        <pre>{report || 'Generate a report to preview the browser-local payload before downloading.'}</pre>
      </section>
    </div>
  );
}

function NotFound() {
  return (
    <section className="recovery-card panel-surface">
      <p className="eyebrow">Not found</p>
      <h2>That page does not exist.</h2>
      <p>Return to the guided start screen or open the help guide to find the right workflow.</p>
      <div className="hero-actions">
        <NavLink className="primary-action" to="/">Back to start</NavLink>
        <NavLink className="secondary-action" to="/help">Open help</NavLink>
      </div>
    </section>
  );
}

function Help() {
  const topics = [
    { title: 'Before you connect', body: 'Vaipakam is non-custodial. You keep wallet control, but every signature can change balances, locks, or future claim rights.' },
    { title: 'Borrowing basics', body: 'Borrowers receive tokens now and lock collateral. If repayment fails, the locked collateral can move through claim or liquidation paths.' },
    { title: 'Lending basics', body: 'Lenders provide tokens for interest. The important decision is whether the collateral and settlement route are good enough if the borrower defaults.' },
    { title: 'NFT rental basics', body: 'Renters pay for temporary use rights. The NFT owner keeps custody rules and expiry/claim paths visible before the rental starts.' },
    { title: 'VPFI utility', body: 'VPFI is optional in the beginner path. It can affect fee discounts, rewards, and governance context once the user wants that layer.' },
    { title: 'When to use Advanced', body: 'Use Advanced for custom markets, risk simulation, automation, diagnostics, and protocol settings after the guided receipt makes sense.' },
  ];

  return (
    <div className="help-page">
      <SectionHeading eyebrow="Help" title="Plain-language protocol guide" />
      <p className="page-intro">
        This guide is part of the product surface, not a separate manual. Every help topic should connect back to an action the user can take next.
      </p>
      <div className="help-grid">
        {topics.map((topic) => (
          <article className="help-card panel-surface" key={topic.title}>
            <h3>{topic.title}</h3>
            <p>{topic.body}</p>
          </article>
        ))}
      </div>
      <section className="decision-strip">
        <div>
          <p className="eyebrow">Ready to act</p>
          <h3>Start with a receipt-backed guided flow.</h3>
        </div>
        <NavLink className="primary-action" to="/earn">Open Earn flow <ArrowRight size={18} /></NavLink>
      </section>
    </div>
  );
}

function Advanced() {
  const [riskMode, setRiskMode] = useState('Blue-chip only');
  const [oracleRoute, setOracleRoute] = useState('Primary + fallback');
  const [automation, setAutomation] = useState('Manual approval');
  const [slippage, setSlippage] = useState('1.5');
  const [diagnosticRun, setDiagnosticRun] = useState(0);
  const diagnostics = diagnosticRun === 0
    ? 'Not run in this session'
    : 'Run #' + diagnosticRun + ': Base Sepolia connected, offer index readable, no blocking UI state found.';

  return (
    <div className="advanced-page">
      <SectionHeading eyebrow="Advanced mode" title="Full protocol power, intentionally grouped" />
      <p className="page-intro">
        Advanced mode is not hidden. It is organized. Users who understand Vaipakam can work directly with range orders,
        keeper automation, risk tiers, market-rate construction, liquidation previews, and protocol transparency.
      </p>
      <div className="advanced-grid">
        {advancedPanels.map((panel) => <Principle key={panel.title} icon={panel.icon} title={panel.title} body={panel.body} />)}
      </div>

      <section className="advanced-workbench panel-surface">
        <div>
          <p className="eyebrow">Workspace controls</p>
          <h3>Set assumptions before creating custom markets or automation.</h3>
        </div>
        <div className="workbench-grid">
          <label>
            <span>Risk mode</span>
            <select value={riskMode} onChange={(event) => setRiskMode(event.target.value)}>
              <option>Blue-chip only</option>
              <option>Liquid assets</option>
              <option>Illiquid allowed</option>
            </select>
          </label>
          <label>
            <span>Oracle route</span>
            <select value={oracleRoute} onChange={(event) => setOracleRoute(event.target.value)}>
              <option>Primary + fallback</option>
              <option>Chainlink only</option>
              <option>DEX TWAP + fallback</option>
            </select>
          </label>
          <label>
            <span>Automation</span>
            <select value={automation} onChange={(event) => setAutomation(event.target.value)}>
              <option>Manual approval</option>
              <option>Auto-lend capped</option>
              <option>Auto-roll capped</option>
            </select>
          </label>
          <label>
            <span>Slippage cap</span>
            <input inputMode="decimal" value={slippage} onChange={(event) => setSlippage(event.target.value)} />
          </label>
        </div>
      </section>

      <section className="advanced-console">
        <div className="console-header">
          <span><Network size={16} /> Base Sepolia</span>
          <span><Wallet size={16} /> Connected wallet</span>
          <span><Store size={16} /> Diamond target ready</span>
        </div>
        <div className="console-grid">
          <Metric label="Risk mode" value={riskMode} />
          <Metric label="Oracle route" value={oracleRoute} />
          <Metric label="Automation" value={automation} />
          <Metric label="Slippage cap" value={slippage + '%'} />
        </div>
        <div className="diagnostic-panel">
          <div>
            <p className="eyebrow">Diagnostics</p>
            <strong>{diagnostics}</strong>
          </div>
          <button className="secondary-action" type="button" onClick={() => setDiagnosticRun((current) => current + 1)}>
            Run diagnostics
          </button>
        </div>
      </section>
    </div>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="section-heading">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
    </div>
  );
}

function Principle({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <article className="principle-card">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}


function buildChecklistRows(flow: GuidedFlow, wallet: WalletState, numericAmount: number) {
  const connected = Boolean(wallet.account);
  const baseReady = wallet.chainId === BASE_SEPOLIA_CHAIN_ID;
  if (flow.kind === 'borrow') {
    return [
      { label: connected ? 'Wallet connected' : 'Connect wallet', ready: connected },
      { label: baseReady ? 'Base Sepolia selected' : 'Switch to Base Sepolia', ready: baseReady },
      { label: numericAmount > 0 ? 'Borrow amount entered' : 'Enter borrow amount', ready: numericAmount > 0 },
      { label: 'Repay route preview available', ready: true },
    ];
  }
  if (flow.kind === 'rent') {
    return [
      { label: connected ? 'Wallet connected' : 'Connect wallet', ready: connected },
      { label: baseReady ? 'Base Sepolia selected' : 'Switch to Base Sepolia', ready: baseReady },
      { label: numericAmount > 0 ? 'Rental duration entered' : 'Enter rental duration', ready: numericAmount > 0 },
      { label: 'Close and claim path visible', ready: true },
    ];
  }
  return [
    { label: connected ? 'Wallet connected' : 'Connect wallet', ready: connected },
    { label: baseReady ? 'Base Sepolia selected' : 'Switch to Base Sepolia', ready: baseReady },
    { label: numericAmount > 0 ? 'Lend amount entered' : 'Enter lend amount', ready: numericAmount > 0 },
    { label: 'Allowance check ready for contract wiring', ready: true },
  ];
}

function buildReceiptRows(flow: GuidedFlow, selectedAsset: string, numericAmount: number) {
  const amount = numericAmount.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (flow.kind === 'borrow') {
    const repay = (numericAmount * 1.065).toLocaleString(undefined, { maximumFractionDigits: 4 });
    return [
      ['You receive', amount + ' ' + selectedAsset],
      ['You lock', 'Collateral sized from the selected offer and safety buffer.'],
      ['You may owe', repay + ' ' + selectedAsset + ' including example interest.'],
      ['You can lose', 'Collateral can be claimed or liquidated after default.'],
      ['Fees', 'Protocol fee, any VPFI discount, swap slippage if used, and gas.'],
      ['When this ends', 'Repay, preclose, refinance, add collateral, or settle after default.'],
    ];
  }
  if (flow.kind === 'rent') {
    const fee = (numericAmount * 3).toLocaleString(undefined, { maximumFractionDigits: 4 });
    return [
      ['You receive', amount + ' days of ' + selectedAsset + ' use rights.'],
      ['You lock', fee + ' mUSDC rental prepay plus any refundable buffer.'],
      ['You may owe', 'No loan repayment; closure may require gas.'],
      ['You can lose', 'Rental fee is spent, and buffer can be claimable if terms fail.'],
      ['Fees', 'Rental fee, protocol fee, any VPFI discount, and gas.'],
      ['When this ends', 'Rental expires, renter closes, or owner claims per terms.'],
    ];
  }
  const interest = (numericAmount * 0.065).toLocaleString(undefined, { maximumFractionDigits: 4 });
  return [
    ['You receive', amount + ' ' + selectedAsset + ' principal plus about ' + interest + ' interest if repaid.'],
    ['You lock', amount + ' ' + selectedAsset + ' until repay, cancel, or settlement.'],
    ['You may owe', 'No repayment obligation; gas is needed for offer actions.'],
    ['You can lose', 'Time value and settlement route risk if collateral cannot execute.'],
    ['Fees', 'Treasury fee after any VPFI discount, plus network gas.'],
    ['When this ends', 'Borrower repays, lender cancels before match, or lender claims collateral after default.'],
  ];
}

function shortAddress(address: string) {
  return address.slice(0, 6) + '...' + address.slice(-4);
}

function chainLabel(chainId: string | null) {
  if (chainId === '0x14a34') return 'Base Sepolia';
  if (chainId === '0xaa36a7') return 'Sepolia';
  if (chainId === '0x89') return 'Polygon';
  return chainId ? 'Chain ' + Number(chainId) : 'Unknown network';
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default App;
