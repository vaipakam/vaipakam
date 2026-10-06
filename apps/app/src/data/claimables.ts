/**
 * On-chain-authoritative claimables (issue #921 item 7 / #958).
 *
 * app previously read the indexer's `/claimables` endpoint and
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
import type { PublicClient } from 'viem';
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
  tokenId?: bigint;
  quantity?: bigint;
  heldForLender?: bigint;
  hasRentalNftReturn?: boolean;
  0?: string;
  1?: bigint;
  2?: boolean;
  3?: bigint;
  4?: bigint;
  5?: bigint;
  6?: bigint;
  7?: boolean;
}

/** #2374 — what the loan owed at the moment it defaulted, as the protocol
 *  recorded it then (`getOwedAtDefault`). Read only for a defaulted or
 *  fallback-pending lender claim on an ERC-20 loan. `none` covers every case the protocol keeps no
 *  record for (a default before the record existed, a deployment without
 *  the view); `unreadable` is a transport failure, stated as such. */
export type OwedAtDefaultRead =
  | {
      kind: 'recorded';
      principal: bigint;
      interest: bigint;
      lateFee: bigint;
      /** The default entered the full-collateral fallback, so its recovery
       *  may have arrived in more than one step. */
      viaFallback: boolean;
    }
  | { kind: 'none' }
  | { kind: 'unreadable' };

const OWED_NONE: OwedAtDefaultRead = { kind: 'none' };

/** Read `getOwedAtDefault` for one loan. Never fails the claim probe: the
 *  figure is a comparison beside the payout, not part of it. */
export async function readOwedAtDefault(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  loanId: string | number,
): Promise<OwedAtDefaultRead> {
  try {
    const [principal, interest, lateFee, recordedAt, viaFallback] = (await publicClient.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getOwedAtDefault',
      args: [BigInt(loanId)],
    })) as readonly [bigint, bigint, bigint, bigint | number, boolean];
    if (BigInt(recordedAt) === 0n) return OWED_NONE;
    return { kind: 'recorded', principal, interest, lateFee, viaFallback };
  } catch (e) {
    // A deployment without the view reverts: it keeps no record.
    return isRevert(e) ? OWED_NONE : { kind: 'unreadable' };
  }
}

/** What the wallet would actually receive on claim — carried onto the
 *  row so the Claim Center can show the NUMBER instead of a vague
 *  "+ interest" / "proceeds or collateral" description (UX-002). The
 *  asset address comes from getClaimable itself, so formatting never
 *  guesses a token. */
export interface ClaimDetail {
  asset: string | null;
  amount: bigint;
  /** #2373 r4 — the claim row's own asset type, token id and quantity
   *  (`getClaimable`). A non-fungible claim pays an NFT with `amount == 0`,
   *  so without these the payout cannot name it beside another lane. */
  assetType: number;
  tokenId: bigint;
  quantity: bigint;
  heldForLender: bigint;
  /** #2373 r5 — the ONE asset held proceeds are paid in (ClaimFacet: the
   *  loan's `principalAsset`, or `prepayAsset` for a rental). Null when there
   *  are none, or when a rental's prepay asset could not be read. */
  heldAsset: string | null;
  hasRentalNftReturn: boolean;
  lifRebate: bigint;
  /** #2373 r2 — the borrower's frozen swap-to-repay surplus, a SEPARATE lane
   *  in the principal asset that `claimAsBorrower` pays alongside the
   *  ordinary claim (`getBorrowerSurplusClaim`). Null when there is none,
   *  it was already claimed, or this is the lender side. */
  surplus: { asset: string; amount: bigint } | null;
  /** #2373 r3 — collateral still held for the borrower in a DIFFERENT asset
   *  from the claim row (a fallback top-up that did not cure, followed by a
   *  successful lender retry: the row holds the loan-asset surplus while the
   *  top-up stays liened). `claimAsBorrower` pays it as a second transfer
   *  (`getLoanCollateralLien`). Null when there is none, or on the lender
   *  side. It never makes a claim actionable by itself — the contract's
   *  NothingToClaim guard does not count it. */
  extraCollateral: { asset: string; amount: bigint } | null;
  /** #2374 — what the loan owed when it defaulted. `none` unless this is a
   *  defaulted or fallback-pending lender claim on an ERC-20 loan with a
   *  record. */
  owedAtDefault: OwedAtDefaultRead;
}

export interface ClaimableLoan extends PositionLoan {
  claim: ClaimDetail;
}

/** The verdict of one claim probe. `unconfirmed` is a transport failure —
 *  "couldn't confirm", never a "not claimable". */
export type ClaimProbe =
  | { kind: 'claimable'; loan: ClaimableLoan }
  | { kind: 'none' }
  | { kind: 'unconfirmed' };
const NONE: ClaimProbe = { kind: 'none' };
const UNCONFIRMED: ClaimProbe = { kind: 'unconfirmed' };
const claimable = (loan: ClaimableLoan): ClaimProbe => ({ kind: 'claimable', loan });

/** Whether a probe's verdict may be memoized for reuse. A transport failure
 *  is never memoized ("couldn't confirm" is not "not claimable"), and
 *  neither is a claimable row whose owed-at-default read failed (#2374): the
 *  payout is sound, but reusing it would repeat "couldn't be read just now"
 *  for the cache's whole lifetime instead of retrying once the RPC recovers. */
export function isMemoizableProbe(probe: ClaimProbe): boolean {
  if (probe.kind === 'unconfirmed') return false;
  return !(probe.kind === 'claimable' && owedReadFailed(probe.loan));
}

/** #2374 — a claim row whose owed-at-default read failed in transport: the
 *  payout is sound, but the figure should be read again soon. */
export function owedReadFailed(loan: ClaimableLoan | null | undefined): boolean {
  return loan?.claim.owedAtDefault.kind === 'unreadable';
}

/** #2426 r3 — how soon the loan page re-reads its claim: only while the
 *  owed-at-default figure could not be read, so a transient RPC failure does
 *  not leave "couldn't be read just now" on the page (the query otherwise
 *  refetches only on an invalidation). */
export const OWED_RETRY_MS = 30_000;
export function loanClaimRefetchInterval(loan: ClaimableLoan | null | undefined): number | false {
  return owedReadFailed(loan) ? OWED_RETRY_MS : false;
}

/** Probe ONE candidate: does `me` still hold this side's position NFT,
 *  and what does `getClaimable` say it pays? The single implementation
 *  behind both the wallet-wide claim list and the loan page's own read
 *  (UX3-004 round 1 — the loan page must not scan the whole wallet to
 *  learn about one loan). */
export async function probeClaim(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  me: string,
  loan: PositionLoan,
): Promise<ClaimProbe> {
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
    if (owner.toLowerCase() !== me) return NONE;
  } catch (e) {
    if (isRevert(e)) return NONE;
    return UNCONFIRMED;
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
    const tokenId = res.tokenId ?? res[4] ?? 0n;
    const quantity = res.quantity ?? res[5] ?? 0n;
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
        if (!isRevert(e)) return UNCONFIRMED;
      }
    }

    // #2373 r2 — the frozen swap-to-repay surplus. A claim can consist of
    // ONLY this lane (a full swap-to-repay that consumed all the collateral
    // leaves `amount == 0`); ClaimFacet keeps the loan claimable for it, so
    // the actionability guard below must count it or that claim is never
    // listed.
    let surplus: { asset: string; amount: bigint } | null = null;
    if (!isLender) {
      try {
        const sc = (await publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getBorrowerSurplusClaim',
          args: [BigInt(loan.loanId)],
        })) as readonly [string, bigint, boolean];
        const [sAsset, sAmount, sClaimed] = sc;
        if (
          !sClaimed &&
          sAmount > 0n &&
          sAsset !== '0x0000000000000000000000000000000000000000'
        ) {
          surplus = { asset: sAsset, amount: sAmount };
        }
      } catch (e) {
        // A deployment without the view reverts → no surplus lane there; a
        // transport error is a real "couldn't confirm".
        if (!isRevert(e)) return UNCONFIRMED;
      }
    }

    // #2373 r3 — the liened collateral the claim row cannot carry because it
    // is a different asset. Mirrors ClaimFacet: paid when the lien is live,
    // non-zero, and not the claim row's own asset.
    let extraCollateral: { asset: string; amount: bigint } | null = null;
    if (!isLender) {
      try {
        const lien = (await publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getLoanCollateralLien',
          args: [BigInt(loan.loanId)],
        })) as { asset: string; amount: bigint; released: boolean };
        if (
          !lien.released &&
          lien.amount > 0n &&
          typeof claimAsset === 'string' &&
          lien.asset.toLowerCase() !== claimAsset.toLowerCase()
        ) {
          extraCollateral = { asset: lien.asset, amount: lien.amount };
        }
      } catch (e) {
        // A deployment without the view reverts → no such lane there; a
        // transport error is a real "couldn't confirm".
        if (!isRevert(e)) return UNCONFIRMED;
      }
    }

    // #2373 r5 — the asset held proceeds are paid in. An ERC-20 loan's is
    // the lending asset already on the row; a rental's is its prepay asset,
    // which the row does not carry, so read it — only in the rare case that
    // proceeds are actually held. A failed read leaves it unknown, which the
    // payout states rather than guesses.
    let heldAsset: string | null = null;
    if (isLender && heldForLender > 0n) {
      if (loan.assetType === AssetType.ERC20) {
        heldAsset = loan.lendingAsset;
      } else {
        try {
          const details = (await publicClient.readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getLoanDetails',
            args: [BigInt(loan.loanId)],
          })) as { prepayAsset?: string };
          heldAsset = details.prepayAsset ?? null;
        } catch {
          heldAsset = null;
        }
      }
    }

    // #2374 — what the loan owed at default, for the comparison beside a
    // defaulted lender claim.
    const owedAtDefault =
      isLender &&
      loan.assetType === AssetType.ERC20 &&
      (loan.status === 'defaulted' ||
        loan.status === 'liquidated' ||
        // #2426 r2 — the fallback's entry IS the default, and the protocol
        // reports its record while the loan stands in the fallback.
        loan.status === 'fallback_pending')
        ? await readOwedAtDefault(publicClient, diamond, loan.loanId)
        : OWED_NONE;

    // Mirror ClaimFacet's actionability guard.
    const actionable =
      amount > 0n ||
      assetType !== AssetType.ERC20 ||
      heldForLender > 0n ||
      hasRentalNftReturn ||
      lifRebate > 0n ||
      surplus !== null;
    return !claimed && actionable
      ? claimable({
          ...loan,
          claim: {
            asset:
              typeof claimAsset === 'string' &&
              claimAsset !== '0x0000000000000000000000000000000000000000'
                ? claimAsset
                : null,
            amount,
            assetType,
            tokenId,
            quantity,
            heldForLender,
            heldAsset,
            hasRentalNftReturn,
            lifRebate,
            surplus,
            extraCollateral,
            owedAtDefault,
          },
        })
      : NONE;
  } catch (e) {
    if (isRevert(e)) return NONE;
    return UNCONFIRMED;
  }
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
      // #1247 PAG-003 — the same fail-loud walk ceiling
      // chainPositions.ts uses, applied to BOTH enumeration paths
      // (the paginated walk AND the legacy unpaginated fallback,
      // Codex #1265 r2). Past it the candidate set is
      // unknowable-in-practice (thousands of position NFTs), and an
      // unbounded walk + per-candidate probing is exactly the RPC
      // fan-out this page must never do; unavailable beats a scan
      // that never ends.
      const WALK_CAP = 2000n;
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
          if (offset >= WALK_CAP) return null;
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
          // #1247 PAG-003 (Codex #1265 r2) — the legacy view is
          // unbounded; the per-candidate probing that follows must
          // respect the same fail-loud ceiling as the paginated walk.
          if (legacy[0].length > Number(WALK_CAP)) return null;
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
      // PR C hint fetch happens BEFORE the unavailability collapse
      // (Codex #1232 r4): the lean capped hint route can answer when
      // the heavier by-lender/by-borrower reads behind useMyLoans did
      // not, and it is the last remaining discovery source when the
      // enumeration views are absent too. Fallback-only posture
      // unchanged: with the enumeration working the hint is skipped.
      const hintRes = enumerationAvailable
        ? null
        : await fetchClaimCandidates(readChain.chainId, me).catch(() => null);
      const hints = hintRes?.candidates ?? [];
      if (indexerDown && !enumerationAvailable) {
        // Last-resort posture: a NON-empty, non-truncated hint yields
        // rows the confirm fan-out below verifies live (ownerOf +
        // getClaimable), so showing them beats "unavailable". An
        // empty or truncated hint cannot support a confident "no
        // claims" — that stays unavailable, never a short list.
        if (hints.length === 0 || hintRes?.truncated) return null;
      }

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
          const probe = await probeClaim(publicClient, diamond, me, loan);
          if (probe.kind === 'unconfirmed') transportFailed = true;
          const clean = isMemoizableProbe(probe);
          const verdict = probe.kind === 'claimable' ? probe.loan : null;
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

/** One loan's claim on one side, for the loan page (UX3-004, #2373 round 1).
 *
 *  The loan page used to call {@link useMyClaimables} — the whole wallet's
 *  claim scan, up to its 2,000-position ceiling — to learn about one loan.
 *  This probes only this loan's side: one `ownerOf`, and `getClaimable`
 *  only if the wallet holds that side's position NFT.
 *
 *  Deliberately NOT gated on the loan's status. The page's reconciled
 *  status is resolved below its early returns, and gating on the indexed
 *  status instead would recreate UX3-001: a read disabled on a lagging row
 *  leaves the payout "checking" for good. An active loan simply probes to
 *  "nothing claimable".
 *
 *  `data`: the claimable loan, or `null` when there is nothing to claim on
 *  this side. An unconfirmable read is an ERROR, never a `null` — "couldn't
 *  confirm" is not "nothing to claim". Shares the `claimables` key root, so
 *  every existing invalidation after a claim reaches it too. */
export function useLoanClaim(
  loan: IndexedLoanForClaim | undefined,
  role: 'lender' | 'borrower',
) {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const me = address?.toLowerCase();
  return useQuery({
    queryKey: [
      'claimables',
      'loan',
      readChain.chainId,
      me,
      loan?.loanId,
      role,
      loan?.status,
      loan?.lenderTokenId,
      loan?.borrowerTokenId,
    ],
    enabled: Boolean(publicClient && me && loan),
    staleTime: 30_000,
    refetchInterval: (query) => loanClaimRefetchInterval(query.state.data),
    queryFn: async (): Promise<ClaimableLoan | null> => {
      const probe = await probeClaim(publicClient!, readChain.diamondAddress, me!, {
        ...loan!,
        role,
      });
      if (probe.kind === 'unconfirmed') throw new Error('claim read could not be confirmed');
      return probe.kind === 'claimable' ? probe.loan : null;
    },
  });
}

/** The indexed loan row a loan-scoped claim probe starts from. */
export type IndexedLoanForClaim = Omit<PositionLoan, 'role'>;
