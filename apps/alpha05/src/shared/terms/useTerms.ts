import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { useOwnRead, type OwnRead } from '../reads/useOwnRead';
import { readTerms, type TermsState } from './terms';

/** The connected wallet's Terms state on its network (ACC-15), an own read:
 *  an acceptance in another tab is a re-read signal (RB-REFRESH). */
export function useTerms(): OwnRead<TermsState> {
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId);
  const diamond = (chain?.diamondAddress ?? '0x') as `0x${string}`;
  const account = (own?.account ?? '0x') as `0x${string}`;
  return useOwnRead(['terms', diamond], (c) => readTerms(c, diamond, account), { enabled: chain !== null });
}
