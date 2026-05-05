import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Vault, ExternalLink, RefreshCw, AlertCircle, Check } from 'lucide-react';
import { useRescanCooldown } from '../hooks/useRescanCooldown';
import { parseAbi, type Address } from 'viem';
import { useWallet } from '../context/WalletContext';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { useUserEscrowAddress } from '../hooks/useUserEscrowAddress';
import { CardInfo } from '../components/CardInfo';
import { AssetSymbol } from '../components/app/AssetSymbol';
import { TokenAmount } from '../components/app/TokenAmount';
import { DEFAULT_CHAIN } from '../contracts/config';
import { getDeployment } from '../contracts/deployments';

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
}

/** Build the per-chain list of protocol-managed tokens whose escrow
 *  balance the page should display. Pulled from the deployments record
 *  rather than the on-chain `assetRiskParams` mapping (which has no
 *  enumeration primitive on-chain). When new asset categories land in
 *  the deployment shape, extend this builder.
 *
 *  Precondition: caller already determined the chain is supported by
 *  Vaipakam (i.e. `getDeployment(chainId)` returned non-null).
 */
function knownProtocolTokens(chainId: number): { address: string; hint?: string }[] {
  const dep = getDeployment(chainId);
  if (!dep) return [];
  const list: { address: string; hint?: string }[] = [];
  // VPFI is the protocol's own token; the user's escrow holds their
  // staked balance + any held LIF rebate amounts.
  if (dep.vpfiToken) list.push({ address: dep.vpfiToken, hint: 'VPFI' });
  // WETH features as collateral / principal across most chains and the
  // factory's own internal pricing pivot (oracle WETH peg). Surface it
  // first because it's the most-likely-non-zero balance for an active
  // user.
  if (dep.weth) list.push({ address: dep.weth, hint: 'WETH' });
  // Testnet mocks — surfaced so devs can verify the page renders
  // correctly on chains where production token addresses haven't been
  // wired yet. Each is gated on its own `mock*` field, so a partial
  // testnet deploy doesn't show a "0x000...000" placeholder row. The
  // test deploy script writes mock-USDC under `mockERC20A` and
  // mock-WBTC under `mockERC20B` on local / Sepolia chains; on
  // mainnet the deploy record omits both so this branch is inert.
  if (dep.mockERC20A) list.push({ address: dep.mockERC20A });
  if (dep.mockERC20B) list.push({ address: dep.mockERC20B });
  return list;
}

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

  // Per-chain token list resolved from the deployments record. Memoised
  // to avoid recomputing the array reference on every render — the
  // balance-fetching effect uses it as a dependency.
  const tokens = useMemo(
    () => knownProtocolTokens(chain.chainId ?? DEFAULT_CHAIN.chainId),
    [chain.chainId],
  );

  const [rows, setRows] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);
  // Same cooldown + sync-status state-machine the Activity / OfferBook
  // rescan buttons use. Drives the button label transitions
  // (`Refresh` → `Refreshing… 28s` → `Synced — 5s` → `Refresh`),
  // the inline progress bar, and the 30 s spam-click guard.
  const rescanCooldown = useRescanCooldown({ loading });

  // Initial seed — show one row per token in a "loading" state so the
  // table doesn't reflow when balances arrive.
  useEffect(() => {
    setRows(
      tokens.map((tk) => ({ address: tk.address, hint: tk.hint, balance: null })),
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
          const [bal, tracked] = await Promise.all([
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
          ]);
          // min(balanceOf, tracked) — see comment block above.
          const display = bal < tracked ? bal : tracked;
          return { address: tk.address, hint: tk.hint, balance: display };
        } catch {
          // Per-token read failure (token contract reverted, RPC
          // hiccup, ABI mismatch on a non-standard ERC-20). Surface as
          // 0 rather than aborting — the user can hit Refresh.
          return { address: tk.address, hint: tk.hint, balance: 0n };
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
            {t('escrowAssets.noProtocolTokensOnChain')}
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
              {rows.map((row) => (
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
