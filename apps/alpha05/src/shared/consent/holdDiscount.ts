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
 * Diamond reports no token, no wallet holds a discount tier, so no holding
 * discount applies to any fee and a fee screen must say that instead of
 * offering a discount setting or a tier. It must not say every fee is at
 * its full rate: other reductions, such as a referral's share, still apply
 * and are in the fee previews.
 *
 * - `none`: the network reports no platform token: no holding discount.
 * - `installed`: a token is installed; the tier and setting apply.
 * - `unread`: the read failed, or its last refresh did; the screen must not
 *   claim either.
 * - `reading`: no answer yet.
 */
export type HoldDiscount = 'reading' | 'none' | 'installed' | 'unread';

/** The state from the token read, kept pure so it can be tested. */
export function holdDiscountFrom(read: Pick<ChainRead<Hex>, 'state' | 'data' | 'error'>): HoldDiscount {
  // A refresh that failed leaves the last answer in place with an error. That
  // answer is no longer a confirmed current one (the token may have been
  // installed meanwhile), so it is stated unread, never as no discount.
  if (read.data !== null) return read.error !== null ? 'unread' : read.data.toLowerCase() === ZERO ? 'none' : 'installed';
  return read.state === 'failed' ? 'unread' : 'reading';
}

/** The platform token as every screen reads it: the read itself, the
 *  holding-discount state it supports, and the token's address while one is
 *  reported. One hook, one cache entry and one set of read options, so no
 *  screen can treat the same answer differently (a cached answer whose
 *  refresh failed is `unread` everywhere).
 *
 *  Installing the token is a configuration change the network can make
 *  while a page is open, so the read refreshes like any live read instead
 *  of being cached for good: a page left open across the installation
 *  stops stating that no holding discount applies once the token is there. */
export type PlatformToken = { read: ChainRead<Hex>; hold: HoldDiscount; token: Hex | null };

export function usePlatformToken(chain: SupportedChain | null): PlatformToken {
  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const read = useChainRead(['vpfiToken', diamond], (c) => readVpfiToken(c, diamond), {
    enabled: chain !== null,
    ...(chain ? { chain } : {}),
  });
  const token = read.data !== null && read.data.toLowerCase() !== ZERO ? read.data : null;
  return { read, hold: chain === null ? 'reading' : holdDiscountFrom(read), token };
}

/** The holding-discount state alone, for screens that need nothing else. */
export function useHoldDiscount(chain: SupportedChain | null): HoldDiscount {
  return usePlatformToken(chain).hold;
}
