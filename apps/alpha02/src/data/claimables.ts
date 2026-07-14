/**
 * On-chain-authoritative claimables (issue #921 item 7 / #958).
 *
 * alpha02 previously read the indexer's `/claimables` endpoint and
 * merged `fallback_pending` lender loans back client-side — because the
 * endpoint lists only terminal statuses, and the indexer deliberately
 * does NOT mirror `FallbackPending` (it's transient/reversible). Rather
 * than push reversible state onto shared indexer infra apps/defi also
 * reads, this matches apps/defi's `useClaimables`: the indexer stays the
 * fast approximate candidate layer (via `useMyLoans`), and the chain is
 * the authority for what is actually collectable.
 *
 * Per candidate loan we confirm on-chain: the wallet still HOLDS that
 * side's position NFT (`ownerOf`), and `getClaimable(loanId, isLender)`
 * reports an unclaimed, actionable payout (mirroring ClaimFacet's own
 * actionability guard, incl. the Phase-5 borrower LIF rebate). A
 * `fallback_pending` lender loan surfaces naturally — `getClaimable`
 * reports the recoverable collateral the claim-time fallback resolves —
 * so the client-side special-case merge is gone.
 *
 * Honesty contract preserved: a per-loan REVERT means "not claimable
 * this side" (exclude); a TRANSPORT failure means "couldn't confirm" and
 * collapses the whole result to `null` (unavailable) rather than a
 * confident short list that hides real, collectable funds.
 *
 * Candidate discovery is a UNION of two sources (#988, closing the
 * #958 parity gap vs apps/defi): the wallet's own indexed loans
 * (`useMyLoans` — fast, approximate) PLUS the on-chain
 * `getUserPositionLoansPaginated` enumeration (authoritative for the
 * wallet's CURRENT position-NFT holdings, so a pure secondary-market
 * buyer — holding a position NFT for a loan it was never an original
 * party to — is discovered too). Chain-discovered loans absent from
 * the indexer are synthesized from a live `getLoanDetails` read for
 * BOTH sides; the ownerOf confirm below prunes the side the wallet
 * doesn't actually hold.
 *
 * RPC read-diet PR C (§4.2.3) adds two refinements on top, neither of
 * which weakens the contract above: (1) the indexer's ADDITIVE
 * `/claim-candidates` hint widens discovery when the chain enumeration
 * is unavailable (old deploy) — it can only add candidates, never
 * suppress one, and is skipped entirely while the authoritative
 * enumeration works; and (2) each candidate's verdict is
 * memoized per identity key (`claimVerdictKey`) so a re-run only
 * re-probes candidates that actually changed — the memo is cleared on
 * `ownership.changed` push frames and receipt invalidations, the
 * signals that can flip a verdict without moving any identity field.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { AssetType } from '../lib/types';
import { fetchClaimCandidates, type IndexedLoanStatus } from './indexer';
import { isRevert, readLoanRowLive } from './liveLoanRow';
import { useMyLoans, type PositionLoan } from './hooks';
import { isRailHealthy, signalAware } from '../chain/railHealth';
import {
  claimVerdictEpoch,
  claimVerdictGet,
  claimVerdictPut,
} from './claimVerdictCache';

const REFRESH_MS = 30_000;

/** `getClaimable(loanId, isLender)` return — accept named-object OR
 *  positional shape defensively (older ABIs predate the named fields). */
interface ClaimableTuple {
  asset?: string;
  amount?: bigint;
  claimed?: boolean;
  assetType?: bigint;
  heldForLender?: bigint;
  hasRentalNftReturn?: boolean;
  0?: string;
  1?: bigint;
  2?: boolean;
  3?: bigint;
  6?: bigint;
  7?: boolean;
}

/** What the wallet would actually receive on claim — carried onto the
 *  row so the Claim Center can show the NUMBER instead of a vague
 *  "+ interest" / "proceeds or collateral" description (UX-002). The
 *  asset address comes from getClaimable itself, so formatting never
 *  guesses a token. */
export interface ClaimDetail {
  asset: string | null;
  amount: bigint;
  heldForLender: bigint;
  hasRentalNftReturn: boolean;
  lifRebate: bigint;
}

export interface ClaimableLoan extends PositionLoan {
  claim: ClaimDetail;
}

/** Claimable loans for the connected wallet, tagged with role.
 *  `undefined` = loading, `null` = unavailable (never a partial list). */
/** Tiny stable hash (djb2) — the candidate fingerprint below can span
 *  hundreds of rows and a queryKey should stay small. */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

/** RPC read-diet PR A (§4.1.5) — the candidate-set CONTENT fingerprint
 *  the query keys on, replacing `loans.dataUpdatedAt`: keying on the
 *  refresh timestamp re-ran the whole ~3–4-reads-per-candidate
 *  verification on EVERY myLoans refetch even when nothing changed.
 *  Identity per candidate is (loanId, role, status, position-token
 *  ids, entitlement-relevant amounts): role because the probe is
 *  role-specific (a side flip via NFT transfer changes the candidate
 *  without changing loanId/status), amounts because entitlement can
 *  change without a status transition (the FallbackPending partial
 *  rescue parks funds while status holds). Order-independent (sorted)
 *  so a re-ordered fetch of identical rows never re-verifies. */
function candidateFingerprint(rows: PositionLoan[] | null | undefined): string {
  if (rows == null) return String(rows); // 'null' | 'undefined'
  const parts = rows
    .map(
      (l) =>
        `${l.loanId}:${l.role}:${l.status}:${l.lenderTokenId}:${l.borrowerTokenId}:${l.principal}:${l.collateralAmount}`,
    )
    .sort();
  return `${rows.length}:${djb2(parts.join('|'))}`;
}

/** RPC read-diet PR C (§4.2.3) — the PER-CANDIDATE memo key: the same
 *  identity fields as the set fingerprint above, plus chain + wallet.
 *  A candidate whose key is unchanged since its last CLEAN
 *  verification reuses that verdict instead of re-spending its
 *  ~3-read probe; the memo is cleared wholesale on `ownership.changed`
 *  push frames and receipt invalidations (see claimVerdictCache.ts),
 *  because ownership can flip without any of these fields moving.
 *  Exported for the unit test. */
export function claimVerdictKey(
  chainId: number,
  wallet: string,
  l: PositionLoan,
): string {
  return `${chainId}:${wallet}:${l.loanId}:${l.role}:${l.status}:${l.lenderTokenId}:${l.borrowerTokenId}:${l.principal}:${l.collateralAmount}`;
}

export function useMyClaimables() {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const loans = useMyLoans();
  const diamond = readChain.diamondAddress;

  return useQuery({
    // Re-derive when the candidate set's CONTENT changes (see
    // candidateFingerprint) — a myLoans refresh returning identical
    // candidates no longer re-runs the whole chain verification.
    queryKey: [
      'claimables',
      readChain.chainId,
      address?.toLowerCase(),
      candidateFingerprint(loans.data),
    ],
    enabled: Boolean(address) && loans.data !== undefined,
    // RPC read-diet PR A — Claims cadence is events + focus + the
    // 180s net, never the tip nudge (§4.1.5): the fan-out below is the
    // single most expensive recurring read surface in the app.
    refetchInterval: signalAware(REFRESH_MS),
    queryFn: async (): Promise<ClaimableLoan[] | null> => {
      if (!address) return [];
      if (!publicClient) return null;
      // Indexer down (`null`) is NOT fatal by itself: holding the
      // side's position NFT is a precondition for every claim, and the
      // on-chain enumeration below is authoritative for the wallet's
      // CURRENT holdings — so chain discovery alone still finds every
      // claimable. Only when the enumeration is ALSO unavailable does
      // the result collapse to `null` (unavailable, never a confident
      // partial list).
      const indexerDown = loans.data == null;
      const indexed: PositionLoan[] = loans.data ?? [];

      const me = address.toLowerCase();
      let transportFailed = false;

      // PR C memo posture for THIS pass, captured up front:
      //  - reuse verdicts only while the push rail is healthy — rail
      //    down means `ownership.changed` frames are NOT arriving, so
      //    the fallback refetches must probe live ownership every time
      //    (the pre-memo posture; Codex #1232 r1);
      //  - stamp writes with the pass's epoch so a bump that lands
      //    mid-verification discards our (possibly pre-bump) results
      //    instead of re-seeding the cleared map (Codex #1232 r1).
      const memoReadable = isRailHealthy();
      const epochAtStart = claimVerdictEpoch();

      // ── On-chain discovery (#988, closes the #958 parity gap) ──
      // Enumerate every loan whose position NFT the wallet CURRENTLY
      // holds — the source the indexer rows can't cover for a pure
      // secondary-market buyer. A REVERT means the view is absent on
      // this deploy (fall back to the legacy unbounded view, then give
      // up gracefully — the indexer set stands alone, matching the
      // pre-#988 behaviour). A TRANSPORT failure makes the defined
      // candidate set unknowable → unavailable, per the contract above.
      const chainIds: bigint[] = [];
      let enumerationAvailable = true;
      try {
        // Paginated so a wallet griefed with a huge position-NFT
        // inventory can't make one unbounded eth_call revert and hide a
        // real claimable (mirrors apps/defi #769).
        const PAGE = 200n;
        let offset = 0n;
        for (;;) {
          const [ids, , total] = (await publicClient.readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getUserPositionLoansPaginated',
            args: [address, offset, PAGE],
          })) as readonly [readonly bigint[], readonly bigint[], bigint];
          chainIds.push(...ids);
          offset += PAGE;
          if (offset >= total) break;
        }
      } catch (e) {
        if (!isRevert(e)) return null;
        try {
          const legacy = (await publicClient.readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getUserPositionLoans',
            args: [address],
          })) as readonly [readonly bigint[], readonly bigint[]];
          chainIds.push(...legacy[0]);
        } catch (e2) {
          if (!isRevert(e2)) return null;
          // Both views absent — an older deploy without the
          // enumeration. The indexer candidates stand alone (exactly
          // the pre-#988 behaviour) — unless the indexer is down too,
          // in which case nothing can discover candidates.
          enumerationAvailable = false;
        }
      }
      if (indexerDown && !enumerationAvailable) return null;

      // Candidates are keyed by (loanId, role) — NOT loanId alone. The
      // indexer may know one side of a loan while the chain enumeration
      // proves the wallet also holds the OTHER side's position NFT
      // (secondary-market Transfer the indexer hasn't caught up to, or
      // a wallet on both sides of its own loan). For those, add the
      // missing role reusing the indexed row's fields; the ownerOf
      // confirm below prunes any side the wallet doesn't actually hold.
      const byLoanId = new Map<number, PositionLoan>();
      const knownKeys = new Set<string>();
      for (const l of indexed) {
        knownKeys.add(`${l.loanId}:${l.role}`);
        if (!byLoanId.has(l.loanId)) byLoanId.set(l.loanId, l);
      }
      // PR C (§4.2.3) — the ADDITIVE indexer hint, as FALLBACK
      // discovery only (Codex #1232 r2): when the enumeration
      // succeeded it is already authoritative for the wallet's
      // current holdings — the hint could only add stale rows the
      // ownerOf confirm must prune, while a slow indexer would hold
      // the whole Claims result behind its fetch timeout. On an old
      // deploy without the enumeration views it ADDS candidates the
      // indexed rows may miss; it never suppresses or substitutes for
      // chain discovery, and a failed fetch (`null`) means "no hint".
      const hints = enumerationAvailable
        ? []
        : ((await fetchClaimCandidates(readChain.chainId, me).catch(
            () => null,
          )) ?? []);
      const chainIdList = [...new Set(chainIds.map((id) => Number(id)))];
      const flipped: PositionLoan[] = [];
      for (const id of chainIdList) {
        const row = byLoanId.get(id);
        if (!row) continue;
        const other = row.role === 'lender' ? ('borrower' as const) : ('lender' as const);
        if (!knownKeys.has(`${id}:${other}`)) {
          knownKeys.add(`${id}:${other}`);
          flipped.push({ ...row, role: other });
        }
      }
      // Hints carry a SPECIFIC (loanId, role) — honour it (Codex #1232
      // r3): a role-less union would add the OPPOSITE side of every
      // one-sided indexed row too, growing the very fan-out the hint
      // exists to narrow. Only the hinted side is probed; roles the
      // hint didn't name are covered by the indexed rows themselves.
      const hintOnlyRoles = new Map<number, Set<'lender' | 'borrower'>>();
      for (const h of hints) {
        const key = `${h.loanId}:${h.role}`;
        if (knownKeys.has(key)) continue;
        knownKeys.add(key);
        const row = byLoanId.get(h.loanId);
        if (row) {
          flipped.push({ ...row, role: h.role });
        } else {
          let roles = hintOnlyRoles.get(h.loanId);
          if (!roles) {
            roles = new Set();
            hintOnlyRoles.set(h.loanId, roles);
          }
          roles.add(h.role);
        }
      }

      // Loans the indexer rows don't carry at all: synthesize a row
      // from the live loan struct — BOTH sides for chain-enumerated
      // ids (the enumeration proves holding but not which side), only
      // the hinted side(s) for hint-only ids.
      const extraIds = chainIdList.filter((id) => !byLoanId.has(id));
      const synthTargets: Array<{
        id: number;
        roles: readonly ('lender' | 'borrower')[];
      }> = extraIds.map((id) => ({ id, roles: ['lender', 'borrower'] }));
      for (const [id, roles] of hintOnlyRoles) {
        if (!extraIds.includes(id)) synthTargets.push({ id, roles: [...roles] });
      }
      const synthesized = (
        await Promise.all(
          synthTargets.map(async ({ id, roles }): Promise<PositionLoan[]> => {
            try {
              const base = await readLoanRowLive(
                publicClient,
                diamond,
                readChain.chainId,
                id,
              );
              if (!base) return [];
              return roles.map((role) => ({ ...base, role }));
            } catch (e) {
              // Revert = no such loan (stale/forged id) — skip; a
              // transport failure is "couldn't confirm".
              if (!isRevert(e)) transportFailed = true;
              return [];
            }
          }),
        )
      ).flat();

      // Fast approximate layer: the wallet's loans UNION the flipped
      // sides UNION the chain-discovered extras. `getClaimable` is the
      // authority for all of them.
      const pool = [...indexed, ...flipped, ...synthesized];

      // Rows in a REVERSIBLE state get a live status probe instead of
      // being trusted:
      //   - `active`: in the indexer-lag window a just-settled loan can
      //     still read `active` here, and dropping it on the cached
      //     status would hide a real, ready claim.
      //   - `fallback_pending`: the borrower can CURE back to Active,
      //     after which claimAsLender rejects — a cured loan must drop
      //     out of the claim list, not keep a doomed lender entry.
      const isReversible = (s: IndexedLoanStatus) =>
        s === 'active' || s === 'fallback_pending';
      const probeIds = [
        ...new Set(
          pool.filter((l) => isReversible(l.status)).map((l) => l.loanId),
        ),
      ];
      const liveStatusById = new Map<number, IndexedLoanStatus | null>();
      await Promise.all(
        probeIds.map(async (id) => {
          try {
            const live = await readLoanRowLive(
              publicClient,
              diamond,
              readChain.chainId,
              id,
            );
            liveStatusById.set(id, live?.status ?? null);
          } catch (e) {
            // Revert = no such loan (shouldn't happen for an indexed
            // row) — treat as unknowable and keep the row excluded.
            if (!isRevert(e)) transportFailed = true;
            liveStatusById.set(id, null);
          }
        }),
      );

      const candidates = pool
        .map((l): PositionLoan | null => {
          const status = isReversible(l.status)
            ? (liveStatusById.get(l.loanId) ?? null)
            : l.status;
          // `active` = nothing to claim yet (incl. a cured fallback);
          // null = unknowable → excluded. `settled` = both sides fully
          // consumed — ClaimFacet rejects it (InvalidLoanStatus on both
          // claim paths), matching the old /claimables route's skip.
          if (status == null || status === 'active' || status === 'settled') {
            return null;
          }
          return status === l.status ? l : { ...l, status };
        })
        .filter((l): l is PositionLoan => l !== null)
        // ClaimFacet.claimAsBorrower REJECTS FallbackPending — the
        // borrower's move there is cure/repay (on PositionDetails),
        // not claim — so only the LENDER side is a real candidate
        // while fallback is pending. Without this gate the Claim
        // Center would advertise a borrower claim that can't execute.
        .filter(
          (l) => !(l.role === 'borrower' && l.status === 'fallback_pending'),
        );

      const confirmed = await Promise.all(
        candidates.map(async (loan): Promise<ClaimableLoan | null> => {
          // PR C (§4.2.3): an identical candidate verified earlier this
          // session reuses its memoized verdict — zero probes. First
          // sight of a candidate (fresh load, changed identity, or a
          // post-bump run) always probes.
          const memoKey = claimVerdictKey(readChain.chainId, me, loan);
          const memo = memoReadable
            ? claimVerdictGet(memoKey)
            : { hit: false as const, value: undefined };
          if (memo.hit) return memo.value as ClaimableLoan | null;
          // Only a CLEAN verdict is memoizable: a transport failure is
          // "couldn't confirm", never a cacheable "not claimable".
          let clean = true;
          const verdict = await (async (): Promise<ClaimableLoan | null> => {
            const isLender = loan.role === 'lender';
            const tokenId = isLender ? loan.lenderTokenId : loan.borrowerTokenId;

            // 1. Does the wallet still hold this side's position NFT? A
            //    sold position isn't ours to claim; a burned one (revert)
            //    means the loan fully settled — nothing to claim either.
            try {
              const owner = (await publicClient.readContract({
                address: diamond,
                abi: DIAMOND_ABI_VIEM,
                functionName: 'ownerOf',
                args: [BigInt(tokenId)],
              })) as string;
              if (owner.toLowerCase() !== me) return null;
            } catch (e) {
              if (isRevert(e)) return null;
              transportFailed = true;
              clean = false;
              return null;
            }

            // 2. Authoritative claimable probe + Phase-5 borrower rebate.
            try {
              const res = (await publicClient.readContract({
                address: diamond,
                abi: DIAMOND_ABI_VIEM,
                functionName: 'getClaimable',
                args: [BigInt(loan.loanId), isLender],
              })) as ClaimableTuple;
              const claimAsset = res.asset ?? res[0] ?? null;
              const amount = res.amount ?? res[1] ?? 0n;
              const claimed = res.claimed ?? res[2] ?? false;
              const assetType = Number(res.assetType ?? res[3] ?? 0n);
              const heldForLender = res.heldForLender ?? res[6] ?? 0n;
              const hasRentalNftReturn = res.hasRentalNftReturn ?? res[7] ?? false;

              let lifRebate = 0n;
              if (!isLender) {
                try {
                  const rebate = (await publicClient.readContract({
                    address: diamond,
                    abi: DIAMOND_ABI_VIEM,
                    functionName: 'getBorrowerLifRebate',
                    args: [BigInt(loan.loanId)],
                  })) as readonly [bigint, bigint] | { rebateAmount?: bigint };
                  lifRebate = Array.isArray(rebate)
                    ? (rebate[0] ?? 0n)
                    : ((rebate as { rebateAmount?: bigint }).rebateAmount ?? 0n);
                } catch (e) {
                  // Old ABI without the Phase-5 view reverts → treat as no
                  // rebate; a transport error is a real "couldn't confirm".
                  if (!isRevert(e)) {
                    transportFailed = true;
                    clean = false;
                  }
                }
              }

              // Mirror ClaimFacet's actionability guard.
              const actionable =
                amount > 0n ||
                assetType !== AssetType.ERC20 ||
                heldForLender > 0n ||
                hasRentalNftReturn ||
                lifRebate > 0n;
              return !claimed && actionable
                ? ({
                    ...loan,
                    claim: {
                      asset:
                        typeof claimAsset === 'string' &&
                        claimAsset !== '0x0000000000000000000000000000000000000000'
                          ? claimAsset
                          : null,
                      amount,
                      heldForLender,
                      hasRentalNftReturn,
                      lifRebate,
                    },
                  } satisfies ClaimableLoan)
                : null;
            } catch (e) {
              if (isRevert(e)) return null;
              transportFailed = true;
              clean = false;
              return null;
            }
          })();
          // Cache only when the pass was CLEAN and the rail was
          // healthy when it started: a verdict captured while
          // invalidation signals were absent must not become readable
          // after a later recovery (Codex #1232 r2) — the drop-bump
          // only covers entries from BEFORE an outage, not during it.
          if (clean && memoReadable) {
            claimVerdictPut(memoKey, verdict, epochAtStart);
          }
          return verdict;
        }),
      );

      // Any unconfirmable candidate ⇒ unavailable, not a short list.
      if (transportFailed) return null;
      return confirmed.filter((l): l is ClaimableLoan => l !== null);
    },
  });
}
