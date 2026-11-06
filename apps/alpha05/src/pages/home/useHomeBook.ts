import type { SupportedChain } from '../../chain/chains';
import type { ChainRead } from '../../shared/reads/chainRead';
import { useTokenMeta, type TokenMetaMap } from '../../shared/reads/tokens';
import { useOwnRead, type OwnRead } from '../../shared/reads/useOwnRead';
import { readOpenOffers, type LiveLoans, type OpenOffers, type Payouts } from '../../shared/positions/reads';
import { ASSET_ERC20 } from '../../shared/positions/model';
import { usePositionBook } from '../../shared/positions/usePositionBook';

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

/** The connected wallet's book on its chain (RW-70): the loan positions it
 *  holds (live loans and payouts come from that one inventory) and the offers
 *  it holds, as two own reads so a failure of one never hides the other, plus
 *  the token and numeraire metadata the rows are written with. */
export function useHomeBook(): HomeBook {
  const { chain, read: positions, loans, payouts, numeraire, diamond, account } = usePositionBook();
  const offers = useOwnRead(['home', 'offers'], (c) => readOpenOffers(c, diamond, account), { enabled: chain !== null });

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
    payouts.data.unlisted.length === 0;

  return { chain, loans, payouts, offers, numeraire, meta, empty };
}
