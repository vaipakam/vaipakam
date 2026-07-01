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
import { useState } from 'react';
import type { ReactNode } from 'react';

type Mode = 'guided' | 'advanced';

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
  title: string;
  intro: string;
  actionLabel: string;
  assetQuestion: string;
  assetOptions: string[];
  amountLabel: string;
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
    title: 'Earn by lending',
    intro:
      'Start with the asset you can lend, then review collateral quality, expected return, fees, and what happens if the borrower does not repay.',
    actionLabel: 'Prepare lending offer',
    assetQuestion: 'What do you want to lend?',
    assetOptions: ['mUSDC', 'mWETH', 'mWBTC'],
    amountLabel: 'Amount to lend',
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
    title: 'Borrow safely',
    intro:
      'Start with the amount you need. Vaipakam should then show required collateral, repayment deadline, and default consequences before the wallet opens.',
    actionLabel: 'Check borrow terms',
    assetQuestion: 'What do you want to borrow?',
    assetOptions: ['mUSDC', 'mWETH', 'VPFI'],
    amountLabel: 'Target borrow amount',
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
    title: 'Rent NFT access',
    intro:
      'Keep NFT rental separate from borrowing: the renter pays for temporary rights while the NFT remains protected by custody and expiry rules.',
    actionLabel: 'Find rental offer',
    assetQuestion: 'What NFT access do you need?',
    assetOptions: ['Game NFT', 'Membership NFT', 'Utility NFT'],
    amountLabel: 'Rental duration',
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
  const setMode = (nextMode: Mode) => {
    setModeState(nextMode);
    window.localStorage.setItem('vaipakam-alpha-mode', nextMode);
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
        <TopBar mode={mode} onModeChange={setMode} />
        <Routes>
          <Route path="/" element={<Home mode={mode} />} />
          <Route path="/earn" element={<FlowPage flow={guidedFlows.earn} mode={mode} />} />
          <Route path="/borrow" element={<FlowPage flow={guidedFlows.borrow} mode={mode} />} />
          <Route path="/rent" element={<FlowPage flow={guidedFlows.rent} mode={mode} />} />
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

function TopBar({ mode, onModeChange }: { mode: Mode; onModeChange: (mode: Mode) => void }) {
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Alpha redesign direction</p>
        <h1>Make the first decision easy, then reveal power carefully.</h1>
      </div>
      <div className="topbar-controls">
        <div className="wallet-pill" aria-label="Wallet and network status">
          <Wallet size={16} />
          <span>0xE8...23Cb</span>
          <strong>Base Sepolia</strong>
        </div>
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

function FlowPage({ flow, mode }: { flow: GuidedFlow; mode: Mode }) {
  const receiptRows = [
    ['You receive', flow.receipt.receive],
    ['You lock', flow.receipt.lock],
    ['You may owe', flow.receipt.owe],
    ['You can lose', flow.receipt.lose],
    ['Fees', flow.receipt.fees],
    ['When this ends', flow.receipt.ending],
  ];

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
            {flow.assetOptions.map((option, index) => (
              <button className={index === 0 ? 'choice selected' : 'choice'} type="button" key={option}>
                {option}
              </button>
            ))}
          </div>
          <label className="alpha-field">
            <span>{flow.amountLabel}</span>
            <input value={flow.amountLabel.includes('duration') ? '7 days' : '1,000'} readOnly />
          </label>
          <div className="recommendation">
            <BadgeCheck size={18} />
            <span>{flow.recommendedPath}</span>
          </div>
          <p className="field-hint">{flow.amountHint}</p>
        </div>

        <div className="checklist-card panel-surface">
          <p className="eyebrow">Step 2</p>
          <h3>Eligibility checklist</h3>
          <ul>
            {flow.checklist.map((item, index) => (
              <li key={item} className={index < 2 ? 'ready' : 'waiting'}>
                {index < 2 ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                <span>{item}</span>
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
          <button className="primary-action wide" type="button">
            {flow.actionLabel} <ArrowRight size={18} />
          </button>
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

function Manage({ mode }: { mode: Mode }) {
  const lanes = [
    { title: 'Urgent', body: 'Claims, near-default loans, stale risk acknowledgements, failed reads.', icon: <AlertTriangle /> },
    { title: 'Positions', body: 'Active loans, offers, rentals, grouped by what the user can do next.', icon: <Landmark /> },
    { title: 'Vault', body: 'Total, locked, and free assets with explanations for why funds are locked.', icon: <LockKeyhole /> },
    { title: 'Rewards', body: 'VPFI discount status, interaction rewards, and claimable balances.', icon: <Coins /> },
  ];

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
          <button type="button"><ReceiptText size={16} /> Claim 1,000 mUSDC</button>
          <button type="button"><Gauge size={16} /> Review loan health</button>
          <button type="button"><Coins size={16} /> Check VPFI discount</button>
        </div>
      </section>
      <section className="portfolio-preview">
        <div className="portfolio-row strong"><span>Loan #2</span><span>Claim ready</span><span>1,000 mUSDC</span></div>
        <div className="portfolio-row"><span>Vault</span><span>1,000 locked / 1,000 free</span><span>mUSDC</span></div>
        <div className="portfolio-row"><span>Risk access</span><span>Blue-chip only</span><span>Strict off</span></div>
        <div className="portfolio-row"><span>Activity</span><span>6 recent grouped events</span><span>Synced</span></div>
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
      <section className="advanced-console">
        <div className="console-header">
          <span><Network size={16} /> Base Sepolia</span>
          <span><Wallet size={16} /> 0xE8...23Cb</span>
          <span><Store size={16} /> Diamond connected</span>
        </div>
        <div className="console-grid">
          <Metric label="Open offers" value="6 hidden" />
          <Metric label="Active loans" value="1" />
          <Metric label="Claimable" value="1,000 mUSDC" />
          <Metric label="VPFI status" value="Not registered" />
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default App;
