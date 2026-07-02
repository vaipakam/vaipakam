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
import { encodeFunctionData, parseUnits, type Abi, type Address, type Hex } from 'viem';
import OfferCreateFacetAbi from '@vaipakam/contracts/abis/OfferCreateFacet.json';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID_DECIMAL,
  BASE_SEPOLIA_DEPLOYMENT,
  resolveGuidedAsset,
  type GuidedAssetResolution,
} from './guidedAssets';
import { Component, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

type Mode = 'guided' | 'advanced';
type RiskGuardrail = 'guided' | 'liquid' | 'advanced';

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
type GuidedSimulationResult = { status: 'not-run' | 'running' | 'passed' | 'failed'; message: string };

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

type GuidedTransactionPlan = {
  intentTitle: string;
  previewState: string;
  deploymentTarget: string;
  primaryAction: string;
  contractDraft: GuidedContractDraft;
  sequence: string[];
  safetyCopy: string;
  destination: string;
};

type GuidedContractDraft = {
  call: string;
  target: string;
  offerType: string;
  principalAsset: string;
  collateralAsset: string;
  amount: string;
  collateralEstimate: string;
  safetyIndicator: string;
  interestRateBps: string;
  durationDays: string;
  fillMode: string;
  assetSource: string;
  calldataStatus: string;
  calldata: Hex | null;
  simulationStatus: string;
  readiness: 'Ready for simulation' | 'Needs approved assets' | 'Uses rental path';
  blockers: string[];
};

type PreparedGuidedAction = {
  id: string;
  kind: FlowKind;
  title: string;
  asset: string;
  amount: string;
  status: 'Prepared locally';
  createdAtLabel: string;
  nextStep: string;
  sequence: string[];
  contractCall: string;
  collateralEstimate: string;
  safetyIndicator: string;
  readiness: GuidedContractDraft['readiness'];
  preflightGapCount: number;
  calldataStatus: string;
  calldataPreview: string | null;
  simulationStatus: string;
};

const BASE_SEPOLIA_PARAMS = {
  chainId: BASE_SEPOLIA_CHAIN_ID,
  chainName: 'Base Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: [import.meta.env.VITE_BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'],
  blockExplorerUrls: ['https://sepolia.basescan.org'],
};
const OFFER_CREATE_ABI = OfferCreateFacetAbi as Abi;

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
    body: 'Start with a token pair that Vaipakam can price and liquidate on the active chain. Advanced users can still create custom pairs after acknowledging the extra risk.',
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
    actionLabel: 'Mark lending receipt reviewed',
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
    actionLabel: 'Mark borrow receipt reviewed',
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
    actionLabel: 'Mark rental receipt reviewed',
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

const RENT_RATES: Record<string, number> = {
  'Game NFT': 3,
  'Membership NFT': 8,
  'Utility NFT': 5,
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
  actionsPaused: 'vaipakam-app-actions-paused',
} as const;

function readAppStorage(key: keyof typeof APP_STORAGE_KEYS) {
  if (typeof window === 'undefined') return null;
  const storageKey = APP_STORAGE_KEYS[key];
  try {
    return window.localStorage.getItem(storageKey) ?? window.sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeLocalAppStorage(key: keyof typeof APP_STORAGE_KEYS, value: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(APP_STORAGE_KEYS[key], value);
  } catch {
    // Storage can be disabled in hardened browser contexts; UI state should still work in memory.
  }
}

function removeAppStorageValue(storageKey: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Ignore unavailable localStorage.
  }
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Ignore unavailable sessionStorage.
  }
}

function readRawStorageValue(storageKey: string) {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(storageKey) ?? window.sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function App() {
  const [mode, setModeState] = useState<Mode>(() => {
    if (typeof window === 'undefined') return 'guided';
    return readAppStorage('mode') === 'advanced' ? 'advanced' : 'guided';
  });
  const [wallet, setWallet] = useState<WalletState>({ detected: false, account: null, chainId: null, error: null });
  const [preparedActions, setPreparedActions] = useState<PreparedGuidedAction[]>([]);
  const [actionsPaused, setActionsPausedState] = useState(() => readAppStorage('actionsPaused') === 'true');
  const [riskGuardrail, setRiskGuardrailState] = useState<RiskGuardrail>(() => {
    const stored = readAppStorage('risk');
    return stored === 'liquid' || stored === 'advanced' ? stored : 'guided';
  });
  const advancedAllowed = riskGuardrail === 'advanced';
  const setActionsPaused = (paused: boolean) => {
    setActionsPausedState(paused);
    writeLocalAppStorage('actionsPaused', String(paused));
  };
  const setRiskGuardrail = (nextGuardrail: RiskGuardrail) => {
    setRiskGuardrailState(nextGuardrail);
    writeLocalAppStorage('risk', nextGuardrail);
    if (nextGuardrail !== 'advanced') {
      setModeState('guided');
      writeLocalAppStorage('mode', 'guided');
    }
  };
  const setMode = (nextMode: Mode) => {
    if (nextMode === 'advanced' && !advancedAllowed) {
      setModeState('guided');
      writeLocalAppStorage('mode', 'guided');
      return;
    }
    setModeState(nextMode);
    writeLocalAppStorage('mode', nextMode);
  };
  const resetLocalAppState = () => {
    setModeState('guided');
    setRiskGuardrailState('guided');
    setActionsPausedState(false);
    setPreparedActions([]);
  };
  const addPreparedAction = (action: Omit<PreparedGuidedAction, 'id' | 'createdAtLabel'>) => {
    const id = action.kind + '-' + Date.now().toString(36);
    setPreparedActions((current) => [
      { ...action, id, createdAtLabel: 'just now' },
      ...current.filter((item) => item.kind !== action.kind || item.asset !== action.asset || item.amount !== action.amount),
    ].slice(0, 6));
  };

  useEffect(() => {
    if (!advancedAllowed && mode === 'advanced') {
      setModeState('guided');
      writeLocalAppStorage('mode', 'guided');
    }
  }, [advancedAllowed, mode]);

  useEffect(() => {
    setPreparedActions([]);
  }, [wallet.account]);

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
    try {
      const accountsResult = await ethereum.request({ method: 'eth_requestAccounts' });
      const chainIdResult = await ethereum.request({ method: 'eth_chainId' });
      const accounts = Array.isArray(accountsResult) ? accountsResult : [];
      setWallet({
        detected: true,
        account: typeof accounts[0] === 'string' ? accounts[0] : null,
        chainId: typeof chainIdResult === 'string' ? chainIdResult : null,
        error: null,
      });
    } catch {
      setWallet((current) => ({
        ...current,
        detected: true,
        error: 'Wallet connection was rejected or failed.',
      }));
    }
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
        try {
          await ethereum.request({ method: 'wallet_addEthereumChain', params: [BASE_SEPOLIA_PARAMS] });
          await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_SEPOLIA_CHAIN_ID }] });
          const chainIdResult = await ethereum.request({ method: 'eth_chainId' });
          if (chainIdResult !== BASE_SEPOLIA_CHAIN_ID) {
            setWallet((current) => ({ ...current, detected: true, chainId: typeof chainIdResult === 'string' ? chainIdResult : current.chainId, error: 'Base Sepolia was added but is not active yet.' }));
            return;
          }
          setWallet((current) => ({ ...current, detected: true, chainId: BASE_SEPOLIA_CHAIN_ID, error: null }));
        } catch {
          setWallet((current) => ({ ...current, detected: true, error: 'Base Sepolia add-chain request was rejected or failed.' }));
        }
        return;
      }
      setWallet((current) => ({ ...current, error: 'Network switch rejected or failed.' }));
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Vaipakam navigation">
        <NavLink className="brand" to="/">
          <span className="brand-mark">V</span>
          <span>
            <strong>Vaipakam</strong>
            <small>Task-first protocol UI</small>
          </span>
        </NavLink>
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
        <TopBar mode={mode} wallet={wallet} riskGuardrail={riskGuardrail} onConnectWallet={connectWallet} onModeChange={setMode} />
        <RouteErrorBoundary>
          <Routes>
          <Route path="/" element={<Home mode={mode} riskGuardrail={riskGuardrail} />} />
          <Route path="/earn" element={<FlowPage key="earn" flow={guidedFlows.earn} mode={mode} wallet={wallet} actionsPaused={actionsPaused} onConnectWallet={connectWallet} onSwitchNetwork={switchToBaseSepolia} onPrepareAction={addPreparedAction} />} />
          <Route path="/borrow" element={<FlowPage key="borrow" flow={guidedFlows.borrow} mode={mode} wallet={wallet} actionsPaused={actionsPaused} onConnectWallet={connectWallet} onSwitchNetwork={switchToBaseSepolia} onPrepareAction={addPreparedAction} />} />
          <Route path="/rent" element={<FlowPage key="rent" flow={guidedFlows.rent} mode={mode} wallet={wallet} actionsPaused={actionsPaused} onConnectWallet={connectWallet} onSwitchNetwork={switchToBaseSepolia} onPrepareAction={addPreparedAction} />} />
          <Route path="/offers" element={<OfferBook wallet={wallet} actionsPaused={actionsPaused} onConnectWallet={connectWallet} onSwitchNetwork={switchToBaseSepolia} />} />
          <Route path="/claims" element={<Claims wallet={wallet} actionsPaused={actionsPaused} onConnectWallet={connectWallet} onSwitchNetwork={switchToBaseSepolia} />} />
          <Route path="/vault" element={<VaultUtility wallet={wallet} />} />
          <Route path="/activity" element={<Activity wallet={wallet} preparedActions={preparedActions} />} />
          <Route path="/manage" element={<Manage mode={mode} wallet={wallet} actionsPaused={actionsPaused} preparedActions={preparedActions} onConnectWallet={connectWallet} onSwitchNetwork={switchToBaseSepolia} />} />
          <Route path="/advanced" element={<Advanced wallet={wallet} riskGuardrail={riskGuardrail} />} />
          <Route path="/settings" element={<SettingsPanel riskGuardrail={riskGuardrail} actionsPaused={actionsPaused} onRiskGuardrailChange={setRiskGuardrail} onActionsPausedChange={setActionsPaused} />} />
          <Route path="/data-rights" element={<DataRights wallet={wallet} onStorageCleared={resetLocalAppState} />} />
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
    try {
      window.sessionStorage.setItem(APP_STORAGE_KEYS.lastError, JSON.stringify(entry));
    } catch {
      // The recovery screen still renders if session storage is blocked.
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <section className="recovery-card panel-surface" role="alert">
        <p className="eyebrow">Recovery</p>
        <h1>This page could not render safely.</h1>
        <p>The rest of Vaipakam is still available. A redacted crash note was saved in this browser session for support.</p>
        <p className="support-note">Crash details stay in browser storage and can be exported from Data Rights.</p>
        <div className="hero-actions">
          <button className="primary-action" type="button" onClick={() => window.location.reload()}>Reload page</button>
          <a className="secondary-action" href="/">Back to start</a>
          <a className="secondary-action" href="/data-rights">Export support report</a>
        </div>
      </section>
    );
  }
}

function AppNavLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  return (
    <NavLink to={to} end={to === '/'} aria-label={label} title={label} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}

function TopBar({
  mode,
  wallet,
  riskGuardrail,
  onConnectWallet,
  onModeChange,
}: {
  mode: Mode;
  wallet: WalletState;
  riskGuardrail: RiskGuardrail;
  onConnectWallet: () => void;
  onModeChange: (mode: Mode) => void;
}) {
  const advancedAllowed = riskGuardrail === 'advanced';
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Vaipakam Protocol</p>
        <p className="app-tagline">Lend, borrow, rent NFT access, and manage positions from one non-custodial interface.</p>
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
            disabled={!advancedAllowed}
            title={advancedAllowed ? 'Open advanced mode' : 'Enable Advanced allowed in Settings first'}
            onClick={() => onModeChange('advanced')}
          >
            Advanced
          </button>
        </div>
      </div>
    </header>
  );
}

function Home({ mode, riskGuardrail }: { mode: Mode; riskGuardrail: RiskGuardrail }) {
  const advancedAllowed = riskGuardrail === 'advanced';
  return (
    <div className="page-grid">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Decentralized lending, borrowing, and NFT rentals</p>
          <h1>Put idle assets to work, access liquidity, or rent NFT utility with clear terms before every signature.</h1>
          <p>
            Vaipakam combines peer-to-peer ERC-20 credit markets, vault-backed collateral, temporary NFT use rights, claims, rewards, and VPFI utility in a single connected app.
            {mode === 'guided' ? ' Guided mode keeps recommended paths and receipts front and center.' : ' Advanced mode opens custom markets, automation, diagnostics, and risk controls.'}{!advancedAllowed ? ' Advanced tools are previewable and unlock from Settings.' : ''}
          </p>
          <div className="hero-actions">
            <NavLink className="primary-action" to="/earn">Start lending <ArrowRight size={18} /></NavLink>
            <NavLink className="secondary-action" to="/advanced">{advancedAllowed ? 'Open advanced tools' : 'Preview advanced tools'}</NavLink>
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
            <h2>{task.title}</h2>
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
        <SectionHeading eyebrow="Protocol safeguards" title="Clear terms before capital moves" level="section" />
        <div className="principle-list">
          <Principle icon={<LifeBuoy />} title="Guided paths" body="Recommended lending, borrowing, and rental flows keep the next safe action visible." />
          <Principle icon={<Layers3 />} title="Advanced controls" body="Custom markets, automation, diagnostics, and risk tools stay available for experienced users." />
          <Principle icon={<ReceiptText />} title="Review receipts" body="Before signing, users see what they receive, what they lock, what they may owe, fees, loss paths, and how the position ends." />
        </div>
      </section>
    </div>
  );
}

function FlowPage({
  flow,
  mode,
  wallet,
  actionsPaused,
  onConnectWallet,
  onSwitchNetwork,
  onPrepareAction,
}: {
  flow: GuidedFlow;
  mode: Mode;
  wallet: WalletState;
  actionsPaused: boolean;
  onConnectWallet: () => void;
  onSwitchNetwork: () => void;
  onPrepareAction: (action: Omit<PreparedGuidedAction, 'id' | 'createdAtLabel'>) => void;
}) {
  const [selectedAsset, setSelectedAsset] = useState(flow.defaultAsset);
  const [amount, setAmount] = useState(flow.defaultAmount);
  const numericAmount = Number(amount.replace(/,/g, '')) || 0;
  const isBaseSepolia = wallet.chainId === BASE_SEPOLIA_CHAIN_ID;
  const walletReady = Boolean(wallet.account);
  const canProceed = walletReady && isBaseSepolia && numericAmount > 0;
  const [reviewed, setReviewed] = useState(false);
  const [planPrepared, setPlanPrepared] = useState(false);
  const [simulationResult, setSimulationResult] = useState<GuidedSimulationResult>({ status: 'not-run', message: 'Not run yet' });

  useEffect(() => {
    setReviewed(false);
    setPlanPrepared(false);
    setSimulationResult({ status: 'not-run', message: 'Not run yet' });
  }, [flow.kind, selectedAsset, amount]);

  useEffect(() => {
    setReviewed(false);
    setPlanPrepared(false);
    setSimulationResult({ status: 'not-run', message: 'Not run yet' });
  }, [walletReady, isBaseSepolia, wallet.account]);

  const receiptRows = buildReceiptRows(flow, selectedAsset, numericAmount);
  const transactionPlan = buildGuidedTransactionPlan(flow, selectedAsset, numericAmount);
  const checklistRows = buildChecklistRows(flow, wallet, numericAmount);
  const actionBlocked = actionsPaused && walletReady && isBaseSepolia;
  const reviewedOnReadyWallet = reviewed && walletReady && isBaseSepolia;
  const needsAmount = walletReady && isBaseSepolia && !canProceed;
  const preflightGapCount = transactionPlan.contractDraft.blockers.length;
  const simulationCanRun = reviewedOnReadyWallet && Boolean(transactionPlan.contractDraft.calldata) && !actionsPaused;
  const simulationMessage = simulationResult.status === 'not-run' ? transactionPlan.contractDraft.simulationStatus : simulationResult.message;
  const prepareActionLabel = planPrepared
    ? 'Saved in portfolio'
    : preflightGapCount > 0
      ? 'Save preflight draft'
      : 'Prepare local action';
  const actionLabel = !walletReady
    ? 'Connect wallet'
    : !isBaseSepolia
      ? 'Switch to Base Sepolia'
      : actionBlocked
        ? 'Actions paused'
        : canProceed
          ? reviewed
            ? 'Receipt reviewed until page reload'
            : flow.actionLabel
          : 'Enter an amount';
  const primaryDisabled = actionBlocked || reviewedOnReadyWallet || needsAmount;
  const showPrimaryArrow = !primaryDisabled || !walletReady || !isBaseSepolia;
  const handlePrimaryAction = () => {
    if (!walletReady) {
      onConnectWallet();
      return;
    }
    if (!isBaseSepolia) {
      onSwitchNetwork();
      return;
    }
    if (actionsPaused) return;
    if (canProceed) {
      setReviewed(true);
    }
  };
  const runGuidedSimulation = async () => {
    const calldata = transactionPlan.contractDraft.calldata;
    const diamond = BASE_SEPOLIA_DEPLOYMENT?.diamond;
    const ethereum = window.ethereum;
    if (!reviewedOnReadyWallet || !calldata || !diamond || !wallet.account || actionsPaused) {
      setSimulationResult({ status: 'failed', message: 'Simulation is unavailable until wallet, network, target, and calldata are ready.' });
      return;
    }
    if (!ethereum) {
      setSimulationResult({ status: 'failed', message: 'No injected wallet provider is available for eth_call simulation.' });
      return;
    }
    setSimulationResult({ status: 'running', message: 'Running eth_call simulation...' });
    try {
      await ethereum.request({
        method: 'eth_call',
        params: [{ from: wallet.account, to: diamond, data: calldata }, 'latest'],
      });
      setSimulationResult({ status: 'passed', message: 'Simulation passed with eth_call. Wallet submission remains blocked until balance, allowance, and risk checks pass.' });
    } catch (error) {
      setSimulationResult({ status: 'failed', message: 'Simulation failed: ' + formatSimulationError(error) });
    }
  };

  const prepareGuidedAction = () => {
    if (!reviewed || !canProceed || actionsPaused) return;
    onPrepareAction({
      kind: flow.kind,
      title: transactionPlan.intentTitle,
      asset: selectedAsset,
      amount: formatFlowAmount(flow, numericAmount),
      status: 'Prepared locally',
      nextStep: transactionPlan.primaryAction,
      sequence: transactionPlan.sequence,
      contractCall: transactionPlan.contractDraft.call,
      collateralEstimate: transactionPlan.contractDraft.collateralEstimate,
      safetyIndicator: transactionPlan.contractDraft.safetyIndicator,
      readiness: transactionPlan.contractDraft.readiness,
      preflightGapCount,
      calldataStatus: transactionPlan.contractDraft.calldataStatus,
      calldataPreview: transactionPlan.contractDraft.calldata ? shortCalldata(transactionPlan.contractDraft.calldata) : null,
      simulationStatus: simulationMessage,
    });
    setPlanPrepared(true);
  };

  return (
    <div className="flow-page">
      <section className="flow-hero">
        <div>
          <p className="eyebrow">Guided workflow</p>
          <h1>{flow.title}</h1>
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
          <h2>{flow.assetQuestion}</h2>
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
              id={flow.kind + '-amount'}
              name={flow.kind + '-amount'}
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
          <h2>Eligibility checklist</h2>
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
          <h2>Review receipt</h2>
          <dl>
            {receiptRows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <button className="primary-action wide" type="button" disabled={primaryDisabled} onClick={handlePrimaryAction}>
            {actionLabel} {showPrimaryArrow ? <ArrowRight size={18} /> : null}
          </button>
          {reviewed ? <p className="inline-success">Receipt reviewed. Prepare the transaction plan below before any wallet submission.</p> : null}
          {actionsPaused ? <p className="inline-error">New action CTAs are paused from Settings.</p> : null}
          {wallet.error ? <p className="inline-error">{wallet.error}</p> : null}
        </div>
      </section>

      {reviewed ? (
        <section className="transaction-plan panel-surface" aria-label="Guided transaction plan">
          <div className="plan-heading">
            <div>
              <p className="eyebrow">Step 4</p>
              <h2>{transactionPlan.intentTitle}</h2>
              <p>{transactionPlan.safetyCopy}</p>
            </div>
            <div className="simulation-pill">
              <Network size={16} />
              <span>{transactionPlan.previewState}</span>
            </div>
          </div>
          <div className="plan-grid">
            <div>
              <span className="position-kind">Selected terms</span>
              <strong>{formatFlowAmount(flow, numericAmount)} · {selectedAsset}</strong>
            </div>
            <div>
              <span className="position-kind">Wallet action</span>
              <strong>{transactionPlan.primaryAction}</strong>
            </div>
            <div>
              <span className="position-kind">Contract target</span>
              <strong>{transactionPlan.deploymentTarget}</strong>
            </div>
            <div>
              <span className="position-kind">Status</span>
              <strong>{planPrepared ? 'Saved locally' : preflightGapCount > 0 ? preflightGapCount + ' preflight gap' + (preflightGapCount === 1 ? '' : 's') : 'Ready to prepare'}</strong>
            </div>
          </div>
          <section className="contract-draft" aria-label="Contract draft">
            <div className="contract-draft-heading">
              <div>
                <p className="eyebrow">Action details</p>
                <h3>{transactionPlan.contractDraft.call}</h3>
              </div>
              <span className="simulation-pill"><ReceiptText size={16} /> {transactionPlan.contractDraft.readiness}</span>
            </div>
            <div className="draft-grid">
              <Metric label="Target" value={transactionPlan.contractDraft.target} />
              <Metric label="Offer type" value={transactionPlan.contractDraft.offerType} />
              <Metric label="Principal" value={transactionPlan.contractDraft.principalAsset} />
              <Metric label="Collateral" value={transactionPlan.contractDraft.collateralAsset} />
              <Metric label="Amount" value={transactionPlan.contractDraft.amount} />
              <Metric label="Collateral estimate" value={transactionPlan.contractDraft.collateralEstimate} />
              <Metric label="Safety" value={transactionPlan.contractDraft.safetyIndicator} />
              <Metric label="Rate" value={transactionPlan.contractDraft.interestRateBps} />
              <Metric label="Duration" value={transactionPlan.contractDraft.durationDays} />
              <Metric label="Fill mode" value={transactionPlan.contractDraft.fillMode} />
              <Metric label="Asset source" value={transactionPlan.contractDraft.assetSource} />
              <Metric label="Calldata" value={transactionPlan.contractDraft.calldataStatus} />
              <Metric label="Simulation" value={simulationMessage} />
            </div>
            {transactionPlan.contractDraft.calldata ? (
              <p className="calldata-preview">{transactionPlan.contractDraft.calldata.slice(0, 18)}...{transactionPlan.contractDraft.calldata.slice(-10)}</p>
            ) : null}
            {transactionPlan.contractDraft.blockers.length > 0 ? (
              <ul className="blocker-list" aria-label="Preflight blockers">
                {transactionPlan.contractDraft.blockers.map((blocker) => <li key={blocker}><AlertTriangle size={16} /> {blocker}</li>)}
              </ul>
            ) : null}
            <div className={simulationResult.status === 'failed' ? 'simulation-check failed' : simulationResult.status === 'passed' ? 'simulation-check passed' : 'simulation-check'}>
              <div>
                <span className="position-kind">No-send simulation</span>
                <strong>{simulationMessage}</strong>
              </div>
              <button className="secondary-action" type="button" onClick={runGuidedSimulation} disabled={!simulationCanRun || simulationResult.status === 'running'}>
                {simulationResult.status === 'running' ? 'Simulating...' : 'Run simulation'}
              </button>
            </div>
          </section>
          <ol className="plan-steps">
            {transactionPlan.sequence.map((step) => <li key={step}>{step}</li>)}
          </ol>
          <div className="hero-actions">
            <button className="primary-action" type="button" onClick={prepareGuidedAction} disabled={planPrepared || actionsPaused}>
              {prepareActionLabel}
            </button>
            <NavLink className="secondary-action" to={transactionPlan.destination}>Open next workspace</NavLink>
          </div>
          <p className="field-hint">This stores a local prepared action only. Wallet submission stays unavailable until approved asset addresses, allowance checks, and simulation results are ready.</p>
        </section>
      ) : null}

      {mode === 'advanced' ? (
        <section className="advanced-settings panel-surface">
          <div>
            <p className="eyebrow">Advanced controls</p>
            <h2>Power settings stay available without changing the guided path.</h2>
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
            <h2>{step.title}</h2>
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
          <h2>Start simple. Let advanced users opt into more knobs.</h2>
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

type PositionFilter = 'all' | 'urgent' | 'claimable' | 'loans' | 'rentals' | 'reviewed';

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
  const baseReady = wallet.chainId === BASE_SEPOLIA_CHAIN_ID;
  const canPreviewVault = connected && baseReady;
  const visibleVaultAssets = canPreviewVault ? vaultAssets : [];
  const vaultTabs: VaultTab[] = canPreviewVault ? ['assets', 'locks', 'vpfi'] : ['vpfi'];
  const activeVaultTab: VaultTab = canPreviewVault ? tab : 'vpfi';
  const freeCount = visibleVaultAssets.filter((asset) => asset.free !== '0').length;
  const lockedCount = visibleVaultAssets.filter((asset) => asset.locked !== '0' && asset.locked !== '0.00').length;

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
          <span>{baseReady ? 'Base Sepolia' : 'Switch for actions'}</span>
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
        {vaultTabs.map((option) => (
          <button className={activeVaultTab === option ? 'selected' : ''} type="button" key={option} aria-pressed={activeVaultTab === option} onClick={() => setTab(option)}>
            {option}
          </button>
        ))}
      </section>

      {activeVaultTab === 'vpfi' ? (
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
          {!canPreviewVault ? (
            <div className="empty-state">
              <h2>{connected ? 'Switch to Base Sepolia to review vault balances' : 'Connect wallet to review vault balances'}</h2>
              <p>Wallet-specific vault rows stay hidden until Vaipakam can scope them to the connected Base Sepolia account.</p>
            </div>
          ) : null}
          {visibleVaultAssets.map((asset) => (
            <article className="vault-row" key={asset.asset} aria-label={asset.asset + ' vault balance'}>
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

function Claims({ wallet, actionsPaused, onConnectWallet, onSwitchNetwork }: { wallet: WalletState; actionsPaused: boolean; onConnectWallet: () => void; onSwitchNetwork: () => void }) {
  const [reviewedClaimIds, setReviewedClaimIds] = useState<string[]>([]);
  const [filter, setFilter] = useState<'all' | ClaimItem['source']>('all');

  useEffect(() => {
    setReviewedClaimIds([]);
  }, [wallet.account]);
  const walletReady = Boolean(wallet.account);
  const baseReady = wallet.chainId === BASE_SEPOLIA_CHAIN_ID;
  const canPreviewClaims = walletReady && baseReady;
  const visibleClaims = canPreviewClaims ? claimItems.filter((item) => filter === 'all' || item.source === filter) : [];
  const readyCount = canPreviewClaims ? claimItems.filter((item) => item.status === 'Ready' && !reviewedClaimIds.includes(item.id)).length : 0;
  const totalReady = canPreviewClaims ? claimItems
    .filter((item) => item.status === 'Ready' && item.asset === 'mUSDC' && !reviewedClaimIds.includes(item.id))
    .reduce((sum, item) => sum + Number(item.amount.replace(/,/g, '')), 0) : 0;

  const claim = (id: string) => {
    setReviewedClaimIds((current) => current.includes(id) ? current : [...current, id]);
  };

  return (
    <div className="claims-page">
      <SectionHeading eyebrow="Claims and rewards" title="Review claimable value before submitting" />
      <section className="claim-summary">
        <div className="panel-surface">
          <p className="eyebrow">Ready now</p>
          <strong>{readyCount}</strong>
          <span>sample ready rows</span>
        </div>
        <div className="panel-surface">
          <p className="eyebrow">mUSDC ready</p>
          <strong>{totalReady.toLocaleString()}</strong>
          <span>sample amount before gas</span>
        </div>
        <div className="panel-surface">
          <p className="eyebrow">Wallet</p>
          <strong>{walletReady ? 'Connected' : 'Not connected'}</strong>
          <span>{baseReady ? 'Base Sepolia' : 'Network check needed'}</span>
        </div>
      </section>

      {canPreviewClaims ? (
        <section className="portfolio-tools panel-surface" aria-label="Claim filters">
          {(['all', 'loan', 'rental', 'reward', 'discount'] as Array<'all' | ClaimItem['source']>).map((option) => (
            <button className={filter === option ? 'selected' : ''} type="button" key={option} aria-pressed={filter === option} onClick={() => setFilter(option)}>
              {option}
            </button>
          ))}
        </section>
      ) : null}

      <p className="page-intro compact">Claim rows stay hidden until a connected wallet is on Base Sepolia. This prevents fixture data from looking like funds available to every visitor.</p>
      {!walletReady ? (
        <section className="empty-state panel-surface">
          <h2>Connect wallet to review claimables</h2>
          <p>Vaipakam will show claimable previews only after it can scope them to your connected wallet.</p>
          <button className="primary-action" type="button" onClick={onConnectWallet}>Connect wallet</button>
        </section>
      ) : !baseReady ? (
        <section className="empty-state panel-surface">
          <h2>Switch to Base Sepolia</h2>
          <p>Claim previews are gated until the active network matches the supported Vaipakam deployment.</p>
          <button className="primary-action" type="button" onClick={onSwitchNetwork}>Switch to Base Sepolia</button>
        </section>
      ) : null}
      {canPreviewClaims ? (
        <section className="claim-list panel-surface" aria-label="Claimable item previews">
          {visibleClaims.map((item) => {
            const claimed = reviewedClaimIds.includes(item.id);
            const ready = item.status === 'Ready' && !claimed;
            return (
              <article className={ready ? 'claim-row ready' : 'claim-row'} key={item.id} aria-label={item.title}>
                <div>
                  <span className="position-kind">{item.source}</span>
                  <h2>{item.title}</h2>
                  <p>{item.detail}</p>
                </div>
                <strong>{claimed ? 'Reviewed' : item.amount + ' ' + item.asset}</strong>
                <span>{claimed ? 'Reviewed until page reload' : item.status}</span>
                <button type="button" disabled={actionsPaused || claimed || !ready} onClick={() => claim(item.id)}>
                  {actionsPaused ? 'Actions paused' : claimed ? 'Reviewed until reload' : ready ? 'Review claim' : 'Not ready'}
                </button>
              </article>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}

function OfferBook({ wallet, actionsPaused, onConnectWallet, onSwitchNetwork }: { wallet: WalletState; actionsPaused: boolean; onConnectWallet: () => void; onSwitchNetwork: () => void }) {
  const [filter, setFilter] = useState<OfferKind | 'all'>('all');
  const [selectedOfferId, setSelectedOfferId] = useState(marketOffers[0].id);
  const [reviewedOfferId, setReviewedOfferId] = useState<string | null>(null);
  const selectedOffer = marketOffers.find((offer) => offer.id === selectedOfferId) ?? marketOffers[0];
  const visibleOffers = marketOffers.filter((offer) => filter === 'all' || offer.kind === filter);
  const walletReady = Boolean(wallet.account);
  const baseReady = wallet.chainId === BASE_SEPOLIA_CHAIN_ID;
  const offerActionBlocked = actionsPaused && walletReady && baseReady;
  const blocker = !walletReady ? 'Connect wallet to continue' : !baseReady ? 'Switch to Base Sepolia before signing' : offerActionBlocked ? 'Actions paused in Settings' : null;
  const receiptRows = buildOfferReceiptRows(selectedOffer);
  const reviewed = reviewedOfferId === selectedOffer.id && walletReady && baseReady;
  useEffect(() => {
    setReviewedOfferId(null);
  }, [walletReady, baseReady, wallet.account]);
  const selectOfferFilter = (nextFilter: OfferKind | 'all') => {
    setFilter(nextFilter);
    const nextVisibleOffers = marketOffers.filter((offer) => nextFilter === 'all' || offer.kind === nextFilter);
    if (!nextVisibleOffers.some((offer) => offer.id === selectedOfferId)) {
      setSelectedOfferId(nextVisibleOffers[0]?.id ?? marketOffers[0].id);
      setReviewedOfferId(null);
    }
  };

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
              <button className={filter === option ? 'selected' : ''} type="button" key={option} aria-pressed={filter === option} onClick={() => selectOfferFilter(option)}>
                {option}
              </button>
            ))}
          </div>
          <div className="offer-card-list">
            {visibleOffers.map((offer) => (
              <button className={selectedOffer.id === offer.id ? 'offer-card selected' : 'offer-card'} type="button" key={offer.id} aria-pressed={selectedOffer.id === offer.id} aria-label={offer.title} onClick={() => { setSelectedOfferId(offer.id); setReviewedOfferId(null); }}>
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
          <h2>{selectedOffer.title}</h2>
          <dl>
            {receiptRows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {blocker ? <p className="inline-error">{blocker}</p> : null}
          {reviewed ? <p className="inline-success">Reviewed until page reload. Contract action is not submitted yet.</p> : null}
          <button
            className="primary-action wide"
            type="button"
            disabled={offerActionBlocked || reviewed}
            onClick={() => { if (!walletReady) { onConnectWallet(); return; } if (!baseReady) { onSwitchNetwork(); return; } if (actionsPaused) return; setReviewedOfferId(selectedOffer.id); }}
          >
            {reviewed ? 'Reviewed until reload' : blocker ?? selectedOffer.nextAction} {!offerActionBlocked && !reviewed ? <ArrowRight size={18} /> : null}
          </button>
        </aside>
      </section>
    </div>
  );
}


function guidedCollateralEstimate(flow: GuidedFlow, numericAmount: number, principalSymbol: string, collateralSymbol: string) {
  if (flow.kind === 'rent') return 'Prepay and refundable buffer are set by the rental offer.';
  const estimatedValue = numericAmount * 1.5;
  const formattedValue = estimatedValue.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (flow.kind === 'borrow') return 'About ' + formattedValue + ' ' + principalSymbol + '-equivalent of ' + collateralSymbol + ' value before oracle pricing.';
  return 'Borrower should lock about ' + formattedValue + ' ' + principalSymbol + '-equivalent of collateral value.';
}

function guidedSafetyIndicator(flow: GuidedFlow) {
  if (flow.kind === 'rent') return 'Rental buffer pending';
  if (flow.kind === 'borrow') return 'Healthy target: 150% collateral value before live checks';
  return 'Healthy target: borrower collateral covers 150% of lent value';
}

function formatSimulationError(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return 'provider rejected the eth_call request';
}

function formatFlowAmount(flow: GuidedFlow, numericAmount: number) {
  if (flow.kind === 'rent') return numericAmount.toLocaleString() + ' day' + (numericAmount === 1 ? '' : 's');
  return numericAmount.toLocaleString();
}

function guidedDeploymentTarget() {
  if (!BASE_SEPOLIA_DEPLOYMENT?.diamond) return 'Base Sepolia deployment unavailable';
  const offerCreateFacet = BASE_SEPOLIA_DEPLOYMENT.facets.offerCreateFacet;
  if (!offerCreateFacet) return shortAddress(BASE_SEPOLIA_DEPLOYMENT.diamond) + ' · offer facet missing';
  return shortAddress(BASE_SEPOLIA_DEPLOYMENT.diamond) + ' · OfferCreateFacet ready';
}

function guidedPreviewState() {
  if (!BASE_SEPOLIA_DEPLOYMENT?.diamond) return 'Deployment missing';
  if (!BASE_SEPOLIA_DEPLOYMENT.facets.offerCreateFacet) return 'Facet target missing';
  return 'Ready for simulation target';
}

function guidedAssetSourceLabel(...assets: GuidedAssetResolution[]) {
  const sources = new Set(assets.map((asset) => asset.source));
  if (sources.has('missing')) return 'Needs registry entry';
  if (sources.has('environment')) return 'Configured in environment';
  return 'Deployment artifact';
}

function guidedSimulationStatus(calldata: Hex | null, encodingBlockers: string[]) {
  if (!calldata) return encodingBlockers.length > 0 ? 'Unavailable until calldata inputs resolve' : 'Unavailable until calldata is ready';
  return 'Ready for eth_call simulation';
}

function encodeGuidedCreateOfferDraft({
  flow,
  principalAsset,
  collateralAsset,
  numericAmount,
  encodingBlockers,
}: {
  flow: GuidedFlow;
  principalAsset: GuidedAssetResolution;
  collateralAsset: GuidedAssetResolution;
  numericAmount: number;
  encodingBlockers: string[];
}): { calldata: Hex | null; status: string } {
  if (flow.kind === 'rent') return { calldata: null, status: 'Rental path pending' };
  if (encodingBlockers.length > 0) return { calldata: null, status: 'Withheld until calldata inputs resolve' };
  if (!BASE_SEPOLIA_DEPLOYMENT?.diamond || !principalAsset.address || !collateralAsset.address || principalAsset.decimals === null || collateralAsset.decimals === null) {
    return { calldata: null, status: 'Withheld until assets resolve' };
  }

  const principalAmount = parseUnits(String(numericAmount), principalAsset.decimals);
  const collateralAmount = parseUnits(String(numericAmount), collateralAsset.decimals);
  const isBorrow = flow.kind === 'borrow';
  const params = {
    offerType: isBorrow ? 1 : 0,
    lendingAsset: principalAsset.address as Address,
    amount: principalAmount,
    interestRateBps: BigInt(isBorrow ? 710 : 650),
    collateralAsset: collateralAsset.address as Address,
    collateralAmount,
    durationDays: BigInt(isBorrow ? 21 : 30),
    assetType: 0,
    tokenId: 0n,
    quantity: 0n,
    creatorRiskAndTermsConsent: true,
    prepayAsset: '0x0000000000000000000000000000000000000000' as Address,
    collateralAssetType: 0,
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    allowsPartialRepay: true,
    amountMax: 0n,
    interestRateBpsMax: 0n,
    collateralAmountMax: 0n,
    periodicInterestCadence: 0,
    expiresAt: 0n,
    fillMode: 0,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
    useFullTermInterest: false,
  };

  return {
    calldata: encodeFunctionData({
      abi: OFFER_CREATE_ABI,
      functionName: 'createOffer',
      args: [params],
    }) as Hex,
    status: 'Encoded for simulation',
  };
}

function buildGuidedContractDraft(flow: GuidedFlow, selectedAsset: string, numericAmount: number): GuidedContractDraft {
  const diamond = BASE_SEPOLIA_DEPLOYMENT?.diamond;
  const amountText = formatFlowAmount(flow, numericAmount);
  if (flow.kind === 'rent') {
    const prepayToken = resolveGuidedAsset('mUSDC');
    const blockers = ['Confirm the rental-specific action path before opening the wallet.', 'Resolve NFT collection, token standard, token id, and refundable buffer.'];
    if (!prepayToken.address) blockers.push('Approved prepay token address must be confirmed for mUSDC.');
    return {
      call: 'Rental offer adapter pending',
      target: diamond ? shortAddress(diamond) : 'Unavailable',
      offerType: 'Rental',
      principalAsset: prepayToken.display,
      collateralAsset: selectedAsset + ' · NFT details needed',
      amount: amountText,
      collateralEstimate: guidedCollateralEstimate(flow, numericAmount, prepayToken.symbol, prepayToken.symbol),
      safetyIndicator: guidedSafetyIndicator(flow),
      interestRateBps: 'Not applicable',
      durationDays: amountText,
      fillMode: 'Rental terms',
      assetSource: guidedAssetSourceLabel(prepayToken),
      calldataStatus: 'Rental path pending',
      calldata: null,
      simulationStatus: 'Unavailable until rental path is selected',
      readiness: 'Uses rental path',
      blockers,
    };
  }

  const isBorrow = flow.kind === 'borrow';
  const collateralLabel = selectedAsset === 'mUSDC' ? 'mWETH' : 'mUSDC';
  const principalAsset = resolveGuidedAsset(selectedAsset);
  const collateralAsset = resolveGuidedAsset(collateralLabel);
  const encodingBlockers = [];
  const submissionBlockers = [];
  if (!diamond) encodingBlockers.push('Base Sepolia Diamond address is not available in deployments.json.');
  if (!BASE_SEPOLIA_DEPLOYMENT?.facets.offerCreateFacet) encodingBlockers.push('OfferCreateFacet is not present in the generated deployment bundle.');
  if (!principalAsset.address) encodingBlockers.push('Approved token address must be confirmed for ' + principalAsset.symbol + '.');
  if (principalAsset.address && principalAsset.decimals === null) encodingBlockers.push('Token decimals must be confirmed for ' + principalAsset.symbol + '.');
  if (!collateralAsset.address) encodingBlockers.push('Approved collateral address must be confirmed for ' + collateralAsset.symbol + '.');
  if (collateralAsset.address && collateralAsset.decimals === null) encodingBlockers.push('Collateral decimals must be confirmed for ' + collateralAsset.symbol + '.');
  submissionBlockers.push(isBorrow ? 'Wallet balance, allowance, oracle price, and collateral safety must pass before wallet submission.' : 'Funding balance, allowance, and borrower collateral safety must pass before wallet submission.');
  const blockers = [...encodingBlockers, ...submissionBlockers];
  const encoded = encodeGuidedCreateOfferDraft({ flow, principalAsset, collateralAsset, numericAmount, encodingBlockers });

  return {
    call: 'OfferCreateFacet.createOffer(params)',
    target: diamond ? shortAddress(diamond) : 'Unavailable',
    offerType: isBorrow ? 'Borrow request' : 'Lending offer',
    principalAsset: principalAsset.display,
    collateralAsset: collateralAsset.display,
    amount: amountText + ' ' + selectedAsset,
    collateralEstimate: guidedCollateralEstimate(flow, numericAmount, principalAsset.symbol, collateralAsset.symbol),
    safetyIndicator: guidedSafetyIndicator(flow),
    interestRateBps: isBorrow ? '710 bps' : '650 bps',
    durationDays: isBorrow ? '21 days' : '30 days',
    fillMode: 'Single fill',
    assetSource: guidedAssetSourceLabel(principalAsset, collateralAsset),
    calldataStatus: encoded.status,
    calldata: encoded.calldata,
    simulationStatus: guidedSimulationStatus(encoded.calldata, encodingBlockers),
    readiness: encoded.calldata ? 'Ready for simulation' : 'Needs approved assets',
    blockers,
  };
}

function buildGuidedTransactionPlan(flow: GuidedFlow, selectedAsset: string, numericAmount: number): GuidedTransactionPlan {
  const amountText = formatFlowAmount(flow, numericAmount);
  const deploymentTarget = guidedDeploymentTarget();
  const previewState = guidedPreviewState();
  const contractDraft = buildGuidedContractDraft(flow, selectedAsset, numericAmount);
  if (flow.kind === 'earn') {
    return {
      intentTitle: 'Prepare lending offer for ' + amountText + ' ' + selectedAsset,
      previewState,
      deploymentTarget,
      primaryAction: 'Approve asset, then create offer',
      contractDraft,
      sequence: ['Check allowance', 'Approve only the selected amount if needed', 'Create offer from reviewed terms', 'Track offer NFT and cancellation path'],
      safetyCopy: 'Guided lending should become a two-step wallet path only when allowance is missing. The generated deployment bundle supplies the Diamond target; approved asset checks and simulation are the remaining gates before wallet submission.',
      destination: '/offers',
    };
  }
  if (flow.kind === 'borrow') {
    return {
      intentTitle: 'Prepare borrow request for ' + amountText + ' ' + selectedAsset,
      previewState,
      deploymentTarget,
      primaryAction: 'Deposit collateral, then create or accept terms',
      contractDraft,
      sequence: ['Confirm collateral balance', 'Deposit collateral into Vaipakam Vault', 'Create or accept the reviewed borrow terms', 'Track repayment, add-collateral, and claim paths'],
      safetyCopy: 'Borrowing must keep collateral, repayment, and default consequences visible before any wallet prompt. The generated deployment bundle supplies the Diamond target; collateral sizing, approved asset checks, and simulation are the remaining gates before wallet submission.',
      destination: '/manage',
    };
  }
  return {
    intentTitle: 'Prepare NFT rental for ' + amountText,
    previewState,
    deploymentTarget,
    primaryAction: 'Prepay rental, then start rental rights',
    contractDraft,
    sequence: ['Confirm NFT standard support', 'Approve prepaid rental token if needed', 'Start rental with reviewed expiry', 'Track close, owner claim, and renter refund lanes'],
    safetyCopy: 'NFT rental stays separate from borrowing: the renter receives time-limited use rights while custody and expiry rules remain explicit. The generated deployment bundle supplies the Diamond target; the rental-specific action path is the remaining gate before wallet submission.',
    destination: '/offers',
  };
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


function Activity({ wallet, preparedActions }: { wallet: WalletState; preparedActions: PreparedGuidedAction[] }) {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [acknowledgedIds, setAcknowledgedIds] = useState<string[]>([]);

  useEffect(() => {
    setAcknowledgedIds([]);
  }, [wallet.account]);
  const walletReady = Boolean(wallet.account);
  const baseReady = wallet.chainId === BASE_SEPOLIA_CHAIN_ID;
  const canPreviewActivity = walletReady && baseReady;
  const preparedActivityItems: ActivityItem[] = preparedActions.map((action) => ({
    id: action.id,
    source: action.kind === 'earn' ? 'offer' : action.kind === 'borrow' ? 'loan' : 'rental',
    title: action.title,
    detail: action.amount + ' ' + action.asset + ' prepared from Guided mode for ' + action.contractCall + '. Collateral: ' + action.collateralEstimate + '. Safety: ' + action.safetyIndicator + '. Calldata: ' + (action.calldataPreview ?? action.calldataStatus) + '. Simulation: ' + action.simulationStatus + '. No transaction has been submitted.',
    status: 'Local queue',
    when: action.createdAtLabel,
    impact: action.readiness === 'Ready for simulation' ? 'Ready for simulation checks without claiming on-chain completion.' : preflightGapLabel(action.preflightGapCount, 'preflight gap') + ' must be resolved before wallet submission.',
    nextAction: action.nextStep,
    safeForGuided: true,
  }));
  const scopedActivityItems = canPreviewActivity ? [...preparedActivityItems, ...activityItems] : [];
  const visibleItems = scopedActivityItems.filter((item) => filter === 'all' || item.source === filter);
  const reviewCount = scopedActivityItems.filter((item) => item.status === 'Needs review').length;
  const localCount = scopedActivityItems.filter((item) => item.status === 'Local queue').length;
  const acknowledgedCount = canPreviewActivity ? acknowledgedIds.length : 0;

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

      {canPreviewActivity ? (
        <section className="portfolio-tools panel-surface" aria-label="Activity filters">
          {(['all', 'wallet', 'offer', 'loan', 'rental', 'vault', 'reward'] as ActivityFilter[]).map((option) => (
            <button className={filter === option ? 'selected' : ''} type="button" key={option} aria-pressed={filter === option} onClick={() => setFilter(option)}>
              {option}
            </button>
          ))}
        </section>
      ) : null}

      <section className="activity-list panel-surface" aria-label="Readable activity timeline">
        {!canPreviewActivity ? (
          <div className="empty-state">
            <h2>{walletReady ? 'Switch to Base Sepolia to review activity' : 'Connect wallet to review activity'}</h2>
            <p>Wallet-specific timeline rows stay hidden until Vaipakam can scope them to the connected Base Sepolia account.</p>
          </div>
        ) : null}
        {visibleItems.map((item) => {
          const acknowledged = acknowledgedIds.includes(item.id);
          return (
            <article className={item.status === 'Needs review' ? 'activity-row needs-review' : 'activity-row'} key={item.id} aria-label={item.title}>
              <div className="activity-main">
                <span className="position-kind">{item.source} · {item.when}</span>
                <h2>{item.title}</h2>
                <p>{item.detail}</p>
              </div>
              <div className="activity-impact">
                <strong>{item.status}</strong>
                <span>{item.impact}</span>
              </div>
              <div className="activity-action">
                <span>{item.safeForGuided ? 'Guided-safe' : 'Advanced context'} · Next: {item.nextAction}</span>
                <button type="button" onClick={() => acknowledge(item.id)} disabled={acknowledged}>
                  {acknowledged ? 'Acknowledged until reload' : 'Mark acknowledged'}
                </button>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}

function Manage({ mode, wallet, actionsPaused, preparedActions, onConnectWallet, onSwitchNetwork }: { mode: Mode; wallet: WalletState; actionsPaused: boolean; preparedActions: PreparedGuidedAction[]; onConnectWallet: () => void; onSwitchNetwork: () => void }) {
  const [filter, setFilter] = useState<PositionFilter>('all');
  const [reviewedActions, setReviewedActions] = useState<string[]>([]);

  useEffect(() => {
    setReviewedActions([]);
  }, [wallet.account]);
  const walletReady = Boolean(wallet.account);
  const baseReady = wallet.chainId === BASE_SEPOLIA_CHAIN_ID;
  const canPreviewPositions = walletReady && baseReady;
  const scopedPositions = canPreviewPositions ? managedPositions : [];
  const visiblePositions = scopedPositions.filter((position) => {
    if (filter === 'urgent') return position.urgency === 'urgent';
    if (filter === 'claimable') return Boolean(position.claimable);
    if (filter === 'loans') return position.kind === 'loan' || position.kind === 'offer';
    if (filter === 'rentals') return position.kind === 'rental';
    if (filter === 'reviewed') return reviewedActions.includes(position.id);
    return true;
  });
  const actionsBlocked = actionsPaused && walletReady && baseReady;
  const urgentCount = scopedPositions.filter((position) => position.urgency === 'urgent').length;
  const claimableCount = scopedPositions.filter((position) => position.claimable).length;
  const completedCount = canPreviewPositions ? reviewedActions.length : 0;
  const preparedCount = canPreviewPositions ? preparedActions.length : 0;
  const lanes = [
    { title: 'Urgent', body: urgentCount + ' item needs attention before it gets buried.', icon: <AlertTriangle /> },
    { title: 'Positions', body: scopedPositions.length + ' loans, offers, rentals, vault, and reward rows grouped by next action.', icon: <Landmark /> },
    { title: 'Prepared', body: preparedCount + ' guided action draft' + (preparedCount === 1 ? '' : 's') + ' ready for the next workspace.', icon: <ReceiptText /> },
    { title: 'Vault', body: 'Locked and free balances are separated before any withdrawal or claim.', icon: <LockKeyhole /> },
    { title: 'Rewards', body: claimableCount + ' claimable item and VPFI utility status kept visible.', icon: <Coins /> },
  ];

  const completeAction = (id: string) => {
    if (!walletReady) {
      onConnectWallet();
      return;
    }
    if (!baseReady) {
      onSwitchNetwork();
      return;
    }
    if (actionsPaused) return;
    setReviewedActions((current) => current.includes(id) ? current : [...current, id]);
  };

  return (
    <div className="manage-page">
      <SectionHeading eyebrow="Portfolio" title="Portfolio review for open obligations" />
      <p className="page-intro compact">Wallet-scoped rows stay grouped by the action they need next. Wallet: {wallet.account ? shortAddress(wallet.account) : 'not connected'}.</p>
      <div className="lane-grid">
        {lanes.map((lane) => <Principle key={lane.title} icon={lane.icon} title={lane.title} body={lane.body} />)}
      </div>
      <section className="action-center panel-surface">
        <div>
          <p className="eyebrow">Next best actions</p>
          <h2>{mode === 'guided' ? 'Handle the important things first' : 'Position operations and diagnostics'}</h2>
        </div>
        <div className="action-list">
          {canPreviewPositions ? (
            <>
              <button type="button" onClick={() => setFilter('claimable')}><ReceiptText size={16} /> Claimable ({claimableCount})</button>
              <button type="button" onClick={() => setFilter('urgent')}><Gauge size={16} /> Urgent ({urgentCount})</button>
              <button type="button" onClick={() => setFilter('reviewed')}><Coins size={16} /> Reviewed ({completedCount})</button>
              <button type="button" onClick={() => setFilter('all')}><ReceiptText size={16} /> Prepared ({preparedCount})</button>
            </>
          ) : null}
        </div>
      </section>

      {canPreviewPositions ? (
        <section className="portfolio-tools panel-surface" aria-label="Portfolio filters">
          {(['all', 'urgent', 'claimable', 'loans', 'rentals', 'reviewed'] as PositionFilter[]).map((option) => (
            <button className={filter === option ? 'selected' : ''} type="button" key={option} aria-pressed={filter === option} onClick={() => setFilter(option)}>
              {option}
            </button>
          ))}
        </section>
      ) : null}

      {canPreviewPositions && preparedActions.length > 0 ? (
        <section className="prepared-actions panel-surface" aria-label="Prepared guided actions">
          <div className="plan-heading">
            <div>
              <p className="eyebrow">Prepared locally</p>
              <h2>Guided actions ready for preflight review</h2>
            </div>
            <span className="simulation-pill"><ReceiptText size={16} /> {preparedActions.length} draft{preparedActions.length === 1 ? '' : 's'}</span>
          </div>
          {preparedActions.map((action) => (
            <article className="activity-row" key={action.id} aria-label={action.title}>
              <div className="activity-main">
                <span className="position-kind">{action.kind} · {action.createdAtLabel}</span>
                <h2>{action.title}</h2>
                <p>{action.amount} {action.asset}. {action.contractCall} is {action.readiness.toLowerCase()} with {preflightGapLabel(action.preflightGapCount, 'gap')}. Collateral: {action.collateralEstimate}. Safety: {action.safetyIndicator}. Calldata: {action.calldataPreview ?? action.calldataStatus}. Simulation: {action.simulationStatus}. No transaction has been submitted.</p>
              </div>
              <div className="activity-impact">
                <strong>{action.status}</strong>
                <span>{action.sequence.join(' → ')}</span>
              </div>
              <div className="activity-action">
                <span>Next: {action.nextStep}</span>
                <NavLink className="secondary-action" to={action.kind === 'earn' ? '/offers' : action.kind === 'borrow' ? '/manage' : '/offers'}>Open workspace</NavLink>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      <section className="portfolio-table panel-surface" aria-label="Managed positions">
        {!canPreviewPositions ? (
          <div className="empty-state">
            <h2>{walletReady ? 'Switch to Base Sepolia to review positions' : 'Connect wallet to review positions'}</h2>
            <p>Wallet-specific position rows stay hidden until Vaipakam can scope them to the connected Base Sepolia account.</p>
            <button className="primary-action" type="button" onClick={walletReady ? onSwitchNetwork : onConnectWallet}>
              {walletReady ? 'Switch to Base Sepolia' : 'Connect wallet'}
            </button>
          </div>
        ) : null}
        {canPreviewPositions && visiblePositions.length === 0 ? (
          <div className="empty-state">
            <h2>{filter === 'reviewed' ? 'No positions reviewed until reload' : 'No positions match this filter'}</h2>
            <p>{filter === 'reviewed' ? 'Switch to All to see open positions for this wallet.' : 'Try a different portfolio filter.'}</p>
            <button className="secondary-action" type="button" onClick={() => setFilter('all')}>Show all positions</button>
          </div>
        ) : null}
        {visiblePositions.map((position) => {
          const done = reviewedActions.includes(position.id);
          return (
            <article className={position.urgency === 'urgent' ? 'position-row urgent' : 'position-row'} key={position.id} aria-label={position.title}>
              <div>
                <span className="position-kind">{position.kind}</span>
                <h2>{position.title}</h2>
              </div>
              <span>{position.status}</span>
              <strong>{position.amount}</strong>
              <button type="button" onClick={() => completeAction(position.id)} disabled={actionsBlocked || done}>
                {!walletReady ? 'Connect wallet' : !baseReady ? 'Switch network' : actionsPaused ? 'Actions paused' : done ? 'Reviewed until reload' : 'Review: ' + position.nextAction}
              </button>
            </article>
          );
        })}
      </section>
    </div>
  );
}


function SettingsPanel({ riskGuardrail, actionsPaused, onRiskGuardrailChange, onActionsPausedChange }: { riskGuardrail: RiskGuardrail; actionsPaused: boolean; onRiskGuardrailChange: (guardrail: RiskGuardrail) => void; onActionsPausedChange: (paused: boolean) => void }) {
  const [language, setLanguage] = useState('English');
  const confirmReceipts = true;
  const [localAnalytics, setLocalAnalytics] = useState(() => readAppStorage('analytics') === 'true');

  const updateRisk = (value: RiskGuardrail) => {
    onRiskGuardrailChange(value);
  };
  const updateLanguage = (value: string) => {
    setLanguage(value);
  };
  const updateLocalAnalytics = (value: boolean) => {
    setLocalAnalytics(value);
    writeLocalAppStorage('analytics', String(value));
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
            </select>
            <small>English is the only available language in this release.</small>
          </label>
          <label>
            <span>Risk guardrail</span>
            <select value={riskGuardrail} onChange={(event) => updateRisk(event.target.value as RiskGuardrail)}>
              <option value="guided">Guided only</option>
              <option value="liquid">Liquid assets preview</option>
              <option value="advanced">Advanced allowed</option>
            </select>
            <small>{riskGuardrail === 'liquid' ? 'Liquid-asset filtering will apply when live markets are wired; advanced tools remain locked.' : 'Advanced allowed unlocks custom markets and automation.'}</small>
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
          <h2>Browser data and support</h2>
          <p>Export or clear local settings without touching public chain history.</p>
          <NavLink className="secondary-action" to="/data-rights">Open data rights</NavLink>
        </article>

        <article className="settings-card panel-surface">
          <p className="eyebrow">Emergency</p>
          <h2>{actionsPaused ? 'New actions paused locally' : 'Actions available'}</h2>
          <p>Pausing here does not touch contracts. It prevents the Vaipakam interface from presenting new action CTAs until resumed.</p>
          <button className={actionsPaused ? 'secondary-action' : 'danger-action'} type="button" onClick={() => onActionsPausedChange(!actionsPaused)}>
            {actionsPaused ? 'Resume Vaipakam actions' : 'Pause new Vaipakam actions'}
          </button>
        </article>
      </section>

      <section className="settings-summary panel-surface">
        <Metric label="Risk guardrail" value={riskGuardrail} />
        <Metric label="Receipts required" value={confirmReceipts ? 'Yes' : 'No'} />
        <Metric label="Local analytics" value={localAnalytics ? 'Enabled' : 'Off'} />
        <Metric label="Emergency state" value={actionsPaused ? 'Paused' : 'Normal'} />
      </section>
    </div>
  );
}


function DataRights({ wallet, onStorageCleared }: { wallet: WalletState; onStorageCleared: () => void }) {
  const [report, setReport] = useState('');
  const [cleared, setCleared] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const storageKeys = Object.values(APP_STORAGE_KEYS);

  const buildReport = () => {
    const snapshot = storageKeys.reduce<Record<string, string | null>>((result, key) => {
      result[key] = readRawStorageValue(key);
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
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const clearLocalData = () => {
    storageKeys.forEach((key) => {
      removeAppStorageValue(key);
    });
    setReport('');
    setConfirmClear(false);
    setCleared(true);
    onStorageCleared();
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
          <h2>Export local support report</h2>
          <p>Creates a redacted browser-local snapshot of Vaipakam preferences, route crash notes, wallet status, and network status for support.</p>
          <div className="hero-actions">
            <button className="secondary-action" type="button" onClick={buildReport}>Generate report</button>
            <button className="primary-action" type="button" onClick={downloadReport} disabled={!report}>Download</button>
          </div>
        </article>

        <article className="data-card panel-surface danger-zone">
          <span><Trash2 size={20} /></span>
          <h2>Clear local data</h2>
          <p>Removes Vaipakam preferences, analytics opt-in state, and session crash notes from this browser only.</p>
          {confirmClear ? (
            <div className="confirm-strip">
              <span>Clear Vaipakam local settings and support notes from this browser?</span>
              <button className="danger-action" type="button" onClick={clearLocalData}>Confirm clear</button>
              <button className="secondary-action" type="button" onClick={() => setConfirmClear(false)}>Cancel</button>
            </div>
          ) : (
            <button className="danger-action" type="button" onClick={() => setConfirmClear(true)}>Clear local Vaipakam data</button>
          )}
          {cleared ? <p className="inline-success">Local Vaipakam data cleared in this browser.</p> : null}
        </article>

        <article className="data-card panel-surface">
          <span><ShieldCheck size={20} /></span>
          <h2>What cannot be erased here</h2>
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
      <h1>That page does not exist.</h1>
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
            <h2>{topic.title}</h2>
            <p>{topic.body}</p>
          </article>
        ))}
      </div>
      <section className="decision-strip">
        <div>
          <p className="eyebrow">Ready to act</p>
          <h2>Start with a receipt-backed guided flow.</h2>
        </div>
        <NavLink className="primary-action" to="/earn">Open Earn flow <ArrowRight size={18} /></NavLink>
      </section>
    </div>
  );
}

function Advanced({ wallet, riskGuardrail }: { wallet: WalletState; riskGuardrail: RiskGuardrail }) {
  const [riskMode, setRiskMode] = useState('Blue-chip only');
  const [oracleRoute, setOracleRoute] = useState('Primary + fallback');
  const [automation, setAutomation] = useState('Manual approval');
  const [slippage, setSlippage] = useState('1.5');
  const [diagnosticRun, setDiagnosticRun] = useState(0);
  const diagnostics = diagnosticRun === 0
    ? 'Not run in this session'
    : wallet.account && wallet.chainId === BASE_SEPOLIA_CHAIN_ID
      ? 'Run #' + diagnosticRun + ': Base Sepolia connected, wallet readable, no blocking UI state found.'
      : 'Run #' + diagnosticRun + ': Connect wallet and switch to Base Sepolia before using advanced actions.';

  if (riskGuardrail !== 'advanced') {
    return (
      <div className="advanced-page">
        <SectionHeading eyebrow="Advanced mode" title="Advanced controls are locked by your guardrail" />
        <p className="page-intro">Your current risk guardrail keeps Vaipakam in guided mode. Enable Advanced allowed in Settings when you are ready to use custom markets, automation, diagnostics, and risk controls.</p>
        <NavLink className="primary-action" to="/settings">Open Settings</NavLink>
      </div>
    );
  }

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
          <h2>Set assumptions before creating custom markets or automation.</h2>
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
            <input type="number" min="0" max="25" step="0.1" inputMode="decimal" value={slippage} onChange={(event) => { const value = event.target.value; if (value === '') { setSlippage(''); return; } const raw = Number(value); if (!Number.isNaN(raw)) setSlippage(String(Math.max(0, Math.min(25, raw)))); }} />
          </label>
        </div>
      </section>

      <section className="advanced-console">
        <div className="console-header">
          <span><Network size={16} /> {chainLabel(wallet.chainId)}</span>
          <span><Wallet size={16} /> {wallet.account ? 'Wallet connected' : 'Wallet not connected'}</span>
          <span><Store size={16} /> {wallet.chainId === BASE_SEPOLIA_CHAIN_ID ? 'Diamond target ready' : 'Switch network for actions'}</span>
        </div>
        <div className="console-grid">
          <Metric label="Risk mode" value={riskMode} />
          <Metric label="Oracle route" value={oracleRoute} />
          <Metric label="Automation" value={automation} />
          <Metric label="Slippage cap" value={(slippage || '0') + '%'} />
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

function SectionHeading({ eyebrow, title, level = 'page' }: { eyebrow: string; title: string; level?: 'page' | 'section' }) {
  const Heading = level === 'page' ? 'h1' : 'h2';
  return (
    <div className="section-heading">
      <p className="eyebrow">{eyebrow}</p>
      <Heading>{title}</Heading>
    </div>
  );
}

function Principle({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <article className="principle-card">
      <span>{icon}</span>
      <h2>{title}</h2>
      <p>{body}</p>
    </article>
  );
}


function shortCalldata(value: Hex) {
  return value.slice(0, 18) + '...' + value.slice(-10);
}

function preflightGapLabel(value: number | undefined, noun: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'untracked ' + noun + 's';
  return value + ' ' + noun + (value === 1 ? '' : 's');
}

function buildChecklistRows(flow: GuidedFlow, wallet: WalletState, numericAmount: number) {
  const connected = Boolean(wallet.account);
  const baseReady = wallet.chainId === BASE_SEPOLIA_CHAIN_ID;
  if (flow.kind === 'borrow') {
    return [
      { label: connected ? 'Wallet connected' : 'Connect wallet', ready: connected },
      { label: baseReady ? 'Base Sepolia selected' : 'Switch to Base Sepolia', ready: baseReady },
      { label: numericAmount > 0 ? 'Borrow amount entered' : 'Enter borrow amount', ready: numericAmount > 0 },
      { label: 'Repay route will be checked before signing', ready: false },
    ];
  }
  if (flow.kind === 'rent') {
    return [
      { label: connected ? 'Wallet connected' : 'Connect wallet', ready: connected },
      { label: baseReady ? 'Base Sepolia selected' : 'Switch to Base Sepolia', ready: baseReady },
      { label: numericAmount > 0 ? 'Rental duration entered' : 'Enter rental duration', ready: numericAmount > 0 },
      { label: 'Close and claim path will be checked before signing', ready: false },
    ];
  }
  return [
    { label: connected ? 'Wallet connected' : 'Connect wallet', ready: connected },
    { label: baseReady ? 'Base Sepolia selected' : 'Switch to Base Sepolia', ready: baseReady },
    { label: numericAmount > 0 ? 'Lend amount entered' : 'Enter lend amount', ready: numericAmount > 0 },
    { label: 'Allowance will be checked before signing', ready: false },
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
    const dailyRate = RENT_RATES[selectedAsset] ?? RENT_RATES[flow.defaultAsset] ?? 3;
    const fee = (numericAmount * dailyRate).toLocaleString(undefined, { maximumFractionDigits: 4 });
    return [
      ['You receive', amount + ' days of ' + selectedAsset + ' use rights.'],
      ['You lock', fee + ' mUSDC rental prepay plus any refundable buffer.'],
      ['You may owe', 'No loan repayment; closure may require gas.'],
      ['You can lose', 'Rental fee is spent, and buffer can be claimable if terms fail.'],
      ['Fees', dailyRate + ' mUSDC/day rental fee, protocol fee, any VPFI discount, and gas.'],
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
  if (chainId === '0x2105') return 'Base';
  if (chainId === '0x1') return 'Ethereum';
  if (chainId === '0xaa36a7') return 'Sepolia';
  if (chainId === '0x66eee') return 'Arbitrum Sepolia';
  if (chainId === '0x38') return 'BNB Chain';
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
