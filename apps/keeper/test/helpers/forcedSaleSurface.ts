// The loupe answer a test Diamond gives for the forced-sale surface
// (`readForcedSaleSurface`, @vaipakam/lib/routeBuilder).

import { zeroAddress, type Address, type Hex } from 'viem';
import { FORCED_SALE_SURFACE_SELECTORS, type ForcedSaleSurface } from '@vaipakam/lib/routeBuilder';

const HOST: Address = '0x00000000000000000000000000000000000005a1';

/** The facet a Diamond on `surface` routes `selector` to, or `undefined`
 *  when the selector is not the one the surface read asks about. */
export function surfaceFacet(selector: Hex, surface: ForcedSaleSurface = 'sized'): Address | undefined {
  if (selector.toLowerCase() !== FORCED_SALE_SURFACE_SELECTORS.sized.plan) return undefined;
  return surface === 'sized' ? HOST : zeroAddress;
}
