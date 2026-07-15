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
import { captureTxError } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { revokeAllowance } from '../contracts/erc20';
import { fetchAllPages, useMyLoans, useMyOffers } from '../data/hooks';
import { fetchOffersByCreator, type IndexedOffer } from '../data/indexer';
import { ZERO_ADDRESS } from '../lib/offerSchema';
import { AssetType } from '../lib/types';
import { formatTokenAmount, shortAddress } from '../lib/format';
import { LIST_WINDOW_PAGE } from '../lib/visibleWindow';
import { signalAware } from '../chain/railHealth';

interface ApprovalRow {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  allowance: bigint;
}

export function ApprovalsCard() {
  const { address, readChain, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  // Writes pair with a WALLET-chain client, like every write surface
  // — the read client must not wait for a receipt on another chain.
  const walletPublicClient = usePublicClient({ chainId: walletChain?.chainId });
  const queryClient = useQueryClient();
  const loans = useMyLoans();
  const offers = useMyOffers();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // #1247 PAG-006 — the queried token window: the per-token
  // allowance/metadata reads fan out inside the query, so the window
  // bounds the READ set (part of the queryKey; "Check more" widens it).
  const [tokenWindow, setTokenWindow] = useState(LIST_WINDOW_PAGE);

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
      tokenWindow,
    ],
    // NOT gated on tokens.length: a wallet with zero ACTIVE positions
    // is exactly the profile most likely to hold pure historical
    // residue (the history legs below still apply).
    enabled: Boolean(publicClient) && Boolean(address) && complete,
    // RPC read-diet PR A — approvals ride receipt + focus + net; the
    // approval write helpers feed the central receipt floor (§4.1.4).
    refetchInterval: signalAware(60_000),
    queryFn: async (): Promise<{ rows: ApprovalRow[]; moreTokens: number }> => {
      // The rental-prepay approval (the Rent flow's money leg) only
      // appears on OFFERS, and useMyOffers filters to active — pull
      // the creator's FULL offer history (cursor-followed, null on
      // any page failure per the shared contract: a partial history
      // must fail the round loudly, never render as a clean bill).
      const historyTokens = new Set<string>(tokens);
      const history = await fetchAllPages<IndexedOffer>((before) =>
        fetchOffersByCreator(readChain.chainId, address!, {
          limit: 100,
          before,
        }).then((p) => (p === null ? null : { rows: p.offers, nextBefore: p.nextBefore })),
      );
      if (history === null) throw new Error('offer history unavailable');
      for (const o of history) {
        // Every ERC-20 leg a historical offer could have left an
        // approval on: the rental prepay, the lending leg, and the
        // collateral leg (a cancelled offer's approval residue
        // outlives the offer record).
        const a = o.prepayAsset?.toLowerCase();
        if (a && a !== ZERO_ADDRESS) historyTokens.add(a);
        if (o.assetType === AssetType.ERC20) {
          const l = o.lendingAsset?.toLowerCase();
          if (l && l !== ZERO_ADDRESS) historyTokens.add(l);
        }
        if (o.collateralAssetType === AssetType.ERC20) {
          const c = o.collateralAsset?.toLowerCase();
          if (c && c !== ZERO_ADDRESS) historyTokens.add(c);
        }
      }
      // #1247 PAG-006 — window the READ set, not just the DOM: the
      // per-token allowance/metadata reads fan out right here inside
      // the query, so the window must bound this list. "Check more"
      // widens the window (queryKey includes it → refetch covers the
      // wider set).
      const allTokens = [...historyTokens].sort();
      const scanned = allTokens.slice(0, tokenWindow);
      const rows = await Promise.all(
        scanned.map(async (t): Promise<ApprovalRow | null> => {
          const token = t as `0x${string}`;
          // The ALLOWANCE read failing is NOT knowledge — it must
          // fail the round loudly (isError), never render as "no
          // approvals". Metadata failures only degrade the label
          // (bytes32-symbol tokens stay listed and revocable).
          const allowance = (await publicClient!.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [address!, readChain.diamondAddress],
          })) as bigint;
          if (allowance === 0n) return null;
          const [symbol, decimals] = await Promise.all([
            (publicClient!.readContract({
              address: token,
              abi: erc20Abi,
              functionName: 'symbol',
            }) as Promise<string>).catch(() => shortAddress(token)),
            (publicClient!.readContract({
              address: token,
              abi: erc20Abi,
              functionName: 'decimals',
            }) as Promise<number>).catch(() => 18),
          ]);
          return { token, symbol, decimals: Number(decimals), allowance };
        }),
      );
      return {
        rows: rows.filter((r): r is ApprovalRow => r !== null),
        moreTokens: allTokens.length - scanned.length,
      };
    },
  });

  async function revoke(row: ApprovalRow) {
    if (!address || !walletClient || !walletPublicClient || !walletChain) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await revokeAllowance({
        publicClient: walletPublicClient,
        walletClient,
        token: row.token,
        owner: address,
        spender: walletChain.diamondAddress,
      });
      setDone(copy.approvals.revoked(row.symbol));
      await queryClient.invalidateQueries({ queryKey: ['standingApprovals'] });
      // The pending-flow watches re-verify on their own ticks; nudge
      // them so a broken flow flags within seconds, not 30.
      void queryClient.invalidateQueries({ queryKey: ['refinancePending'] });
      void queryClient.invalidateQueries({ queryKey: ['loanSalePending'] });
    } catch (err) {
      setError(captureTxError(err));
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
      ) : approvals.isError && !approvals.data ? (
        <p className="muted">{copy.approvals.unavailable}</p>
      ) : !approvals.data ? (
        <p className="muted">{copy.approvals.loading}</p>
      ) : approvals.data.rows.length === 0 && approvals.data.moreTokens === 0 ? (
        <p className="muted">{copy.approvals.none}</p>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {approvals.isError ? (
            // Retained data on a failed background refetch — revoke
            // must stay reachable; flag staleness instead of hiding.
            <p className="muted">{copy.approvals.staleNote}</p>
          ) : null}
          {approvals.data.rows.map((row) => (
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
          {approvals.data.moreTokens > 0 ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setTokenWindow((w) => w + LIST_WINDOW_PAGE)}
            >
              {copy.approvals.checkMore(approvals.data.moreTokens)}
            </button>
          ) : null}
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
