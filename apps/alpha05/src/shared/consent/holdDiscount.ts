import type { SupportedChain } from '../../chain/chains';
import { readVpfiToken } from '../claims/rewards';
import { useChainRead, type ChainRead } from '../reads/chainRead';

type Hex = `0x${string}`;

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Whether a holding discount can exist on a network at all.
 *
 * The platform token arrives with the rewards phase (owner decision
 * 2026-11-20), so at launch no network has it installed. While the
 * Diamond reports no token, no wallet holds a discount tier and every fee
 * is charged at its full rate, so a fee screen must say that instead of
 * offering a discount setting or a tier.
 *
 * - `none`: the network reports no platform token: full-rate fees.
 * - `installed`: a token is installed; the tier and setting apply.
 * - `unread`: the read failed; the screen must not claim either.
 * - `reading`: no answer yet.
 */
export type HoldDiscount = 'reading' | 'none' | 'installed' | 'unread';

/** The state from the token read, kept pure so it can be tested. */
export function holdDiscountFrom(read: Pick<ChainRead<Hex>, 'state' | 'data'>): HoldDiscount {
  if (read.data !== null) return read.data.toLowerCase() === ZERO ? 'none' : 'installed';
  return read.state === 'failed' ? 'unread' : 'reading';
}

/** The one read every fee screen shares (same cache key as the tier card). */
export function useHoldDiscount(chain: SupportedChain | null): HoldDiscount {
  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const read = useChainRead(['vpfiToken', diamond], (c) => readVpfiToken(c, diamond), {
    immutable: true,
    enabled: chain !== null,
    ...(chain ? { chain } : {}),
  });
  return chain === null ? 'reading' : holdDiscountFrom(read);
}
