/**
 * Position-NFT verifier — the trust surface behind every clickable
 * position-NFT id. These NFTs carry claim rights and role authority,
 * so anyone offered one (secondary market, OTC) needs a one-look
 * answer: does this token currently exist on THIS network, who holds
 * it, which loan does it control, and is it transfer-locked?
 *
 * Existence honesty: `ownerOf` reverts identically for a burned
 * (claim-completed) token and one never minted, and the contracts
 * expose no mint-counter view — so the negative verdict states BOTH
 * possibilities rather than guessing. (Recorded as a spec divergence
 * in docs/FunctionalSpecs/_CodeVsDocsAudit.md — the spec wants the
 * three-way distinction; that needs a contract view.)
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useEnsName, usePublicClient } from 'wagmi';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from 'viem';
import { BadgeCheck, ShieldQuestion } from 'lucide-react';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { shortAddress } from '../lib/format';
import { EmptyState } from '../components/EmptyState';

/** LibERC721.LockReason display labels (None omitted). */
const LOCK_LABELS: Record<number, string> = {
  1: copy.nftVerifier.lockPrecloseOffset,
  2: copy.nftVerifier.lockSale,
  3: copy.nftVerifier.lockPrepayListing,
};

interface VerifierResult {
  exists: boolean;
  owner?: `0x${string}`;
  loanId?: string;
  offerId?: string;
  isLender?: boolean;
  /** null = the lock read FAILED — unknown is not "unlocked". */
  lock?: number | null;
}

export function NftVerifier() {
  const { tokenId: tokenIdParam } = useParams();
  const navigate = useNavigate();
  const { readChain } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });
  const [input, setInput] = useState(tokenIdParam ?? '');
  // The route element is reused across /nft/:id transitions
  // (back/forward, in-page links) — keep the input in step with the
  // verdict being shown.
  useEffect(() => {
    if (tokenIdParam !== undefined) setInput(tokenIdParam);
  }, [tokenIdParam]);

  const validId = tokenIdParam !== undefined && /^[1-9]\d*$/.test(tokenIdParam);

  const result = useQuery({
    queryKey: ['nftVerify', readChain.chainId, tokenIdParam],
    enabled: Boolean(readClient) && validId,
    staleTime: 30_000,
    queryFn: async (): Promise<VerifierResult> => {
      const diamond = readChain.diamondAddress;
      const id = BigInt(tokenIdParam!);
      let owner: `0x${string}`;
      try {
        owner = (await readClient!.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'ownerOf',
          args: [id],
        })) as `0x${string}`;
      } catch (err) {
        // Only a REVERT proves non-existence (burned OR never minted
        // — indistinguishable on-chain today). A transport error is
        // NOT knowledge: rethrow so the query lands in the visible
        // check-failed state instead of caching a false "worthless"
        // verdict (same revert-vs-transport split as the ownership
        // preflights).
        const isRevert =
          err instanceof BaseError &&
          (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
            err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
        if (isRevert) return { exists: false };
        throw err;
      }
      // Summary + lock are best-effort embellishments; owner alone
      // already proves live existence.
      const [summary, lock] = await Promise.all([
        readClient!
          .readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getNFTPositionSummary',
            args: [id],
          })
          .catch(() => null) as Promise<{
          loanId: bigint;
          offerId: bigint;
          isLender: boolean;
        } | null>,
        // A failed lock read is UNKNOWN, never "not locked" — the
        // lock is exactly what a prospective transferee checks.
        readClient!
          .readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'positionLock',
            args: [id],
          })
          .catch(() => null) as Promise<number | bigint | null>,
      ]);
      return {
        exists: true,
        owner,
        loanId:
          summary && summary.loanId !== 0n ? summary.loanId.toString() : undefined,
        offerId:
          summary && summary.offerId !== 0n ? summary.offerId.toString() : undefined,
        isLender: summary?.isLender,
        lock: lock === null ? null : Number(lock),
      };
    },
  });

  // Human-readable owner where one exists: ENS lives on Ethereum
  // mainnet regardless of which network the token is verified on —
  // display-only sugar, never part of the verdict.
  const ensName = useEnsName({
    address: result.data?.exists ? result.data.owner : undefined,
    chainId: 1,
  });

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">{copy.nftVerifier.title}</h1>
        <p className="page-lede">{copy.nftVerifier.lede}</p>
      </div>

      <section className="card">
        <div className="cluster">
          <input
            className="input"
            style={{ flex: 1 }}
            inputMode="numeric"
            placeholder={copy.nftVerifier.placeholder}
            value={input}
            onChange={(e) => setInput(e.target.value.trim())}
            aria-label={copy.nftVerifier.placeholder}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!/^[1-9]\d*$/.test(input)}
            onClick={() => navigate(`/nft/${input}`)}
          >
            {copy.nftVerifier.check}
          </button>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          {copy.nftVerifier.chainNote(readChain.name)}
        </p>
      </section>

      {!validId ? null : result.isError ? (
        <EmptyState
          icon={ShieldQuestion}
          title={copy.nftVerifier.checkFailed}
        />
      ) : !result.data ? (
        <EmptyState icon={ShieldQuestion} title={copy.nftVerifier.checking} />
      ) : result.data.exists ? (
        <section className="card">
          <div className="card-title">
            <BadgeCheck aria-hidden />
            <h3 style={{ margin: 0 }}>{copy.nftVerifier.liveTitle(tokenIdParam!)}</h3>
          </div>
          <dl className="receipt" style={{ margin: 0 }}>
            <div className="receipt-row">
              <dt>{copy.nftVerifier.ownerLabel}</dt>
              <dd>
                {ensName.data
                  ? `${ensName.data} (${shortAddress(result.data.owner!)})`
                  : shortAddress(result.data.owner!)}
              </dd>
            </div>
            <div className="receipt-row">
              <dt>{copy.nftVerifier.roleLabel}</dt>
              <dd>
                {result.data.isLender === undefined
                  ? copy.nftVerifier.roleUnknown
                  : result.data.isLender
                    ? copy.nftVerifier.roleLender
                    : copy.nftVerifier.roleBorrower}
              </dd>
            </div>
            {result.data.loanId ? (
              <div className="receipt-row">
                <dt>{copy.nftVerifier.loanLabel}</dt>
                <dd>
                  <Link to={`/positions/${result.data.loanId}`}>
                    #{result.data.loanId}
                  </Link>
                </dd>
              </div>
            ) : result.data.offerId ? (
              // Offer-stage mint: the token isn't attached to a loan
              // yet — say what it IS attached to.
              <div className="receipt-row">
                <dt>{copy.nftVerifier.offerLabel}</dt>
                <dd>{copy.nftVerifier.offerValue(result.data.offerId)}</dd>
              </div>
            ) : null}
            {result.data.lock === null ? (
              <div className="receipt-row receipt-risk">
                <dt>{copy.nftVerifier.lockLabel}</dt>
                <dd>{copy.nftVerifier.lockUnknown}</dd>
              </div>
            ) : result.data.lock ? (
              // LockReason is append-only on-chain — a value this
              // build doesn't know is still LOCKED, never rendered
              // as transferable.
              <div className="receipt-row receipt-risk">
                <dt>{copy.nftVerifier.lockLabel}</dt>
                <dd>
                  {LOCK_LABELS[result.data.lock] ??
                    copy.nftVerifier.lockUnrecognized}
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="muted" style={{ marginTop: 8 }}>
            {copy.nftVerifier.liveNote}
          </p>
        </section>
      ) : (
        <section className="card">
          <div className="card-title">
            <ShieldQuestion aria-hidden />
            <h3 style={{ margin: 0 }}>
              {copy.nftVerifier.goneTitle(tokenIdParam!)}
            </h3>
          </div>
          <p className="muted">{copy.nftVerifier.goneBody}</p>
        </section>
      )}
    </div>
  );
}
