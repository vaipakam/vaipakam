import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Box,
  BriefcaseBusiness,
  CandlestickChart,
  CheckCircle2,
  ChevronRight,
  Coins,
  Gauge,
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
} from 'lucide-react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

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

function App() {
  const [mode, setModeState] = useState<Mode>(() => {
    if (typeof window === 'undefined') return 'guided';
    return window.localStorage.getItem('vaipakam-alpha-mode') === 'advanced' ? 'advanced' : 'guided';
  });
  const [wallet, setWallet] = useState<WalletState>({ detected: false, account: null, chainId: null, error: null });
  const setMode = (nextMode: Mode) => {
    setModeState(nextMode);
    window.localStorage.setItem('vaipakam-alpha-mode', nextMode);
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
      <aside className="sidebar" aria-label="Vaipakam Alpha navigation">
        <a className="brand" href="/">
          <span className="brand-mark">V</span>
          <span>
            <strong>Vaipakam Alpha</strong>
            <small>Task-first protocol UI</small>
          </span>
        </a>
        <nav className="nav-list">
          <AlphaNavLink to="/" label="Start" icon={<Sparkles />} />
          <AlphaNavLink to="/earn" label="Earn" icon={<PiggyBank />} />
          <AlphaNavLink to="/borrow" label="Borrow" icon={<HandCoins />} />
          <AlphaNavLink to="/rent" label="NFT Rental" icon={<Box />} />
          <AlphaNavLink to="/manage" label="Manage" icon={<BriefcaseBusiness />} />
          <AlphaNavLink to="/advanced" label="Advanced" icon={<SlidersHorizontal />} />
          <AlphaNavLink to="/help" label="Help" icon={<LifeBuoy />} />
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={18} />
          <span>Non-custodial. No KYC. User-controlled risk choices.</span>
        </div>
      </aside>

      <main className="main-surface">
        <TopBar mode={mode} wallet={wallet} onConnectWallet={connectWallet} onModeChange={setMode} />
        <Routes>
          <Route path="/" element={<Home mode={mode} />} />
          <Route path="/earn" element={<FlowPage flow={guidedFlows.earn} mode={mode} wallet={wallet} onConnectWallet={connectWallet} onSwitchNetwork={switchToBaseSepolia} />} />
          <Route path="/borrow" element={<FlowPage flow={guidedFlows.borrow} mode={mode} wallet={wallet} onConnectWallet={connectWallet} onSwitchNetwork={switchToBaseSepolia} />} />
          <Route path="/rent" element={<FlowPage flow={guidedFlows.rent} mode={mode} wallet={wallet} onConnectWallet={connectWallet} onSwitchNetwork={switchToBaseSepolia} />} />
          <Route path="/manage" element={<Manage mode={mode} />} />
          <Route path="/advanced" element={<Advanced />} />
          <Route path="/help" element={<Help />} />
        </Routes>
      </main>
    </div>
  );
}

function AlphaNavLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
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
        <p className="eyebrow">Alpha redesign direction</p>
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
            The alpha starts in {mode} mode with user intent: earn, borrow, rent, or manage. Protocol details such as offer NFTs, vault locks,
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

      <section className="guided-board" aria-label={flow.title + ' alpha flow'}>
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
          <label className="alpha-field">
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
          <p className="eyebrow">Alpha interaction model</p>
          <h3>Start simple. Let advanced users opt into more knobs.</h3>
        </div>
        <NavLink className="secondary-action" to="/advanced">See advanced controls</NavLink>
      </section>
    </div>
  );
}

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
