/**
 * Standing approvals manager (Settings, advanced mode) — every ERC-20
 * allowance the connected wallet has granted the Diamond for tokens
 * this app knows the wallet touches (assets across its loans and
 * offers), with one-click revoke.
 *
 * Why it exists: several alpha02 flows deliberately create STANDING
 * approvals (refinance payoff, sale-listing settlement), and their
 * cards unwind them on cancel — but abandoned mid-sequences, wallets
 * migrating devices, and plain history leave residue. This is the
 * one place to see and remove it.
 *
 * Revoke honesty: an approval may be load-bearing for a LIVE flow
 * (a pending refinance request or sale listing on the same token) —
 * revoking here makes that flow unfillable until its card's restore
 * action is used. The warning states this instead of guessing which
 * flows exist (the pending cards themselves live-watch and flag
 * within seconds).
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { erc20Abi } from 'viem';
import { KeyRound } from 'lucide-react';
import { copy } from '../content/copy';
import { submitErrorText } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { revokeAllowance } from '../contracts/erc20';
import { useMyLoans, useMyOffers } from '../data/hooks';
import { ZERO_ADDRESS } from '../lib/offerSchema';
import { AssetType } from '../lib/types';
import { formatTokenAmount, shortAddress } from '../lib/format';

interface ApprovalRow {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  allowance: bigint;
}

export function ApprovalsCard() {
  const { address, readChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const queryClient = useQueryClient();
  const loans = useMyLoans();
  const offers = useMyOffers();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Candidate tokens: every ERC-20 leg of every loan/offer this
  // wallet touches. Data-source unavailability means the list may be
  // INCOMPLETE — said in the UI, never silently.
  const { tokens, complete } = useMemo(() => {
    const set = new Set<string>();
    const add = (addr: string | undefined, isErc20: boolean) => {
      if (!addr || !isErc20) return;
      const a = addr.toLowerCase();
      if (a !== ZERO_ADDRESS) set.add(a);
    };
    for (const l of loans.data ?? []) {
      add(l.lendingAsset, l.assetType === AssetType.ERC20);
      add(l.collateralAsset, l.collateralAssetType === AssetType.ERC20);
    }
    for (const o of offers.data ?? []) {
      add(o.lendingAsset, o.assetType === AssetType.ERC20);
      add(o.collateralAsset, o.collateralAssetType === AssetType.ERC20);
      add(o.prepayAsset, true);
    }
    return {
      tokens: [...set].sort() as `0x${string}`[],
      complete: loans.data != null && offers.data != null,
    };
  }, [loans.data, offers.data]);

  const approvals = useQuery({
    queryKey: [
      'standingApprovals',
      readChain.chainId,
      address?.toLowerCase(),
      tokens.join(','),
    ],
    enabled: Boolean(publicClient) && Boolean(address) && tokens.length > 0,
    refetchInterval: 60_000,
    queryFn: async (): Promise<ApprovalRow[]> => {
      const rows = await Promise.all(
        tokens.map(async (token): Promise<ApprovalRow | null> => {
          try {
            const [allowance, symbol, decimals] = await Promise.all([
              publicClient!.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [address!, readChain.diamondAddress],
              }) as Promise<bigint>,
              publicClient!.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'symbol',
              }) as Promise<string>,
              publicClient!.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'decimals',
              }) as Promise<number>,
            ]);
            return { token, symbol, decimals: Number(decimals), allowance };
          } catch {
            // One unreadable token must not hide the others; it just
            // drops from the list this round.
            return null;
          }
        }),
      );
      return rows.filter((r): r is ApprovalRow => r !== null && r.allowance > 0n);
    },
  });

  async function revoke(row: ApprovalRow) {
    if (!address || !walletClient || !publicClient) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await revokeAllowance({
        publicClient,
        walletClient,
        token: row.token,
        owner: address,
        spender: readChain.diamondAddress,
      });
      setDone(copy.approvals.revoked(row.symbol));
      await queryClient.invalidateQueries({ queryKey: ['standingApprovals'] });
      // The pending-flow watches re-verify on their own ticks; nudge
      // them so a broken flow flags within seconds, not 30.
      void queryClient.invalidateQueries({ queryKey: ['refinancePending'] });
      void queryClient.invalidateQueries({ queryKey: ['loanSalePending'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  const walletReady = onSupportedChain && Boolean(walletClient);

  return (
    <section className="card">
      <div className="card-title">
        <KeyRound aria-hidden />
        <h2 style={{ margin: 0 }}>{copy.approvals.title}</h2>
      </div>
      <p className="muted">{copy.approvals.blurb}</p>
      <p className="muted">{copy.approvals.revokeWarning}</p>

      {!address ? (
        <p className="muted">{copy.wallet.connectFirst}</p>
      ) : !complete ? (
        <p className="muted">{copy.approvals.sourcesUnavailable}</p>
      ) : tokens.length === 0 ? (
        <p className="muted">{copy.approvals.none}</p>
      ) : approvals.isError ? (
        <p className="muted">{copy.approvals.unavailable}</p>
      ) : !approvals.data ? (
        <p className="muted">{copy.approvals.loading}</p>
      ) : approvals.data.length === 0 ? (
        <p className="muted">{copy.approvals.none}</p>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {approvals.data.map((row) => (
            <div key={row.token} className="spread">
              <span>
                {formatTokenAmount(row.allowance, row.decimals)} {row.symbol}{' '}
                <span className="muted">({shortAddress(row.token)})</span>
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy || !walletReady}
                onClick={() => void revoke(row)}
              >
                {copy.approvals.revoke}
              </button>
            </div>
          ))}
          <p className="muted">{copy.approvals.scopeNote}</p>
        </div>
      )}

      {done ? (
        <div className="banner banner-info" role="status" style={{ marginTop: 12 }}>
          <span className="banner-body">{done}</span>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </section>
  );
}
