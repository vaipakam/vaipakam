import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import { useChainRead, type ChainRead } from '../../shared/reads/chainRead';
import { useTokenMeta, type TokenMetaMap } from '../../shared/reads/tokens';
import { useOwnRead, type OwnRead } from '../../shared/reads/useOwnRead';
import { readNumeraireSymbol } from '../../shared/reads/numeraire';
import { readOpenOffers, readPositionBook, type LiveLoans, type OpenOffers, type Payouts } from './reads';
import { ASSET_ERC20 } from './model';

type Hex = `0x${string}`;

export interface HomeBook {
  /** The served chain the wallet is on; null when no wallet is connected on
   *  one (the reads below are then idle). */
  chain: SupportedChain | null;
  loans: OwnRead<LiveLoans>;
  payouts: OwnRead<Payouts>;
  offers: OwnRead<OpenOffers>;
  numeraire: ChainRead<string | null>;
  meta: TokenMetaMap | null;
  /** True only when every walk completed, its latest re-read succeeded,
   *  and nothing was found: a stale answer is never called empty. */
  empty: boolean;
}

/** One part of an own read, with the read's state, age and source. */
function part<T, U>(read: OwnRead<T>, pick: (data: T) => U): OwnRead<U> {
  return { ...read, data: read.data === null ? null : pick(read.data) };
}

/** The connected wallet's book on its chain (RW-70): the loan positions it
 *  holds (live loans and payouts come from that one inventory) and the offers
 *  it holds, as two own reads so a failure of one never hides the other, plus
 *  the token and numeraire metadata the rows are written with. */
export function useHomeBook(): HomeBook {
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId);
  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const account = (own?.account ?? '0x') as Hex;
  const enabled = chain !== null;

  const positions = useOwnRead(['home', 'positions'], (c) => readPositionBook(c, diamond, account), { enabled });
  const loans = part(positions, (d) => d.loans);
  const payouts = part(positions, (d) => d.payouts);
  const offers = useOwnRead(['home', 'offers'], (c) => readOpenOffers(c, diamond, account), { enabled });
  const numeraire = useChainRead(['numeraireSymbol', diamond], (c) => readNumeraireSymbol(c, diamond), { enabled });

  const assets: Hex[] = [
    ...(loans.data?.rows.flatMap((r) => [r.loan.principalAsset, r.loan.collateralAsset]) ?? []),
    ...(offers.data?.rows.flatMap((o) => (o.assetType === ASSET_ERC20 ? [o.lendingAsset] : [o.lendingAsset, o.prepayAsset])) ?? []),
  ];
  const meta = useTokenMeta(assets).data;

  const empty =
    positions.error === null &&
    offers.error === null &&
    loans.data?.complete === true &&
    payouts.data?.complete === true &&
    offers.data?.complete === true &&
    loans.data.rows.length === 0 &&
    payouts.data.rows.length === 0 &&
    offers.data.rows.length === 0 &&
    payouts.data.unlisted === 0;

  return { chain, loans, payouts, offers, numeraire, meta, empty };
}
