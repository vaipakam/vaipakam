// The loupe answers a test Diamond gives for the forced-sale surface
// (`readForcedSaleSurface`, @vaipakam/lib/routeBuilder).

import { zeroAddress, type Address, type Hex } from 'viem';
import { FORCED_SALE_SURFACE_SELECTORS, type ForcedSaleSurface } from '@vaipakam/lib/routeBuilder';

const HOST: Address = '0x00000000000000000000000000000000000005a1';

/** The facet a Diamond on `surface` routes `selector` to, or `undefined`
 *  when the selector is not one the surface read asks about. */
export function surfaceFacet(selector: Hex, surface: ForcedSaleSurface | 'mixed' = 'sized'): Address | undefined {
  const sized = Object.values(FORCED_SALE_SURFACE_SELECTORS.sized) as Hex[];
  const whole = Object.values(FORCED_SALE_SURFACE_SELECTORS.whole) as Hex[];
  const s = selector.toLowerCase();
  if (sized.includes(s as Hex)) {
    if (surface === 'mixed') return s === FORCED_SALE_SURFACE_SELECTORS.sized.plan ? zeroAddress : HOST;
    return surface === 'sized' ? HOST : zeroAddress;
  }
  if (whole.includes(s as Hex)) return surface === 'sized' ? zeroAddress : HOST;
  return undefined;
}
