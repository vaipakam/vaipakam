/**
 * GoPlus token-security screening (#1036).
 *
 * THREAT MODEL — the accept side is primary: a malicious actor
 * creates their offer straight against the Diamond (no website), so
 * the creator-side paste-branch check never ran for it. The offer
 * then sits on the shared book looking normal, collateralized by (or
 * lending) a honeypot / pump-and-dump token that CANNOT be sold or
 * transferred no matter what the deal terms say — the one harm class
 * the illiquid-consent warnings can't catch, because those only say
 * "unpriced", not "booby-trapped".
 *
 * The public GoPlus endpoint needs no API key (per-IP rate limits),
 * which fits alpha02's no-operator-secret posture. Verdicts are
 * cached per (chainId, address) in the shared react-query cache with
 * a long stale time — contract maliciousness doesn't flip minute to
 * minute, and the book badges must not hammer the rate limit.
 *
 * POSTURE:
 *  - curated tokens: never screened (pre-vetted list, no extra call);
 *  - pasted / offer-carried non-curated tokens: fail-CLOSED at the
 *    gates — "couldn't check" is a blocking state with its own copy,
 *    never silently treated as clean;
 *  - hard signals (honeypot / can't-sell-all / blacklist+transfer-
 *    pausable) → BLOCK; soft signals (heavy tax, owner-mint,
 *    owner-balance-mutation) → loud warning the user must explicitly
 *    accept via the existing consent mechanics;
 *  - "couldn't evaluate" ≠ "clear": closed-source contracts and rows
 *    whose hard trade signals GoPlus left null/empty BLOCK (the row
 *    exists but proves nothing), and an unknown tax is disclosed as
 *    a warning rather than coerced to 0%.
 */
import { useQuery } from '@tanstack/react-query';
import { getCanonicalAssetsForChain } from '@vaipakam/lib';

const GOPLUS_ORIGIN = 'https://api.gopluslabs.io';
const TIMEOUT_MS = 6_000;

/** Chains GoPlus's token_security endpoint covers that we deploy to.
 *  A chain missing here yields verdict 'unsupported' — surfaced as a
 *  soft notice, NOT a block: on test networks every faucet mock would
 *  otherwise be unbuyable (GoPlus doesn't index testnets). */
const GOPLUS_CHAINS = new Set([1, 56, 8453, 42161, 10, 137]);

export type TokenSecurityVerdict =
  | { kind: 'clean' }
  | { kind: 'warn'; reasons: string[] }
  | { kind: 'block'; reasons: string[] }
  | { kind: 'unsupported' } // chain not covered by GoPlus (testnets)
  | { kind: 'unknown' }; // API unreachable / no data — fail-closed at gates

/** GoPlus row fields arrive as '0'/'1'/numeric strings when
 *  evaluated, and as JSON null, empty string, or absent when the
 *  check did not run — all three "not evaluated" shapes must be
 *  handled identically. */
type GoPlusField = string | null | undefined;

interface GoPlusTokenRow {
  is_honeypot?: GoPlusField;
  cannot_sell_all?: GoPlusField;
  cannot_buy?: GoPlusField;
  buy_tax?: GoPlusField;
  sell_tax?: GoPlusField;
  transfer_tax?: GoPlusField;
  is_mintable?: GoPlusField;
  owner_change_balance?: GoPlusField;
  is_blacklisted?: GoPlusField;
  transfer_pausable?: GoPlusField;
  is_open_source?: GoPlusField;
}

const flag = (v: GoPlusField) => v === '1';
/** GoPlus encodes "we evaluated this" as '0'/'1'; a missing, null,
 *  or empty field means the check did NOT run for this token — which
 *  must never silently read as "clear". */
const flagKnown = (v: GoPlusField) => v === '0' || v === '1';
/** Tax as a percentage, or null when GoPlus reports it as UNKNOWN —
 *  the docs define an empty tax as "could not be determined", which
 *  is not the same thing as 0% (and Number(null) is 0, so the
 *  null/empty guard must run before any numeric coercion). */
const taxPct = (v: GoPlusField): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n * 100 : null;
};

/** Map a GoPlus row onto the block/warn/clean verdict. Exported for
 *  tests and for the eligibility gate's copy. */
export function classifyTokenSecurity(row: GoPlusTokenRow): TokenSecurityVerdict {
  // Closed-source (or unreported-source) contract: GoPlus leaves the
  // other risk items null for these, so NOTHING below can clear it —
  // treating null fields as "no signal" would classify precisely the
  // least-verifiable tokens as clean. Fail closed with honest copy.
  if (row.is_open_source !== '1') {
    return {
      kind: 'block',
      reasons: [
        'the contract source code is not verified, so its behaviour cannot be independently checked',
      ],
    };
  }
  const block: string[] = [];
  const warn: string[] = [];
  // The honeypot simulation is the load-bearing hard signal and must
  // be POSITIVELY known-clear ('0') — missing means "couldn't
  // verify", which the gates hold back, not a pass. The secondary
  // restriction checks degrade to a LOUD warning instead of a block:
  // GoPlus leaves them null even on majors (live USDT row 2026-07-05:
  // is_honeypot '0' but cannot_sell_all null), so blocking on their
  // absence would flag exactly the tokens users know are fine and
  // teach them to ignore the screen.
  if (!flagKnown(row.is_honeypot)) {
    block.push('its critical honeypot check could not be evaluated');
  }
  // EVERY other risk flag gets the same "unevaluated ≠ clear"
  // treatment: a null/missing owner-control or trade-restriction
  // check is disclosed, never silently read as a pass. (Live
  // sampling 2026-07-05 shows majors carry these as '0'/'1', so
  // this warn is quiet for normal tokens.)
  const unevaluated: string[] = [];
  if (!flagKnown(row.cannot_sell_all)) unevaluated.push('sell-restriction');
  if (!flagKnown(row.cannot_buy)) unevaluated.push('buy-restriction');
  if (!flagKnown(row.is_blacklisted)) unevaluated.push('owner-blacklist');
  if (!flagKnown(row.transfer_pausable)) unevaluated.push('transfer-pause');
  if (!flagKnown(row.is_mintable)) unevaluated.push('minting');
  if (!flagKnown(row.owner_change_balance)) unevaluated.push('balance-rewrite');
  if (unevaluated.length > 0) {
    warn.push(
      `its ${unevaluated.join(', ')} check${unevaluated.length > 1 ? 's' : ''} could not be evaluated`,
    );
  }
  if (flag(row.is_honeypot)) block.push('flagged as a honeypot — buyers cannot sell it');
  if (flag(row.cannot_sell_all)) block.push('holders are prevented from selling their full balance');
  if (flag(row.cannot_buy)) block.push('buying is restricted by the contract');
  if (flag(row.is_blacklisted) && flag(row.transfer_pausable)) {
    block.push('the owner can blacklist holders AND pause all transfers');
  } else {
    if (flag(row.is_blacklisted)) warn.push('the owner can blacklist individual holders');
    if (flag(row.transfer_pausable)) warn.push('the owner can pause all transfers');
  }
  // All THREE tax surfaces matter here: the protocol moves these
  // tokens with plain transfers (vault pulls, repayments), so a
  // transfer tax skews received amounts exactly like a sell tax
  // skews liquidation. Unknown taxes are disclosed, not zeroed.
  const taxes: Array<[string, number | null]> = [
    ['sell', taxPct(row.sell_tax)],
    ['buy', taxPct(row.buy_tax)],
    ['transfer', taxPct(row.transfer_tax)],
  ];
  for (const [label, pct] of taxes) {
    if (pct === null) continue; // folded into one warn line below
    if (pct >= 50) block.push(`a ${pct.toFixed(0)}% ${label} tax`);
    else if (pct >= 10) warn.push(`a ${pct.toFixed(0)}% ${label} tax`);
  }
  const unknownTaxes = taxes.filter(([, p]) => p === null).map(([l]) => l);
  if (unknownTaxes.length > 0) {
    warn.push(`its ${unknownTaxes.join('/')} tax could not be determined`);
  }
  if (flag(row.is_mintable) && flag(row.owner_change_balance)) {
    warn.push('the owner can mint AND rewrite holder balances');
  } else if (flag(row.owner_change_balance)) {
    warn.push('the owner can rewrite holder balances');
  } else if (flag(row.is_mintable)) {
    warn.push('the owner can mint more supply (dilution risk)');
  }
  if (block.length) return { kind: 'block', reasons: [...block, ...warn] };
  if (warn.length) return { kind: 'warn', reasons: warn };
  return { kind: 'clean' };
}

/** One-shot fetch — exported so submit-time gates can re-verify
 *  without a hook. Returns 'unknown' on any failure (fail-closed at
 *  the caller's gate). */
export async function fetchTokenSecurity(
  chainId: number,
  address: string,
): Promise<TokenSecurityVerdict> {
  if (!GOPLUS_CHAINS.has(chainId)) return { kind: 'unsupported' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(
      `${GOPLUS_ORIGIN}/api/v1/token_security/${chainId}?contract_addresses=${address.toLowerCase()}`,
      { signal: ctrl.signal },
    );
    clearTimeout(t);
    if (!res.ok) return { kind: 'unknown' };
    const body = (await res.json()) as {
      result?: Record<string, GoPlusTokenRow>;
    };
    const row = body.result?.[address.toLowerCase()];
    if (!row) return { kind: 'unknown' }; // not indexed — can't clear it
    return classifyTokenSecurity(row);
  } catch {
    return { kind: 'unknown' };
  }
}

/** Does this token need a security check at all? Valid address shape
 *  AND not on the curated list — the single definition the gates use
 *  for "needed", so a settled query can't un-gate a bad verdict (the
 *  hook's fetchStatus returns to idle after settling and must never
 *  be the gate's needed-signal). */
export function needsSecurityCheck(
  chainId: number | undefined,
  address: string | undefined,
): boolean {
  return Boolean(
    chainId &&
      address &&
      /^0x[a-fA-F0-9]{40}$/.test(address) &&
      !isCuratedAsset(chainId, address),
  );
}

/** Stable fingerprint of a verdict INCLUDING its reason content.
 *  Consent-reset effects and the submit-time "was this disclosed?"
 *  comparison both key on this: a warn whose REASONS changed (e.g.
 *  "10% sell tax" → "the owner can pause all transfers") is a new
 *  disclosure even though the verdict kind stayed 'warn', so consent
 *  given against the old text must not survive it. */
export function verdictFingerprint(
  v: TokenSecurityVerdict | undefined,
): string {
  if (v === undefined) return 'pending';
  return 'reasons' in v ? `${v.kind}:${v.reasons.join(',')}` : v.kind;
}

/** Is this address on the chain's curated list (pre-vetted — never
 *  screened, never blocked)? */
export function isCuratedAsset(chainId: number, address: string): boolean {
  try {
    return getCanonicalAssetsForChain(chainId)
      .map((a: string) => a.toLowerCase())
      .includes(address.toLowerCase());
  } catch {
    return false;
  }
}

/** Reactive verdict for a NON-curated token. Disabled (returns
 *  undefined data) for curated/empty addresses. Long stale time:
 *  maliciousness signals don't flip minute-to-minute and the shared
 *  cache keeps the book badges inside the public rate limit. */
export function useTokenSecurity(
  chainId: number | undefined,
  address: string | undefined,
) {
  const enabled = needsSecurityCheck(chainId, address);
  return useQuery({
    queryKey: ['tokenSecurity', chainId, address?.toLowerCase()],
    enabled,
    staleTime: 10 * 60_000,
    gcTime: 60 * 60_000,
    retry: 1,
    // While the check is FAILING the gate holds the flow closed and
    // the copy says "try again in a moment" — so a moment later must
    // actually bring a retry. Poll every 30s in the error state only;
    // a settled verdict never re-polls (staleTime governs those).
    // Manual retry: the gate banners also expose this hook's
    // `refetch` as a "Check again" button.
    refetchInterval: (query) =>
      query.state.status === 'error' ? 30_000 : false,
    queryFn: async () => {
      const v = await fetchTokenSecurity(chainId!, address!);
      // A transient outage must NOT become a cached 10-minute
      // blocking verdict: throw instead, so react-query retries and
      // keeps refetching (interval above + focus) while the gates
      // hold fail-closed.
      if (v.kind === 'unknown') throw new Error('token security check unavailable');
      return v;
    },
  });
}
