/**
 * #2726 — the token-security screen every accept is held to, in one place.
 *
 * The independent token screen (GoPlus, `data/tokenSecurity.ts`) used to be
 * run by each surface on its own: the direct accept and the rental re-checked
 * their legs at submit, and the signed-offer fill did not screen at all, so a
 * maker could post a signed offer on a honeypot or fee-on-transfer token and
 * the Rate Desk presented it like any other. A surface added later could leave
 * the check out the same way.
 *
 * So the screen now has two halves that every accept surface shares:
 *
 *   - the REVIEW half, {@link useTokenScreen}: per-leg verdicts for the review
 *     to show, fail-closed while a verdict is pending, errored or blocking,
 *     plus the fingerprints of what it showed ({@link ReviewedTokenScreen});
 *   - the SIGN half, {@link assertTokenScreenLive}: run by BOTH accept signers
 *     (`useAcceptTermsSigning`, `useSignedOfferAcceptTermsSigning`) on the
 *     legs of the canonical terms they are about to sign. Each takes the
 *     reviewed fingerprints as a required input, so no accept can reach a
 *     wallet prompt without the screen, whichever surface drives it.
 *
 * The rule at sign time: a blocking verdict refuses; a check that cannot run
 * refuses (fail closed); a warning passes only when the review showed that
 * exact warning (same reasons), because consent was given against it. Clean,
 * curated and not-covered (test network) legs pass.
 */
import type { QueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import {
  fetchTokenSecurity,
  needsSecurityCheck,
  useTokenSecurity,
  verdictFingerprint,
  type TokenSecurityVerdict,
} from '../data/tokenSecurity';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ASSET_TYPE_ERC20 = 0; // LibVaipakam.AssetType.ERC20

/** The ERC-20 legs an accept can move, by stable id (never by the localized
 *  label, which differs per locale). */
export type ScreenLegKey = 'loanAsset' | 'collateral' | 'prepay';

export interface ScreenTarget {
  key: ScreenLegKey;
  address: string;
}

/** The verdict fingerprint (`verdictFingerprint`) the review showed for each
 *  leg it screened. A leg it did not screen is absent. */
export type ReviewedTokenScreen = Partial<Record<ScreenLegKey, string>>;

/** The localized name of a leg, as the gate messages and banners use it. */
export function screenLegLabel(key: ScreenLegKey): string {
  switch (key) {
    case 'loanAsset':
      return copy.offerFlow.securityLegLoanAsset;
    case 'collateral':
      return copy.offerFlow.securityLegCollateral;
    case 'prepay':
      return copy.rent.prepaymentTokenLabel;
  }
}

/** The ERC-20 legs of a deal, from its asset fields: the principal when it
 *  is an ERC-20, the collateral when it is one, and a rental's prepayment
 *  token (the rented NFT itself is not an ERC-20). Unset legs are skipped. */
export function screenTargets(t: {
  assetType: number;
  lendingAsset: string;
  collateralAssetType: number;
  collateralAsset: string;
  prepayAsset: string;
}): ScreenTarget[] {
  const set = (a: string | undefined) =>
    Boolean(a) && a!.toLowerCase() !== ZERO_ADDRESS;
  const out: ScreenTarget[] = [];
  if (Number(t.assetType) === ASSET_TYPE_ERC20 && set(t.lendingAsset)) {
    out.push({ key: 'loanAsset', address: t.lendingAsset });
  }
  if (Number(t.collateralAssetType) === ASSET_TYPE_ERC20 && set(t.collateralAsset)) {
    out.push({ key: 'collateral', address: t.collateralAsset });
  }
  if (Number(t.assetType) !== ASSET_TYPE_ERC20 && set(t.prepayAsset)) {
    out.push({ key: 'prepay', address: t.prepayAsset });
  }
  return out;
}

/** One leg as the review shows it. */
export interface ScreenLeg {
  key: ScreenLegKey;
  leg: string;
  verdict: TokenSecurityVerdict | undefined;
  errored: boolean;
}

export interface TokenScreen {
  /** Every leg that needs screening (curated legs never do). */
  legs: ScreenLeg[];
  /** Legs that hold the accept closed: a block, no verdict yet, or a failed
   *  check (a failed refetch keeps a stale verdict in `data`, so `errored`
   *  dominates it). */
  blocked: ScreenLeg[];
  warned: ScreenLeg[];
  unsupported: ScreenLeg[];
  /** No leg holds the accept closed. */
  ok: boolean;
  /** Changes whenever anything the review shows about the screen changes,
   *  reasons included, so consent given against an older screen is void. */
  fingerprint: string;
  /** What the review showed, for the signer's comparison. */
  reviewed: ReviewedTokenScreen;
  /** Re-run every leg's check (the banner's "Check again"). */
  retry: () => void;
}

const SLOTS: readonly ScreenLegKey[] = ['loanAsset', 'collateral', 'prepay'];

/** The review half: live verdicts for the given legs on `chainId`. */
export function useTokenScreen(
  chainId: number | undefined,
  targets: ScreenTarget[],
): TokenScreen {
  const addr = (key: ScreenLegKey) => targets.find((t) => t.key === key)?.address;
  // One hook per slot, always called, so the hook order never depends on
  // the deal's shape; a slot with no leg is disabled.
  const queries = {
    loanAsset: useTokenSecurity(chainId, addr('loanAsset')),
    collateral: useTokenSecurity(chainId, addr('collateral')),
    prepay: useTokenSecurity(chainId, addr('prepay')),
  };
  // 'needed' derives from the check's INPUTS (shape + curated), never from
  // query lifecycle state: fetchStatus returns to idle once a query settles,
  // which must not un-gate a bad verdict.
  const legs: ScreenLeg[] = SLOTS.filter((key) =>
    needsSecurityCheck(chainId, addr(key)),
  ).map((key) => ({
    key,
    leg: screenLegLabel(key),
    verdict: queries[key].data,
    errored: queries[key].isError,
  }));
  const blocked = legs.filter(
    (l) => l.errored || l.verdict === undefined || l.verdict.kind === 'block',
  );
  const warned = legs.filter((l) => !l.errored && l.verdict?.kind === 'warn');
  const unsupported = legs.filter((l) => l.verdict?.kind === 'unsupported');
  const reviewed: ReviewedTokenScreen = {};
  for (const l of legs) {
    if (!l.errored) reviewed[l.key] = verdictFingerprint(l.verdict);
  }
  return {
    legs,
    blocked,
    warned,
    unsupported,
    ok: blocked.length === 0,
    fingerprint: legs
      .map((l) => `${l.key}:${l.errored ? 'errored' : verdictFingerprint(l.verdict)}`)
      .join('|'),
    reviewed,
    retry: () => {
      for (const key of SLOTS) void queries[key].refetch();
    },
  };
}

/**
 * The sign half: re-screen the legs of the terms about to be signed, live,
 * and refuse before the wallet prompt unless every leg is clear or shows
 * exactly the warning the review showed. A changed verdict is put into the
 * shared cache so the review renders it (which voids consent there) and the
 * user can read it before trying again.
 */
export async function assertTokenScreenLive(opts: {
  chainId: number;
  targets: ScreenTarget[];
  reviewed: ReviewedTokenScreen;
  queryClient: QueryClient;
}): Promise<void> {
  for (const { key, address } of opts.targets) {
    if (!needsSecurityCheck(opts.chainId, address)) continue; // curated
    const leg = screenLegLabel(key);
    const cacheKey = ['tokenSecurity', opts.chainId, address.toLowerCase()];
    const v = await fetchTokenSecurity(opts.chainId, address);
    if (v.kind === 'block') {
      opts.queryClient.setQueryData(cacheKey, v);
      throw new Error(copy.tokenSecurity.gateBlock(leg, v.reasons.join('; ')));
    }
    if (v.kind === 'unknown') {
      // RESET (not invalidate) the cached verdict: reset drops it at once,
      // so the review's gate closes the moment the submit lock clears;
      // invalidate would keep the stale pass readable while the refetch is
      // in flight.
      void opts.queryClient.resetQueries({ queryKey: cacheKey });
      throw new Error(copy.tokenSecurity.gateUnknown(leg));
    }
    if (v.kind === 'warn' && verdictFingerprint(v) !== opts.reviewed[key]) {
      opts.queryClient.setQueryData(cacheKey, v);
      throw new Error(copy.tokenSecurity.gateChanged(leg));
    }
  }
}
