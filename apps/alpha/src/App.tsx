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
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={18} />
          <span>Non-custodial. No KYC. User-controlled risk choices.</span>
        </div>
      </aside>

      <main className="main-surface">
        <TopBar />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/earn" element={<FlowPage mode="guided" title="Earn by lending" intro="A guided lending path that starts from assets and expected return, then unfolds risk and protocol details only when needed." steps={earnSteps} />} />
          <Route path="/borrow" element={<FlowPage mode="guided" title="Borrow safely" intro="A borrower-first path that begins with the goal amount, then shows collateral, deadline, and default consequences before signing." steps={borrowSteps} />} />
          <Route path="/rent" element={<FlowPage mode="guided" title="Rent NFT access" intro="A separate mental model for time-limited NFT access, prepaid rental cost, and owner/renter settlement." steps={rentalSteps} />} />
          <Route path="/manage" element={<Manage />} />
          <Route path="/advanced" element={<Advanced />} />
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

function TopBar() {
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Alpha redesign direction</p>
        <h1>Make the first decision easy, then reveal power carefully.</h1>
      </div>
      <div className="mode-switch" aria-label="Experience mode">
        <button className="selected" type="button">Guided</button>
        <button type="button">Advanced</button>
      </div>
    </header>
  );
}

function Home() {
  return (
    <div className="page-grid">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">A DeFi + DEX + NFT rental workspace</p>
          <h2>Vaipakam should feel like choosing an outcome, not decoding a contract.</h2>
          <p>
            The alpha starts with user intent: earn, borrow, rent, or manage. Protocol details such as offer NFTs, vault locks,
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
          <Principle icon={<Layers3 />} title="Advanced when earned" body="Power tools are grouped into an advanced workspace instead of scattered through first-use screens." />
          <Principle icon={<ReceiptText />} title="Every signature gets a receipt" body="Before signing, the user sees exact terms, likely outcomes, and what changes on-chain." />
        </div>
      </section>
    </div>
  );
}

function FlowPage({ title, intro, steps }: { mode: Mode; title: string; intro: string; steps: Step[] }) {
  return (
    <div className="flow-page">
      <section className="flow-hero">
        <div>
          <p className="eyebrow">Guided workflow</p>
          <h2>{title}</h2>
          <p>{intro}</p>
        </div>
        <div className="review-card">
          <span className="review-label">Before wallet opens</span>
          <strong>Human-readable review</strong>
          <p>Terms, risks, fees, collateral, and fallback outcomes are shown before the user signs.</p>
        </div>
      </section>

      <section className="step-board">
        {steps.map((step, index) => (
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

function Manage() {
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
      <section className="portfolio-preview">
        <div className="portfolio-row strong"><span>Loan #2</span><span>Claim ready</span><span>1,000 mUSDC</span></div>
        <div className="portfolio-row"><span>Vault</span><span>1,000 locked / 1,000 free</span><span>mUSDC</span></div>
        <div className="portfolio-row"><span>Risk access</span><span>Blue-chip only</span><span>Strict off</span></div>
        <div className="portfolio-row"><span>Activity</span><span>6 recent grouped events</span><span>Synced</span></div>
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
