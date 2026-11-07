import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import { useChainRead, type ChainRead } from '../reads/chainRead';
import { readNumeraireSymbol } from '../reads/numeraire';
import type { OwnRead } from '../reads/useOwnRead';
import { useOwnRead } from '../reads/useOwnRead';
import { readPositionBook, type EndedLoans, type LiveLoans, type Payouts } from './reads';

type Hex = `0x${string}`;

export interface PositionBookRead {
  /** The served chain the wallet is on; null when no wallet is connected on
   *  one (the reads below are then idle). */
  chain: SupportedChain | null;
  /** The whole read, for its state, age and source. */
  read: OwnRead<unknown>;
  loans: OwnRead<LiveLoans>;
  payouts: OwnRead<Payouts>;
  ended: OwnRead<EndedLoans>;
  numeraire: ChainRead<string | null>;
  /** The diamond and account the read is for. */
  diamond: Hex;
  account: Hex;
}

/** One part of an own read, with the read's state, age and source. */
export function part<T, U>(read: OwnRead<T>, pick: (data: T) => U): OwnRead<U> {
  return { ...read, data: read.data === null ? null : pick(read.data) };
}

/** The loan positions the connected wallet holds on its chain (RW-70,
 *  LN-05), read once from the one inventory and shared by every surface
 *  that lists them (Home and Positions read the same cached answer):
 *  live loans, payouts ready to collect, and ended loans. */
export function usePositionBook(): PositionBookRead {
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId);
  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const account = (own?.account ?? '0x') as Hex;
  const enabled = chain !== null;
  const positions = useOwnRead(['positions', 'book'], (c) => readPositionBook(c, diamond, account), { enabled });
  const numeraire = useChainRead(['numeraireSymbol', diamond], (c) => readNumeraireSymbol(c, diamond), { enabled });
  return {
    chain,
    read: positions,
    loans: part(positions, (d) => d.loans),
    payouts: part(positions, (d) => d.payouts),
    ended: part(positions, (d) => d.ended),
    numeraire,
    diamond,
    account,
  };
}
