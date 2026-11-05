import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import { useChainRead, type ChainRead } from '../../shared/reads/chainRead';
import { useTokenMeta, type TokenMetaMap } from '../../shared/reads/tokens';
import { useOwnRead, type OwnRead } from '../../shared/reads/useOwnRead';
import { readLiveLoans, readNumeraireSymbol, readOpenOffers, readPayouts, type LiveLoans, type OpenOffers, type Payouts } from './reads';

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
  /** True only when all three walks completed and found nothing. */
  empty: boolean;
}

/** The connected wallet's book on its chain (RW-70): three own reads, so a
 *  section that fails never hides the others, plus the token and numeraire
 *  metadata the rows are written with. */
export function useHomeBook(): HomeBook {
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId);
  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const account = (own?.account ?? '0x') as Hex;
  const enabled = chain !== null;

  const loans = useOwnRead(['home', 'loans'], (c) => readLiveLoans(c, diamond, account), { enabled });
  const payouts = useOwnRead(['home', 'payouts'], (c) => readPayouts(c, diamond, account), { enabled });
  const offers = useOwnRead(['home', 'offers'], (c) => readOpenOffers(c, diamond, account), { enabled });
  const numeraire = useChainRead(['numeraireSymbol', diamond], (c) => readNumeraireSymbol(c, diamond), { enabled });

  const assets: Hex[] = [
    ...(loans.data?.rows.flatMap((r) => [r.loan.principalAsset, r.loan.collateralAsset]) ?? []),
    ...(offers.data?.rows.map((o) => o.lendingAsset) ?? []),
  ];
  const meta = useTokenMeta(assets).data;

  const empty =
    loans.data?.complete === true &&
    payouts.data?.complete === true &&
    offers.data?.complete === true &&
    loans.data.rows.length === 0 &&
    payouts.data.rows.length === 0 &&
    offers.data.rows.length === 0;

  return { chain, loans, payouts, offers, numeraire, meta, empty };
}
