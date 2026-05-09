import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldOff, RefreshCw, ExternalLink } from 'lucide-react';
import type { Address } from 'viem';
import { useWallet } from '../context/WalletContext';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { useAllowances, type AllowanceRow } from '../hooks/useAllowances';
import { formatUnitsPretty } from '../lib/format';
import { AddressDisplay } from '../components/app/AddressDisplay';
import { AssetLink } from '../components/app/AssetLink';
import { ErrorAlert } from '../components/app/ErrorAlert';
import { CardInfo } from '../components/CardInfo';
import { DEFAULT_CHAIN } from '../contracts/config';
import { beginStep } from '../lib/journeyLog';

// Minimal ERC20 write ABI — `approve(spender, amount)`.
const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/**
 * Phase 8a.4 — Revoke-allowance UI.
 *
 * Surfaces every ERC-20 allowance the connected wallet has granted the
 * Vaipakam Diamond across three asset buckets (canonical / loan /
 * vpfi, see `useAllowances`). Each row has a one-click Revoke button
 * that sets the allowance to 0. Mirrors the Uniswap / 1inch in-app
 * revoke flow so users don't need a separate tool like Revoke.cash.
 *
 * UX notes:
 *   - Non-zero allowances sort to the top — those are the actionable
 *     rows. Zero-allowance rows below serve as a reference so the
 *     user can verify they don't have a hidden approval on a token
 *     they forgot about.
 *   - "Zero" allowance is rendered as "-" for readability; "Unlimited"
 *     fires when the allowance is `MAX_UINT256` (common from DEX
 *     aggregators but NEVER from Vaipakam's own flows — Vaipakam
 *     approves exact amounts per action).
 *   - Revoke is blocking — the UI disables the row while the tx
 *     pending; on success the row's allowance updates to 0.
 */
export default function Allowances() {
  const { t } = useTranslation();
  const { address, chainId, activeChain, isCorrectChain } = useWallet();
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
  const activeBlockExplorer =
    (activeChain && isCorrectChain ? activeChain.blockExplorer : null) ??
    DEFAULT_CHAIN.blockExplorer;

  const { rows, loading, reload } = useAllowances();
  const [revokingToken, setRevokingToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (!address) {
    return (
      <div className="page-container">
        <h1>{t('appNav.allowances')}</h1>
        <p>{t('allowances.connectBody')}</p>
      </div>
    );
  }
  if (!isCorrectChain) {
    return (
      <div className="page-container">
        <h1>{t('appNav.allowances')}</h1>
        <p>{t('allowances.switchChainBody')}</p>
      </div>
    );
  }

  const revoke = async (row: AllowanceRow) => {
    setErr(null);
    setMsg(null);
    setRevokingToken(row.token);
    const step = beginStep({
      area: 'allowance',
      flow: 'revoke',
      step: 'submit-tx',
      wallet: address,
      chainId,
    });
    try {
      // Build the tx via viem's wallet client. The page doesn't have a
      // pre-existing ERC20 contract object for arbitrary tokens, so we
      // use `writeContract` with the minimal ABI.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const walletProvider = (window as any).ethereum;
      if (!walletProvider) throw new Error('No wallet provider detected');
      // We rely on the page running under WalletContext's connection
      // — address + chainId are already verified above.
      const { createWalletClient, custom } = await import('viem');
      const walletClient = createWalletClient({
        transport: custom(walletProvider),
        account: address as Address,
      });
      const hash = await walletClient.writeContract({
        address: row.token as Address,
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [diamondAddress, 0n],
        chain: null,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setMsg(`Revoked ${row.symbol} allowance.`);
      await reload();
      step.success({ note: `tx ${hash} token=${row.token}` });
    } catch (e) {
      setErr((e as Error).message);
      step.failure(e);
    } finally {
      setRevokingToken(null);
    }
  };

  const nonZeroCount = rows.filter((r) => r.allowance > 0n).length;

  return (
    <div className="page-container">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <ShieldOff size={22} style={{ verticalAlign: '-4px', marginRight: 8 }} />
        {t('appNav.allowances')}
        <CardInfo id="allowances.list" />
      </h1>
      <p style={{ maxWidth: 720 }}>{t('allowances.pageSubtitle')}</p>

      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          margin: '12px 0',
          flexWrap: 'wrap',
        }}
      >
        <button
          className="btn btn-secondary btn-sm"
          onClick={reload}
          disabled={loading}
        >
          <RefreshCw size={14} style={{ verticalAlign: '-2px' }} />{' '}
          {loading ? t('allowances.refreshing') : t('allowances.refresh')}
        </button>
        <span style={{ fontSize: '0.82rem', opacity: 0.7 }}>
          {t('allowancesPage.scannedSummary', {
            count: rows.length,
            nonZero: nonZeroCount,
          })}
        </span>
      </div>

      {err && <ErrorAlert message={err} onDismiss={() => setErr(null)} style={{ marginBottom: 12 }} />}
      {msg && (
        <div className="alert alert-success" style={{ marginBottom: 12 }}>
          {msg}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="empty-state"><p>{t('allowances.reading')}</p></div>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <p>{t('allowances.noTokens')}</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="loans-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{t('allowances.colToken')}</th>
                <th>{t('allowances.colAddress')}</th>
                <th>{t('allowances.colAllowance')}</th>
                <th>{t('allowances.colSource')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const display = formatAllowance(r);
                const isRevoking = revokingToken === r.token;
                return (
                  <tr
                    key={r.token}
                    style={{
                      opacity: r.allowance === 0n ? 0.6 : 1,
                    }}
                  >
                    <td style={{ fontWeight: 600 }}>
                      <AssetLink
                        kind="erc20"
                        chainId={chainId ?? DEFAULT_CHAIN.chainId}
                        address={r.token}
                        showIcon={false}
                        label={r.symbol}
                      />
                    </td>
                    <td>
                      <a
                        href={`${activeBlockExplorer}/address/${r.token}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--brand)', fontSize: '0.82rem' }}
                      >
                        <AddressDisplay address={r.token} hexOnly />{' '}
                        <ExternalLink size={10} />
                      </a>
                    </td>
                    <td className="mono" style={{ fontSize: '0.9rem' }}>
                      {display}
                    </td>
                    <td>
                      <span
                        className={`status-badge ${r.source === 'loan' ? 'active' : r.source === 'vpfi' ? 'lender' : 'settled'}`}
                        style={{ fontSize: '0.72rem' }}
                      >
                        {r.source === 'loan'
                          ? t('allowancesPage.sourceLoanDerived')
                          : r.source === 'vpfi'
                            ? t('allowancesPage.sourceVpfi')
                            : t('allowancesPage.sourceCanonical')}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {r.allowance > 0n ? (
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={isRevoking}
                          onClick={() => revoke(r)}
                        >
                          {isRevoking ? t('allowances.revoking') : t('allowances.revoke')}
                        </button>
                      ) : (
                        <span style={{ fontSize: '0.78rem', opacity: 0.6 }}>
                          {t('allowances.cleared')}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontSize: '0.75rem', opacity: 0.6, marginTop: 12 }}>
        {t('allowances.footnote')}
      </p>
    </div>
  );
}

function formatAllowance(row: AllowanceRow): string {
  if (row.allowance === 0n) return '—';
  // MAX_UINT256 — infinite approval.
  const MAX = (1n << 256n) - 1n;
  if (row.allowance === MAX) return 'Unlimited ⚠';
  return `${formatUnitsPretty(row.allowance, row.decimals)} ${row.symbol}`;
}
