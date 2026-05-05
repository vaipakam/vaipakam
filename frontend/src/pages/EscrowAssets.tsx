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
import { CardInfo } from '../components/CardInfo';
import { AssetSymbol } from '../components/app/AssetSymbol';
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
  // Default ON — dust amounts are usually rounding residue from
  // protocol-fee math and have no actionable meaning. Power users who
  // want to verify a specific tiny balance flip this off.
  const [hideDust, setHideDust] = useState(true);
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

  // Visible rows: drop zero-balance rows always; drop dust rows when
  // the toggle is on. Loading rows (`balance === null`) stay visible
  // so the table doesn't reflow during the fetch — they render as
  // skeletons. Once a row's `balance` resolves, it's filtered.
  const visibleRows = useMemo(
    () =>
      rows.filter((r) => {
        if (r.balance === null) return true; // still loading
        if (r.balance === 0n) return false;  // zero — always hidden
        if (!hideDust) return true;          // toggle off — show all non-zero
        // Decimals unknown (read failed) — fall back to "show" so a
        // legitimate balance isn't accidentally hidden by a stale
        // 18-dec assumption.
        if (r.decimals === null) return true;
        return !isDustBalance(r.balance, r.decimals);
      }),
    [rows, hideDust],
  );
  const hiddenZeroCount = rows.filter((r) => r.balance === 0n).length;
  const hiddenDustCount = rows.filter(
    (r) =>
      r.balance !== null &&
      r.balance !== 0n &&
      r.decimals !== null &&
      isDustBalance(r.balance, r.decimals),
  ).length;

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
            {/* Dust filter toggle. Default ON to keep the table tidy;
                power users who need to inspect a tiny balance flip it
                off. The count of currently-hidden rows surfaces inline
                so the user knows when filtering is doing real work
                vs. when there's nothing to hide. */}
            {(hiddenDustCount > 0 || !hideDust) && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setHideDust((v) => !v)}
                title={
                  hideDust
                    ? t('escrowAssets.dustShowAll', {
                        defaultValue: 'Show all balances including dust',
                      })
                    : t('escrowAssets.dustHide', {
                        defaultValue: 'Hide tiny balances under 1e-11',
                      })
                }
              >
                {hideDust
                  ? t('escrowAssets.dustToggleShow', {
                      defaultValue: 'Show all ({{n}} hidden)',
                      n: hiddenDustCount,
                    })
                  : t('escrowAssets.dustToggleHide', {
                      defaultValue: 'Hide dust',
                    })}
              </button>
            )}
            {/* Visibility hint when nothing to render — informs users
                why a wallet they expect to have escrow balances is
                showing an empty table. Three causes: never deposited
                on this chain, all balances filtered as zero / dust,
                or token discovery hasn't yet populated. The first two
                resolve naturally; the third resolves on next watermark
                tick. */}
            {hiddenZeroCount > 0 && (
              <span
                style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}
                title={t('escrowAssets.zeroHiddenTooltip', {
                  defaultValue:
                    'Tokens with zero protocol-tracked balance are not shown. Re-deposit via the staking flow if you expect a balance.',
                })}
              >
                {t('escrowAssets.zeroHidden', {
                  defaultValue: '{{n}} zero hidden',
                  n: hiddenZeroCount,
                })}
              </span>
            )}
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
          // All discovered tokens are filtered out by zero / dust
          // gates. Surface a helpful empty state instead of a blank
          // table — and offer the dust-toggle inline so the user
          // doesn't have to scroll back to the header to flip it.
          <p style={{ color: 'var(--text-secondary)' }}>
            {hideDust && hiddenDustCount > 0
              ? t('escrowAssets.allFilteredAsDust', {
                  defaultValue:
                    'All your protocol-tracked balances are below the dust threshold. Click "Show all" above to inspect them.',
                })
              : t('escrowAssets.allZero', {
                  defaultValue:
                    'No non-zero protocol-tracked balances on this chain. Re-deposit via the staking flow to make a balance visible.',
                })}
          </p>
        ) : (
          <table
            className="data-table"
            style={{ width: '100%', borderCollapse: 'collapse' }}
          >
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>
                  {t('escrowAssets.colToken')}
                </th>
                <th style={{ textAlign: 'right' }}>
                  {t('escrowAssets.colBalance')}
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.address}>
                  <td>
                    <AssetSymbol address={row.address} />
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
