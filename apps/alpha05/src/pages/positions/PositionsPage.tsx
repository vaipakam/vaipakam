import { useState } from 'react';
import { useAccount } from 'wagmi';
import { getSupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { ASSET_ERC20, positionKey } from '../../shared/positions/model';
import { EndedSection, LoansSection, PayoutsSection } from '../../shared/positions/PositionSections';
import { part, usePositionBook } from '../../shared/positions/usePositionBook';
import { useTokenMeta } from '../../shared/reads/tokens';
import { OwnStamp } from '../../shared/ui/OwnStamp';

type Hex = `0x${string}`;
type Side = 'all' | 'lent' | 'borrowed';

/**
 * Positions (rulebook §4: list with quick actions; LN-05, LN-08, LN-10,
 * LN-11). The loan positions the connected wallet holds on its chain, read
 * from the one inventory Home reads, in the order a reader needs them:
 * payouts confirmed ready to collect, then live loans (the most urgent
 * deadline first, the children of one offer grouped, each obligation's
 * stage with its pause credit, and the health factor), then ended loans
 * with their status. A side choice narrows all three to what the wallet
 * lent or borrowed. Every row opens its position, where the protocol's
 * verdict decides which actions are open (RB-ELIG); this page signs nothing.
 */
export function PositionsPage() {
  const { text, format } = useCopy();
  const { status, chainId } = useAccount();
  const connected = status === 'connected';
  const served = connected && getSupportedChain(chainId) !== null;
  const book = usePositionBook();
  const [side, setSide] = useState<Side>('all');
  const keep = (borrowerSide: boolean) => side === 'all' || (side === 'borrowed') === borrowerSide;

  const loans = part(book.loans, (d) => ({ ...d, rows: d.rows.filter((r) => keep(r.borrowerSide)) }));
  const payouts = part(book.payouts, (d) => ({
    ...d,
    rows: d.rows.filter((p) => keep(p.side === 'borrower')),
    unlisted: d.unlisted.filter((p) => keep(p.side === 'borrower')),
  }));
  const ended = part(book.ended, (d) => ({ ...d, rows: d.rows.filter((r) => keep(r.borrowerSide)) }));
  const payoutKeys = new Set((book.payouts.data?.rows ?? []).map((p) => positionKey({ loan: { id: p.loanId }, borrowerSide: p.side === 'borrower' })));

  const assets: Hex[] = [...(book.loans.data?.rows ?? []), ...(book.ended.data?.rows ?? [])].flatMap((r) =>
    r.loan.assetType === ASSET_ERC20 ? [r.loan.principalAsset, r.loan.collateralAsset] : [r.loan.principalAsset],
  );
  const meta = useTokenMeta(assets).data;

  // "None" is said only when every walk completed, its latest re-read
  // succeeded, and nothing was found: a stale answer is never called empty.
  const settled = book.read.error === null && book.loans.data?.complete === true && book.payouts.data?.complete === true;
  const nothing = (d: { loans: number; payouts: number; ended: number; unlisted: number }) => d.loans + d.payouts + d.ended + d.unlisted === 0;
  const counts = (filtered: boolean) => ({
    loans: (filtered ? loans : book.loans).data?.rows.length ?? 0,
    payouts: (filtered ? payouts : book.payouts).data?.rows.length ?? 0,
    ended: (filtered ? ended : book.ended).data?.rows.length ?? 0,
    unlisted: (filtered ? payouts : book.payouts).data?.unlisted.length ?? 0,
  });
  const emptyAll = settled && nothing(counts(false));
  const emptyFiltered = settled && !emptyAll && side !== 'all' && nothing(counts(true));

  return (
    <main className="page positions" aria-labelledby="positions-title">
      <h1 id="positions-title">{text('positions.title')}</h1>
      {!connected && <p className="tier-b">{text('positions.connectPrompt')}</p>}
      {connected && !served && <p className="tier-b">{text('positions.unsupportedChain')}</p>}
      {served && book.chain && (
        <>
          <OwnStamp reads={[book.read]} />
          {emptyAll ? (
            <p className="tier-b home-empty">{format('positions.empty', { chain: book.chain.name })}</p>
          ) : (
            <>
              <div className="segment positions-side" role="group" aria-label={text('positions.filterLabel')} data-testid="positions-side">
                {(['all', 'lent', 'borrowed'] as const).map((s) => (
                  <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)}>
                    {text(s === 'all' ? 'positions.filterAll' : s === 'lent' ? 'positions.filterLent' : 'positions.filterBorrowed')}
                  </button>
                ))}
              </div>
              {emptyFiltered && <p className="tier-b">{format('positions.emptyFiltered', { chain: book.chain.name })}</p>}
              <PayoutsSection read={payouts} />
              <LoansSection read={loans} meta={meta} unit={book.numeraire.data ?? text('home.exposureUnit')} />
              <EndedSection read={ended} meta={meta} payoutKeys={payoutKeys} />
            </>
          )}
        </>
      )}
    </main>
  );
}
