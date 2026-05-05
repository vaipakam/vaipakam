import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Vault, ExternalLink, RefreshCw, AlertCircle, Check } from 'lucide-react';
import { useRescanCooldown } from '../hooks/useRescanCooldown';
import { parseAbi, type Address } from 'viem';
import { useWallet } from '../context/WalletContext';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { useUserEscrowAddress } from '../hooks/useUserEscrowAddress';
import { useIndexedLoansForWallet } from '../hooks/useIndexedLoans';
import { fetchOffersByCreator, type IndexedOffer } from '../lib/indexerClient';
import { useLiveWatermark } from '../hooks/useLiveWatermark';
import { peekTokenMeta, prewarmTokenMeta } from '../lib/tokenMeta';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { CardInfo } from '../components/CardInfo';
import { AssetLink } from '../components/app/AssetLink';
import { TokenIcon } from '../components/app/TokenIcon';
import { TokenAmount } from '../components/app/TokenAmount';
import { DEFAULT_CHAIN } from '../contracts/config';

// Minimal read-only ERC-20 ABI — only the call this page needs.
const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
]);

// EscrowFactoryFacet view that returns the per-(user, token) protocol-
// tracked counter. Used together with the ERC-20 balanceOf to compute
// `min(balanceOf, tracked)` — see T-051 / T-054 design notes.
const ESCROW_FACTORY_TRACKED_ABI = parseAbi([
  'function getProtocolTrackedEscrowBalance(address user, address token) view returns (uint256)',
]);

interface TokenRow {
  /** Token contract address. */
  address: string;
  /** Display label override if symbol resolution is unreliable. */
  hint?: string;
  /** Latest balance — `null` while still loading; `0n` when resolved-empty. */
  balance: bigint | null;
  /** Resolved ERC-20 `decimals()` for the token. Used by the
   *  zero-vs-dust filter so we don't accidentally classify a
   *  small-but-significant 6-dec USDC balance as dust. `null` while
   *  the meta read is still in flight; the filter treats `null` as
   *  "show" so loading rows render until decimals resolve. */
  decimals: number | null;
}

/**
 * Display-units threshold below which a balance is considered "dust"
 * and hidden behind the `Show all` toggle. Picked at `1e-11` to match
 * common UX conventions on dust filters: covers the rounding-residue
 * dust on 18-decimal ETH-class tokens (~10 gwei equivalent) without
 * ever hiding any non-zero balance on a ≤10-decimal token (1 wei on
 * a 10-dec token displays as 1e-10, which is still above the
 * threshold). The math is in wei to keep precision: for tokens with
 * `> 10` dec, threshold = `10^(decimals - 11)` wei; tokens with
 * `≤ 10` dec are exempt from the filter (any non-zero balance shows).
 */
function isDustBalance(balance: bigint, decimals: number): boolean {
  if (balance === 0n) return false; // zero is its own filter; not dust
  if (decimals <= 10) return false;
  // threshold in wei = 10^(decimals - 11) — strictly less = dust.
  const threshold = 10n ** BigInt(decimals - 11);
  return balance < threshold;
}

/** Token-discovery design (Vault page):
 *
 *  Vaipakam is asset-agnostic — the platform doesn't curate which
 *  ERC-20s users may transact in. Any address the user has used as a
 *  lending or collateral asset on a real loan / offer is a token whose
 *  escrow balance the Vault should be able to show. There is no
 *  static "approved tokens" list, no allowlist, no chain-shape table
 *  to keep in sync. The previous static list (`knownProtocolTokens`,
 *  reading from the deployments record's `vpfiToken` / `weth` /
 *  `mockERC20A` / `mockERC20B` fields) was dropped after it caused a
 *  display bug: each flow-test run deploys fresh `new ERC20Mock(...)`
 *  contracts whose addresses are never written back into
 *  `addresses.json`, so a wallet with a 1,000-mUSDC escrow balance
 *  rendered as zero because the Vault page never knew "mUSDC" was a
 *  token to render.
 *
 *  Discovery sources (both cache-backed via the worker indexer's D1,
 *  fronted by the worker REST endpoints — no direct historical RPC
 *  reads):
 *
 *    1. `useIndexedLoansForWallet(addr)` — every loan the wallet
 *       participated in on either side. Surfaces `lendingAsset`,
 *       `collateralAsset` for every entry.
 *    2. `fetchOffersByCreator(chainId, addr)` — every offer the
 *       wallet created (active, filled, cancelled). Surfaces the
 *       same asset fields.
 *
 *  Refresh cadence:
 *    - Worker cron writes D1 every 5 min (* /5 * * * * schedule).
 *    - Frontend hooks subscribe to the live-tail watermark
 *      (20 s probe on this page, paused on hidden, refetch on
 *      tab-focus / counter-advance / post-tx receipt / manual
 *      rescan). Discovery is therefore continuously fresh without
 *      hitting the chain RPC.
 *
 *  Per-token balance + tracked-counter reads ARE direct RPC reads —
 *  those values must be live (a stale balance would mislead the
 *  user). The `min(balanceOf, protocolTrackedEscrowBalance)` gate
 *  is preserved per-token, so an untracked balance still shows zero.
 *  The change here is which tokens get checked, not the trust model.
 */

/**
 * T-051 — Escrow Assets page.
 *
 * Displays the connected user's per-user escrow proxy address
 * (redacted, non-selectable) and the balance of every protocol-managed
 * token currently in custody on this chain. Intentionally narrow in
 * scope: it shows ONLY tokens the Vaipakam protocol routes through the
 * escrow, NOT raw `balanceOf` of arbitrary assets the user may have
 * sent directly to the escrow address. Per the locked design in
 * `docs/DesignsAndPlans/EscrowStuckRecoveryDesign.md`:
 *
 *   - Default UI shows only protocol-managed tokens.
 *   - A single warning line informs users not to send tokens directly.
 *   - There is NO "stuck tokens" section, no "[Recover]" button. The
 *     recovery flow is reachable only via the Advanced User Guide
 *     deep-link by design — naive users who got dusted should not
 *     accidentally find a button that risks self-sanctioning their
 *     escrow.
 *
 * Phase-1 limitation: until T-054 PR-1 lands the
 * `protocolTrackedEscrowBalance[user][token]` counter, this page
 * shows the raw on-chain `balanceOf(escrow, token)` for each known
 * protocol token. With current usage patterns (tokens arrive ONLY via
 * `escrowDepositERC20`-mediated flows for protocol-tracked categories
 * + direct `safeTransferFrom` from the Diamond on offer/accept),
 * raw-balance ≈ tracked-balance. Once the counter ships, swap the
 * read to `min(balanceOf, tracked)`.
 */
export default function EscrowAssets() {
  const { t } = useTranslation();
  const { address, activeChain, isCorrectChain } = useWallet();
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const escrow = useUserEscrowAddress(address);
  const blockExplorer =
    (activeChain && isCorrectChain ? activeChain.blockExplorer : null) ??
    DEFAULT_CHAIN.blockExplorer;
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;

  // Token discovery — see header comment "Token-discovery design"
  // above for the full rationale. Pure-history; no static lists, no
  // hardcoded curation.
  //
  // Loan side comes from the indexer hook directly.
  const { loans: discoveredLoans } = useIndexedLoansForWallet(address ?? undefined);

  // Offer side comes from the worker REST endpoint (`/offers/by-creator`).
  // We don't reuse `useMyOffers` here because that hook fires per-id
  // `getOffer(...)` RPC reads for every active offer to pull live
  // state — useful for the Dashboard "Your Offers" card, but for
  // *token discovery* we only need the asset addresses, which the
  // worker D1 already has from the offer-detail-refresh cron. Hitting
  // the worker REST is one HTTPS call vs N RPC calls, and the data
  // is the same to two-decimal cron-staleness.
  //
  // Subscribed to the live-tail watermark so a freshly-created offer
  // surfaces here without waiting for tab focus / manual rescan.
  // Polls at 20 s on this page, paused on tab hidden, immediate
  // refetch on tab refocus.
  const { version: watermarkVersion } = useLiveWatermark({ pollIntervalMs: 20_000 });
  const [discoveredOffers, setDiscoveredOffers] = useState<IndexedOffer[]>([]);
  useEffect(() => {
    if (!address) {
      setDiscoveredOffers([]);
      return;
    }
    let cancelled = false;
    const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
    void fetchOffersByCreator(chainId, address, { limit: 200 }).then((page) => {
      if (cancelled) return;
      setDiscoveredOffers(page?.offers ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [address, chain.chainId, watermarkVersion]);

  const tokens = useMemo(() => {
    const out: { address: string; hint?: string }[] = [];
    const seen = new Set<string>();
    const push = (addr: string | null | undefined) => {
      if (!addr) return;
      const key = addr.toLowerCase();
      if (key === '0x0000000000000000000000000000000000000000') return;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ address: addr });
    };
    for (const loan of discoveredLoans ?? []) {
      // ERC-20 lending assets only — NFT lending (assetType !== 0) is
      // a tokenId-keyed position, not a fungible balance to display
      // here. Same gate on the collateral side.
      if (loan.assetType === 0) push(loan.lendingAsset);
      if (loan.collateralAssetType === 0) push(loan.collateralAsset);
    }
    for (const o of discoveredOffers) {
      // Indexer-served offer rows carry both asset types, so we can
      // gate cleanly here without falling back to ERC-20-only assumptions.
      if (o.assetType === 0) push(o.lendingAsset);
      if (o.collateralAssetType === 0) push(o.collateralAsset);
    }
    return out;
  }, [discoveredLoans, discoveredOffers]);

  const [rows, setRows] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);
  // Single toggle that controls BOTH the zero-display filter AND the
  // dust-display filter together. Default OFF (show every row,
  // including zero / dust / untracked) so the user sees what's
  // actually in their escrow without the page silently swallowing
  // anything. Click to flip ON — hides every "uninteresting"
  // balance: rows where `min(balanceOf, tracked) === 0n` (untracked
  // tokens, which display as 0 by the trust-model gate) AND rows
  // whose display value is below the dust threshold (1×10⁻¹¹).
  // Earlier shipped as two separate filters (always-on zero +
  // toggleable dust) but that left zero rows unrevealable, even
  // though the user might want to verify "is something in there
  // that the protocol isn't tracking?" — with the unified toggle a
  // single click reveals every row that's been silenced.
  const [hideLowBalances, setHideLowBalances] = useState(false);
  // Sort state for the holdings table. `'balance' + 'desc'` is the
  // default — biggest holdings at the top is the most useful glance
  // for "what do I have here." Click a column header to flip
  // direction; click a different header to switch column.
  type SortBy = 'symbol' | 'balance';
  type SortDir = 'asc' | 'desc';
  const [sortBy, setSortBy] = useState<SortBy>('balance');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const toggleSort = (col: SortBy) => {
    if (col === sortBy) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      // Sensible per-column default: symbols ascending (A→Z),
      // balances descending (biggest first).
      setSortDir(col === 'balance' ? 'desc' : 'asc');
    }
  };
  // Same cooldown + sync-status state-machine the Activity / OfferBook
  // rescan buttons use. Drives the button label transitions
  // (`Refresh` → `Refreshing… 28s` → `Synced — 5s` → `Refresh`),
  // the inline progress bar, and the 30 s spam-click guard.
  const rescanCooldown = useRescanCooldown({ loading });

  // Initial seed — show one row per token in a "loading" state so the
  // table doesn't reflow when balances arrive.
  useEffect(() => {
    setRows(
      tokens.map((tk) => ({ address: tk.address, hint: tk.hint, balance: null, decimals: null })),
    );
  }, [tokens]);

  // Fetch each token's protocol-tracked balance against the user's
  // escrow proxy. Done in a single Promise.all so the "still loading"
  // window is bounded by the slowest read; per-token failures fall
  // back to `0n` rather than killing the whole page.
  //
  // Display rule: `min(balanceOf, protocolTrackedEscrowBalance)`. The
  // counter (introduced under T-051) tracks every protocol-mediated
  // deposit / withdrawal — anything sitting in the proxy that's not
  // counted is unsolicited dust (taint, accidental direct sends).
  // `min` hides those from the UI so users see only what the protocol
  // actually manages on their behalf.
  //
  // Pre-counter testnet caveat: legacy stakes that were deposited
  // before the counter shipped will read tracked = 0, hence min = 0,
  // and look "empty" until the user re-deposits via the new
  // chokepoint. This is documented as a one-time testnet display
  // cutover; on a fresh mainnet deploy the counter starts ticking
  // from day 1 so this case doesn't occur.
  useEffect(() => {
    if (!escrow || !publicClient || !diamondAddress || tokens.length === 0) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const userAddr = address as Address;
    Promise.all(
      tokens.map(async (tk) => {
        try {
          const [bal, tracked, decimalsRead] = await Promise.all([
            publicClient.readContract({
              address: tk.address as Address,
              abi: ERC20_BALANCE_ABI,
              functionName: 'balanceOf',
              args: [escrow as Address],
            }) as Promise<bigint>,
            publicClient.readContract({
              address: diamondAddress,
              abi: ESCROW_FACTORY_TRACKED_ABI,
              functionName: 'getProtocolTrackedEscrowBalance',
              args: [userAddr, tk.address as Address],
            }) as Promise<bigint>,
            // Pull decimals so the zero-vs-dust filter can pick the
            // right wei threshold per token. Falls back to 18 (the
            // ERC-20 default) on revert / non-standard tokens — same
            // assumption viem uses internally for `formatUnits` calls
            // without an explicit decimals override.
            publicClient.readContract({
              address: tk.address as Address,
              abi: parseAbi(['function decimals() view returns (uint8)']),
              functionName: 'decimals',
            }).then((d) => Number(d)).catch(() => 18) as Promise<number>,
          ]);
          // min(balanceOf, tracked) — see comment block above.
          const display = bal < tracked ? bal : tracked;
          return { address: tk.address, hint: tk.hint, balance: display, decimals: decimalsRead };
        } catch {
          // Per-token read failure (token contract reverted, RPC
          // hiccup, ABI mismatch on a non-standard ERC-20). Surface as
          // 0 rather than aborting — the user can hit Refresh. The
          // zero filter then naturally hides this row.
          return { address: tk.address, hint: tk.hint, balance: 0n, decimals: 18 };
        }
      }),
    )
      .then((next) => {
        if (cancelled) return;
        setRows(next);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [escrow, publicClient, tokens, reloadCounter]);

  // Pre-warm the symbol/decimals cache for every discovered token so
  // the symbol-sort comparator (`peekTokenMeta`) hits warm entries
  // synchronously instead of falling back to "address" sentinel
  // values. Idempotent + dedup'd inside `prewarmTokenMeta`.
  const escrowAssetsClient = publicClient;
  useEffect(() => {
    prewarmTokenMeta(
      tokens.map((tk) => tk.address),
      escrowAssetsClient ?? null,
    );
  }, [tokens, escrowAssetsClient]);

  // Visible rows: drop zero-balance rows always; drop dust rows when
  // the toggle is on. Loading rows (`balance === null`) stay visible
  // so the table doesn't reflow during the fetch — they render as
  // skeletons. Once a row's `balance` resolves, it's filtered.
  // Sort applied AFTER the filter pass so direction flips don't
  // re-introduce hidden rows.
  const visibleRows = useMemo(() => {
    const filtered = rows.filter((r) => {
      // Loading rows always render so the table doesn't reflow as
      // balances arrive.
      if (r.balance === null) return true;
      // Toggle OFF (default) — show everything, including zero /
      // untracked / dust. The trust-model gate (`min(balanceOf,
      // tracked)`) still applies — untracked tokens render as 0
      // even when visible — but the row itself is shown so the user
      // can SEE the row exists and act on it (re-deposit via the
      // chokepoint to bump the tracked counter).
      if (!hideLowBalances) return true;
      // Toggle ON — hide both zero-display rows and dust rows.
      if (r.balance === 0n) return false;
      // Decimals unknown (read failed) — fall back to "show" so a
      // legitimate balance isn't accidentally hidden by a stale
      // 18-dec assumption.
      if (r.decimals === null) return true;
      return !isDustBalance(r.balance, r.decimals);
    });
    const dirMul = sortDir === 'asc' ? 1 : -1;
    if (sortBy === 'balance') {
      return [...filtered].sort((a, b) => {
        // Loading rows (balance === null) sink to the bottom regardless
        // of direction so the user always sees their resolved holdings
        // at the top edge of the table.
        if (a.balance === null && b.balance === null) return 0;
        if (a.balance === null) return 1;
        if (b.balance === null) return -1;
        // Sort by DISPLAYED amount, not raw wei. Without this, a 1 WETH
        // balance (1×10¹⁸ wei) ranks above a 6,010 USDC balance
        // (6.01×10⁹ wei) because the raw bigint comparison is blind to
        // each token's decimal scale. Normalise both sides to the
        // larger of the two decimal counts, then compare bigints —
        // precision-preserving (vs `Number(formatUnits(...))` which
        // would lose precision past 2^53). Decimals fall back to 18
        // (ERC-20 default) when the meta read failed for a row.
        const aDec = a.decimals ?? 18;
        const bDec = b.decimals ?? 18;
        const maxDec = aDec > bDec ? aDec : bDec;
        const aScaled = a.balance * 10n ** BigInt(maxDec - aDec);
        const bScaled = b.balance * 10n ** BigInt(maxDec - bDec);
        if (aScaled === bScaled) return 0;
        return (aScaled < bScaled ? -1 : 1) * dirMul;
      });
    }
    // Sort by symbol — peek the cached meta synchronously; if symbol
    // hasn't resolved yet, fall back to the lowercased address so
    // sort is at least stable even mid-resolution. Locale-aware
    // string compare so non-Latin scripts sort sanely.
    return [...filtered].sort((a, b) => {
      const ma = peekTokenMeta(a.address);
      const mb = peekTokenMeta(b.address);
      const sa = (ma?.symbol || a.address).toLowerCase();
      const sb = (mb?.symbol || b.address).toLowerCase();
      const cmp = sa.localeCompare(sb);
      return cmp * dirMul;
    });
  }, [rows, hideLowBalances, sortBy, sortDir]);
  // Unified counter: how many rows would be hidden if the toggle
  // were ON. Computed against `rows` not `visibleRows` so the count
  // is constant regardless of the current toggle state — drives the
  // "Hide low balances (N)" / "Show all (N hidden)" button label.
  const hiddenLowCount = rows.filter((r) => {
    if (r.balance === null) return false; // loading — never counts
    if (r.balance === 0n) return true;    // zero / untracked
    if (r.decimals === null) return false; // decimals unknown — not classified as dust
    return isDustBalance(r.balance, r.decimals);
  }).length;

  if (!address) {
    return (
      <div className="page-container">
        <h1>{t('escrowAssets.pageTitle')}</h1>
        <p>{t('escrowAssets.connectBody')}</p>
      </div>
    );
  }
  if (!isCorrectChain) {
    return (
      <div className="page-container">
        <h1>{t('escrowAssets.pageTitle')}</h1>
        <p>{t('escrowAssets.switchChainBody')}</p>
      </div>
    );
  }

  return (
    <div className="page-container">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Vault size={22} style={{ verticalAlign: '-4px', marginRight: 8 }} />
        {t('escrowAssets.pageTitle')}
        <CardInfo id="escrow-assets.overview" />
      </h1>
      <p style={{ maxWidth: 720 }}>{t('escrowAssets.pageSubtitle')}</p>

      {/* Escrow address card — redacted display, no-copy, links to
          block explorer in a new tab so users can verify on-chain
          holdings independently. The explicit `userSelect: none` plus
          `onCopy` preventDefault block the trivial copy paths;
          DOM-inspection bypass is intentionally out of scope. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">{t('escrowAssets.addressCardTitle')}</div>
        {escrow ? (
          <>
            <a
              href={`${blockExplorer}/address/${escrow}`}
              target="_blank"
              rel="noreferrer noopener"
              onCopy={(e) => e.preventDefault()}
              style={{
                color: 'var(--brand)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                userSelect: 'none',
                textDecoration: 'none',
                fontFamily: 'monospace',
                fontSize: '0.95rem',
              }}
              aria-label={t('escrowAssets.viewOnExplorer')}
            >
              {escrow.slice(0, 6)}…{escrow.slice(-4)}
              <ExternalLink size={14} />
            </a>
            <p
              style={{
                marginTop: 8,
                fontSize: '0.85rem',
                color: 'var(--text-secondary)',
              }}
            >
              {t('escrowAssets.addressCaption')}
            </p>
          </>
        ) : (
          <p style={{ color: 'var(--text-secondary)' }}>
            {t('escrowAssets.noEscrowYet')}
          </p>
        )}
      </div>

      {/* Holdings card — one row per protocol-managed token. */}
      <div className="card">
        <div
          className="card-title"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            justifyContent: 'space-between',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {t('escrowAssets.holdingsTitle')}
            <CardInfo id="escrow-assets.holdings" />
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Unified low-balance toggle — controls BOTH the zero
                / untracked filter AND the dust filter together.
                Default OFF (show every row, including zero-display
                untracked balances and tiny dust amounts). One click
                hides every row whose `min(balanceOf, tracked)` is
                zero or below the dust threshold. The trust-model
                gate (`min(...)`) still applies to the displayed
                value regardless of toggle state — untracked tokens
                show 0 even when visible — but the row itself is
                shown so the user can verify "is something in the
                escrow that the protocol isn't tracking?" and act on
                it (re-deposit via the chokepoint to bump the
                counter). Always rendered so the toggle is
                discoverable even when the current dataset has
                nothing to hide. */}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setHideLowBalances((v) => !v)}
              title={
                hideLowBalances
                  ? t('escrowAssets.lowShowAll', {
                      defaultValue:
                        'Show all balances including zero / untracked / dust',
                    })
                  : t('escrowAssets.lowHide', {
                      defaultValue:
                        'Hide zero / untracked / dust balances (anything below 1×10⁻¹¹ in display units)',
                    })
              }
            >
              {hideLowBalances
                ? t('escrowAssets.lowToggleShow', {
                    defaultValue: 'Show all ({{n}} hidden)',
                    n: hiddenLowCount,
                  })
                : t('escrowAssets.lowToggleHide', {
                    defaultValue: 'Hide low balances',
                  })}
            </button>
            {/* Visibility hint when nothing to render — informs users
                why a wallet they expect to have escrow balances is
                showing an empty table. The Three causes — never
                deposited on this chain, all balances filtered as
                zero / dust, token discovery hasn't yet populated —
                are surfaced via the unified toggle's count above
                (or the empty-state copy below the table). No
                separate inline "zero hidden" pill needed now that
                the toggle handles every "uninteresting" balance. */}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm rescan-btn"
            onClick={() => {
              rescanCooldown.trigger();
              setReloadCounter((n) => n + 1);
            }}
            disabled={rescanCooldown.disabled || !escrow}
            data-rescan-status={rescanCooldown.status}
            style={
              {
                '--rescan-progress': `${rescanCooldown.remaining * 100}%`,
              } as CSSProperties
            }
            aria-label={t('escrowAssets.refresh')}
          >
            {rescanCooldown.status === 'syncing' ? (
              <>
                <RefreshCw size={14} className="spin" style={{ marginRight: 4 }} />
                {t('escrowAssets.refreshing', { defaultValue: 'Refreshing… ' })}
                <span className="rescan-btn-secs">
                  {rescanCooldown.secondsRemaining}
                </span>
                {t('escrowAssets.secondsSuffix', { defaultValue: 's' })}
              </>
            ) : rescanCooldown.status === 'synced' ? (
              <>
                <Check size={14} style={{ marginRight: 4 }} />
                {t('escrowAssets.synced', { defaultValue: 'Synced — ' })}
                <span className="rescan-btn-secs">
                  {rescanCooldown.secondsRemaining}
                </span>
                {t('escrowAssets.secondsSuffix', { defaultValue: 's' })}
              </>
            ) : (
              <>
                <RefreshCw size={14} style={{ marginRight: 4 }} />
                {t('escrowAssets.refresh')}
              </>
            )}
          </button>
        </div>

        {err && (
          <div
            role="alert"
            style={{
              padding: 8,
              borderRadius: 4,
              background: 'var(--danger-bg, #fee)',
              color: 'var(--danger, #900)',
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <AlertCircle size={14} /> {err}
          </div>
        )}

        {!escrow ? (
          <p style={{ color: 'var(--text-secondary)' }}>
            {t('escrowAssets.noEscrowYet')}
          </p>
        ) : tokens.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)' }}>
            {t('escrowAssets.noProtocolTokensOnChain', {
              defaultValue:
                'No tokens to show. Tokens appear here once you create or accept an offer; come back after your first interaction.',
            })}
          </p>
        ) : visibleRows.length === 0 ? (
          // All discovered tokens are filtered out by the unified
          // low-balance gate. Surface a helpful empty state and
          // remind the user the toggle is reachable in the header.
          <p style={{ color: 'var(--text-secondary)' }}>
            {hideLowBalances && hiddenLowCount > 0
              ? t('escrowAssets.allFilteredAsLow', {
                  defaultValue:
                    'All your discovered balances are zero / untracked / dust. Click "Show all" in the header to inspect them.',
                })
              : t('escrowAssets.allZero', {
                  defaultValue:
                    'No protocol-tracked balances on this chain. Re-deposit via the staking flow to make a balance visible.',
                })}
          </p>
        ) : (
          <table
            className="data-table"
            style={{ width: '100%', borderCollapse: 'collapse' }}
          >
            <thead>
              <tr>
                {/* Click-to-sort headers — same chrome as the
                    Dashboard loan list (`SortTh` there). Active
                    column shows the chevron in the current direction;
                    inactive columns show the muted up-down icon to
                    invite a click. Default is balance-desc on first
                    mount; clicking a header flips its direction;
                    clicking a different header switches column AND
                    picks a sensible per-column default direction
                    (asc for symbols / A-Z, desc for balances /
                    biggest-first). */}
                <th style={{ textAlign: 'left' }}>
                  <button
                    type="button"
                    className="loan-sort-th"
                    onClick={() => toggleSort('symbol')}
                    aria-sort={
                      sortBy === 'symbol'
                        ? sortDir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <span>{t('escrowAssets.colToken')}</span>
                    {sortBy === 'symbol' ? (
                      sortDir === 'asc' ? (
                        <ChevronUp size={12} />
                      ) : (
                        <ChevronDown size={12} />
                      )
                    ) : (
                      <ChevronsUpDown
                        size={12}
                        className="loan-sort-th-idle"
                      />
                    )}
                  </button>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <button
                    type="button"
                    className="loan-sort-th"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => toggleSort('balance')}
                    aria-sort={
                      sortBy === 'balance'
                        ? sortDir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <span>{t('escrowAssets.colBalance')}</span>
                    {sortBy === 'balance' ? (
                      sortDir === 'asc' ? (
                        <ChevronUp size={12} />
                      ) : (
                        <ChevronDown size={12} />
                      )
                    ) : (
                      <ChevronsUpDown
                        size={12}
                        className="loan-sort-th-idle"
                      />
                    )}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.address}>
                  <td>
                    {/* Token cell: small CDN-served icon (Trust
                        Wallet by default; overridable via
                        VITE_TOKEN_ICON_URL_TEMPLATE) + symbol +
                        external-link icon. `<AssetLink kind="erc20">`
                        wraps `<AssetSymbol>` and routes the click to
                        CoinGecko when the token is indexed (debounced
                        verifier hook), else falls back to the chain
                        explorer's contract page. The hover tooltip
                        stays on the symbol and surfaces the full
                        contract address. Icons that don't resolve
                        (testnet mocks, unrecognised chain) collapse
                        to a neutral placeholder so the row chrome
                        doesn't jitter as the image load resolves. */}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <TokenIcon
                        chainId={chain.chainId ?? DEFAULT_CHAIN.chainId}
                        address={row.address}
                      />
                      <AssetLink
                        kind="erc20"
                        chainId={chain.chainId ?? DEFAULT_CHAIN.chainId}
                        address={row.address}
                      />
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                    {row.balance === null ? (
                      <span style={{ color: 'var(--text-secondary)' }}>…</span>
                    ) : (
                      <TokenAmount amount={row.balance} address={row.address} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Direct-send warning — load-bearing for the "don't send
          tokens directly to your escrow" UX gate. The recovery page
          is intentionally NOT linked from here. Users who need the
          recovery flow find it via the Advanced User Guide. */}
      <p
        style={{
          marginTop: 24,
          padding: 12,
          borderRadius: 6,
          background: 'var(--card-bg)',
          color: 'var(--text-secondary)',
          fontSize: '0.9rem',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
        }}
        role="note"
      >
        <AlertCircle
          size={16}
          style={{ flexShrink: 0, marginTop: 2, color: 'var(--warning, #c80)' }}
        />
        <span>{t('escrowAssets.doNotSendWarning')}</span>
      </p>
    </div>
  );
}
