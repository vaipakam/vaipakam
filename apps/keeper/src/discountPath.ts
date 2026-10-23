// apps/keeper/src/discountPath.ts
//
// #2633 — which chains the operator has armed the flash-loan discount path
// on.
//
// The path is the keeper's `tryFlashLoanDiscountedPath` branch: a discounted
// liquidation funded by a flash loan through the chain's FlashLoanLiquidator.
// It runs on a chain only when that chain has a liquidator deployed AND the
// operator has named the chain here. Arming is the operator's affirmative
// step, taken once the Diamond's own discount-path switch is on.
//
// The variable is one plain knob, `DISCOUNT_PATH_CHAIN_IDS`: a comma list of
// decimal chain ids. Unset or empty arms no chain. It replaces a
// per-chain `DISCOUNT_PATH_ENABLED_<chainId>` lookup that never worked: that
// name was not a field of the resolved env, so the lookup read undefined on
// every host and the documented lever did nothing. One named setting is
// carried by `resolveEnv` and checked against the machine's env template like
// every other.
//
// A value that cannot be read arms no chain and says why. The path moves
// funds, so an unknown never arms it.
//
// The machine runtime states the whole posture once at start-up and in
// `--check` (`discountPathPosture`), so the journal answers "is it armed,
// and where" from the same parser the passes use, whether or not a loan has
// reached the branch since.

import { flashLoanRoute } from './flashLoanProviders';

export const DISCOUNT_PATH_VAR = 'DISCOUNT_PATH_CHAIN_IDS';

/** The armed chains, or why the setting could not be read. */
export type DiscountPathChains =
  | { chains: ReadonlySet<number> }
  | { unread: string };

const CHAIN_ID = /^[1-9]\d*$/;

/** The chains `raw` (the variable's value) arms. */
export function discountPathChains(raw: string | undefined): DiscountPathChains {
  const text = (raw ?? '').trim();
  const chains = new Set<number>();
  if (text === '') return { chains };
  const parts = text.split(',');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i].trim();
    // The entry is described by position, never echoed: the setting sits
    // among the keeper's secrets in its env file, and a paste error is how a
    // credential ends up on the wrong line.
    if (!CHAIN_ID.test(entry) || !Number.isSafeInteger(Number(entry))) {
      return { unread: `${DISCOUNT_PATH_VAR} entry ${i + 1} of ${parts.length} is not a chain id` };
    }
    const id = Number(entry);
    if (chains.has(id)) return { unread: `${DISCOUNT_PATH_VAR} names chain ${id} twice` };
    chains.add(id);
  }
  return { chains };
}

/** Why the discount path is not armed on `chainId`, or null when it is. */
export function discountPathBlocker(raw: string | undefined, chainId: number): string | null {
  const read = discountPathChains(raw);
  if ('unread' in read) return `${read.unread}, so no chain is armed`;
  if (!read.chains.has(chainId)) {
    return read.chains.size === 0
      ? `${DISCOUNT_PATH_VAR} is unset, so no chain is armed`
      : `${DISCOUNT_PATH_VAR} does not name chain ${chainId}`;
  }
  return null;
}

/**
 * The whole posture, for the start-up line: which chains are armed, and for
 * each one whether this build can run the branch there at all — the same
 * `flashLoanRoute` the branch resolves (a liquidator and a provider), since
 * without one the branch stays off on that chain whatever the setting says.
 */
export function discountPathPosture(raw: string | undefined): string {
  const read = discountPathChains(raw);
  if ('unread' in read) return `${read.unread}, so no chain is armed`;
  if (read.chains.size === 0) return `${DISCOUNT_PATH_VAR} is unset, so no chain is armed`;
  const chains = [...read.chains]
    .sort((a, b) => a - b)
    .map((id) => {
      const resolved = flashLoanRoute(id);
      return 'missing' in resolved
        ? `${id} (${resolved.missing}, so the path stays off there)`
        : `${id} (via ${resolved.route.via})`;
    });
  return `${DISCOUNT_PATH_VAR} arms chain${chains.length === 1 ? '' : 's'} ${chains.join(', ')}`;
}
