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
 *  - hard signals (honeypot / can't-sell-all / counterfeit /
 *    self-destruct / per-address tax control / ANY fee-on-transfer /
 *    blacklist+transfer-pausable) → BLOCK; soft signals (heavy
 *    buy/sell tax, owner-mint, balance-rewrite, proxy upgradeability,
 *    hidden owner, modifiable global tax or limits, anti-whale,
 *    cooldowns, whitelists) → loud warning the user must explicitly
 *    accept via the existing consent mechanics;
 *  - "couldn't evaluate" ≠ "clear": closed-source contracts and rows
 *    whose hard trade signals GoPlus left null/empty BLOCK (the row
 *    exists but proves nothing), and an unknown tax is disclosed as
 *    a warning rather than coerced to 0%.
 */
import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCanonicalAssetsForChain } from '@vaipakam/lib';

const GOPLUS_ORIGIN = 'https://api.gopluslabs.io';
const TIMEOUT_MS = 6_000;

/** Chains GoPlus's token_security endpoint covers that we deploy to.
 *  A chain missing here yields verdict 'unsupported' — surfaced as a
 *  soft notice, NOT a block: on test networks every faucet mock would
 *  otherwise be unbuyable (GoPlus doesn't index testnets). */
const GOPLUS_CHAINS = new Set([1, 56, 8453, 42161, 10, 137]);
// Test-only widening: the fork tier runs on Base Sepolia, which GoPlus
// doesn't index, so badge/exclusion behaviour would be structurally
// invisible to CI. The badges spec spawns a dev server with
// VITE_GOPLUS_EXTRA_CHAINS=84532 and route-mocks the GoPlus origin.
// Never set in production builds.
for (const raw of (import.meta.env.VITE_GOPLUS_EXTRA_CHAINS ?? '').split(',')) {
  const id = Number(raw.trim());
  if (Number.isInteger(id) && id > 0) GOPLUS_CHAINS.add(id);
}

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
  is_whitelisted?: GoPlusField;
  is_anti_whale?: GoPlusField;
  anti_whale_modifiable?: GoPlusField;
  trading_cooldown?: GoPlusField;
  hidden_owner?: GoPlusField;
  can_take_back_ownership?: GoPlusField;
  is_proxy?: GoPlusField;
  selfdestruct?: GoPlusField;
  slippage_modifiable?: GoPlusField;
  personal_slippage_modifiable?: GoPlusField;
  external_call?: GoPlusField;
  is_open_source?: GoPlusField;
  /** Scam-only flags — per the GoPlus docs, "no return" on these
   *  means the behaviour is absent, so like fake_token they block on
   *  '1' but are exempt from the unevaluated-disclosure line. */
  gas_abuse?: GoPlusField;
  is_airdrop_scam?: GoPlusField;
  /** Counterfeit detector — an OBJECT, not a '0'/'1' string. Null or
   *  absent on genuine tokens (live majors 2026-07-05 all carry
   *  null), so null here means "genuine", NOT "unevaluated". */
  fake_token?: { value?: number; true_token_address?: GoPlusField } | null;
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
  // sampling 2026-07-05 shows majors carry ALL of these as '0'/'1',
  // so this warn is quiet for normal tokens. fake_token is exempt on
  // purpose — it is null on genuine tokens by design.)
  const unevaluatedChecks: Array<[GoPlusField, string]> = [
    [row.cannot_sell_all, 'sell-restriction'],
    [row.cannot_buy, 'buy-restriction'],
    [row.is_blacklisted, 'owner-blacklist'],
    [row.transfer_pausable, 'transfer-pause'],
    [row.is_whitelisted, 'whitelist'],
    [row.is_anti_whale, 'transfer-size-limit'],
    [row.anti_whale_modifiable, 'limit-modifiability'],
    [row.trading_cooldown, 'trading-cooldown'],
    [row.hidden_owner, 'hidden-owner'],
    [row.can_take_back_ownership, 'ownership-takeback'],
    [row.is_proxy, 'proxy-upgradeability'],
    [row.selfdestruct, 'self-destruct'],
    [row.slippage_modifiable, 'tax-modifiability'],
    [row.personal_slippage_modifiable, 'per-address-tax'],
    [row.is_mintable, 'minting'],
    [row.owner_change_balance, 'balance-rewrite'],
    [row.external_call, 'external-call'],
  ];
  const unevaluated = unevaluatedChecks
    .filter(([v]) => !flagKnown(v))
    .map(([, name]) => name);
  if (unevaluated.length > 0) {
    warn.push(
      `its ${unevaluated.join(', ')} check${unevaluated.length > 1 ? 's' : ''} could not be evaluated`,
    );
  }
  // ---- BLOCK-tier signals -----------------------------------------
  if (flag(row.is_honeypot)) block.push('flagged as a honeypot — buyers cannot sell it');
  if (flag(row.cannot_sell_all)) block.push('holders are prevented from selling their full balance');
  if (flag(row.cannot_buy)) block.push('buying is restricted by the contract');
  if (row.fake_token?.value === 1) {
    block.push('flagged as a counterfeit imitation of a well-known token');
  }
  if (flag(row.selfdestruct)) {
    block.push('the contract can self-destruct, erasing every holder balance');
  }
  if (flag(row.gas_abuse)) {
    block.push('flagged for gas abuse — interacting with it drains extra gas');
  }
  if (flag(row.is_airdrop_scam)) {
    block.push('flagged as an airdrop scam');
  }
  // Per-ADDRESS tax control is a targeted-honeypot lever: the owner
  // can set a punitive rate for one specific holder — e.g. the vault
  // or the counterparty — after the deal opens. Global modifiability
  // is warn-tier below (USDT itself carries slippage_modifiable '1').
  if (flag(row.personal_slippage_modifiable)) {
    block.push('the owner can set a custom trading tax for individual addresses');
  }
  if (flag(row.is_blacklisted) && flag(row.transfer_pausable)) {
    block.push('the owner can blacklist holders AND pause all transfers');
  } else {
    if (flag(row.is_blacklisted)) warn.push('the owner can blacklist individual holders');
    if (flag(row.transfer_pausable)) warn.push('the owner can pause all transfers');
  }
  // Taxes. Buy/sell taxes hit DEX trades (liquidation swaps) and use
  // punitive-threshold tiers. A TRANSFER tax is stricter: the vault
  // records deposits at the REQUESTED amount straight after
  // safeTransferFrom (no balance-delta check), so ANY fee on plain
  // transfers under-funds the vault while accounting assumes the
  // full signed amount — fee-on-transfer tokens are structurally
  // incompatible, not merely risky. Unknown taxes are disclosed,
  // never zeroed.
  const st = taxPct(row.sell_tax);
  const bt = taxPct(row.buy_tax);
  const tt = taxPct(row.transfer_tax);
  for (const [label, pct] of [
    ['sell', st],
    ['buy', bt],
  ] as const) {
    if (pct === null) continue; // folded into one warn line below
    if (pct >= 50) block.push(`a ${pct.toFixed(0)}% ${label} tax`);
    else if (pct >= 10) warn.push(`a ${pct.toFixed(0)}% ${label} tax`);
  }
  if (tt !== null && tt > 0) {
    block.push(
      `a ${tt >= 1 ? tt.toFixed(0) : tt.toFixed(2)}% fee on plain transfers — the protocol's vault accounting cannot absorb tokens that take a cut of every transfer`,
    );
  }
  const unknownTaxes = (
    [
      ['sell', st],
      ['buy', bt],
      ['transfer', tt],
    ] as const
  )
    .filter(([, p]) => p === null)
    .map(([l]) => l);
  if (unknownTaxes.length > 0) {
    warn.push(`its ${unknownTaxes.join('/')} tax could not be determined`);
  }
  // ---- WARN-tier owner powers & structure --------------------------
  if (flag(row.slippage_modifiable)) {
    warn.push('the owner can change the trading tax at any time');
  }
  if (flag(row.hidden_owner)) {
    warn.push('the contract has a hidden owner — privileged control is obscured');
  }
  if (flag(row.can_take_back_ownership)) {
    warn.push('ownership can be reclaimed after being renounced');
  }
  if (flag(row.is_proxy)) {
    warn.push('an upgradeable proxy — its behaviour can be changed after review');
  }
  if (flag(row.is_whitelisted)) {
    warn.push('the owner can exempt chosen addresses from its trading restrictions');
  }
  if (flag(row.is_anti_whale)) {
    warn.push('transfers above a size limit can fail (anti-whale limits)');
  }
  if (flag(row.anti_whale_modifiable)) {
    warn.push('the owner can change the transfer size limits at any time');
  }
  if (flag(row.trading_cooldown)) {
    warn.push('enforces a cooldown between trades');
  }
  // Warn tier by live evidence: USDT itself carries external_call
  // '1' — common on legitimate tokens, but the behaviour genuinely
  // depends on code outside this contract, so it is disclosed.
  if (flag(row.external_call)) {
    warn.push('it calls other contracts while transferring — behaviour depends on external code');
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

/** Batch variant of {fetchTokenSecurity} — the GoPlus endpoint takes
 *  comma-separated addresses, so one call screens a page of offers
 *  (#1036 badges slice; the public per-IP rate limit is the reason
 *  this exists). Per-address verdicts: an address the response lacks
 *  a row for is 'unknown' — not indexed proves nothing. A failed
 *  chunk yields 'unknown' for its addresses only. */
export async function fetchTokenSecurityBatch(
  chainId: number,
  addresses: string[],
): Promise<Map<string, TokenSecurityVerdict>> {
  const out = new Map<string, TokenSecurityVerdict>();
  const lower = [...new Set(addresses.map((a) => a.toLowerCase()))];
  if (!GOPLUS_CHAINS.has(chainId)) {
    for (const a of lower) out.set(a, { kind: 'unsupported' });
    return out;
  }
  // Chunk conservatively — very long query strings risk proxy/URL
  // limits and one failure otherwise voids the whole page's verdicts.
  const CHUNK = 20;
  for (let i = 0; i < lower.length; i += CHUNK) {
    const chunk = lower.slice(i, i + CHUNK);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(
        `${GOPLUS_ORIGIN}/api/v1/token_security/${chainId}?contract_addresses=${chunk.join(',')}`,
        { signal: ctrl.signal },
      );
      clearTimeout(t);
      if (!res.ok) throw new Error(`goplus ${res.status}`);
      const body = (await res.json()) as {
        result?: Record<string, GoPlusTokenRow>;
      };
      for (const a of chunk) {
        const row = body.result?.[a];
        out.set(a, row ? classifyTokenSecurity(row) : { kind: 'unknown' });
      }
    } catch {
      for (const a of chunk) out.set(a, { kind: 'unknown' });
    }
  }
  return out;
}

export interface ScreenableLeg {
  chainId: number;
  address: string;
}

const EMPTY_VERDICTS: Record<string, TokenSecurityVerdict> = {};

/** Verdict lookup key for a book leg — offers on the book can carry
 *  their own chainId, so verdicts are chain-scoped. */
export function legVerdictKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

/** Page-level screening for the browsing surfaces (#1036): ONE query
 *  batch-screens every distinct non-curated leg currently visible,
 *  grouped by chain, and returns a `legVerdictKey`-indexed record.
 *
 *  Cache discipline: per-address verdicts already settled by the
 *  accept/paste gates are REUSED (no refetch), and every settled
 *  batch verdict is seeded back into the per-address
 *  ['tokenSecurity', chainId, address] key so the gates get it for
 *  free — one screen per token per session, whichever surface asked
 *  first. 'unknown' is deliberately never seeded: the gate hook
 *  treats unknown as a retryable error state and must keep retrying,
 *  while the badge tier just shows "not screened" (browse is
 *  early-warning fail-open; the gates stay fail-closed). */
export function useBookTokenSecurity(
  legs: ScreenableLeg[],
): Record<string, TokenSecurityVerdict> {
  const queryClient = useQueryClient();
  const wanted = useMemo(() => {
    const seen = new Set<string>();
    const out: ScreenableLeg[] = [];
    for (const leg of legs) {
      if (!needsSecurityCheck(leg.chainId, leg.address)) continue;
      const key = legVerdictKey(leg.chainId, leg.address);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ chainId: leg.chainId, address: leg.address.toLowerCase() });
    }
    return out.sort((a, b) =>
      legVerdictKey(a.chainId, a.address).localeCompare(
        legVerdictKey(b.chainId, b.address),
      ),
    );
  }, [legs]);

  const q = useQuery({
    queryKey: [
      'tokenSecurityBook',
      wanted.map((l) => legVerdictKey(l.chainId, l.address)).join(','),
    ],
    enabled: wanted.length > 0,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1,
    queryFn: async () => {
      const out: Record<string, TokenSecurityVerdict> = {};
      const missingByChain = new Map<number, string[]>();
      for (const { chainId, address } of wanted) {
        const cached = queryClient.getQueryData<TokenSecurityVerdict>([
          'tokenSecurity',
          chainId,
          address,
        ]);
        if (cached) {
          out[legVerdictKey(chainId, address)] = cached;
        } else {
          missingByChain.set(chainId, [
            ...(missingByChain.get(chainId) ?? []),
            address,
          ]);
        }
      }
      for (const [chainId, addrs] of missingByChain) {
        const fetched = await fetchTokenSecurityBatch(chainId, addrs);
        for (const [address, v] of fetched) {
          out[legVerdictKey(chainId, address)] = v;
          if (v.kind !== 'unknown') {
            queryClient.setQueryData(['tokenSecurity', chainId, address], v);
          }
        }
      }
      return out;
    },
  });
  return q.data ?? EMPTY_VERDICTS;
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
