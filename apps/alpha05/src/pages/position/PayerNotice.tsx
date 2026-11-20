import { useQuery } from '@tanstack/react-query';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { positionMoved, readLoanOpener } from '../../shared/loans/opener';
import { worldKey } from '../../shared/reads/identityKey';
import { useWorldRail } from '../../shared/reads/world/WorldRailContext';
import { Notice } from '../../shared/ui/Notice';

type Hex = `0x${string}`;

/** Who opened the loan, from the index; `null` while unread or on failure. */
export function useLoanOpener(chain: SupportedChain, loanId: bigint, enabled: boolean): Hex | null {
  const world = useWorldRail();
  const q = useQuery({
    queryKey: worldKey(chain.chainId, 'loanOpener', loanId.toString()),
    queryFn: () => readLoanOpener(world.indexer, chain.chainId, loanId),
    enabled: enabled && world.indexer.origin !== null,
    retry: 1,
  });
  return q.data ?? null;
}

/** Whether a payer who holds neither side must confirm before repaying:
 *  whenever the position is not known to sit with the address that opened
 *  the loan (moved, or either side unknown). */
export function payerMustConfirm(opener: Hex | null, holder: Hex | null): boolean {
  return positionMoved(opener, holder) !== false;
}

/**
 * #3769 (FeaturesOverExistingPartsDesign §2) — what a reader who holds
 * neither side of a running ERC-20 loan is told above the repayment. Every
 * statement of who benefits names the CURRENT holder of the borrower
 * position, read from the chain; the opener appears only as history. The
 * page never tells the payer to send funds to an address: it offers only the
 * platform's repayment, and before #3779 part payment is the holder's alone.
 */
export function PayerNotice({
  holder,
  opener,
  allowsPartialRepay,
  confirmed,
  onConfirm,
}: {
  holder: Hex | null;
  opener: Hex | null;
  allowsPartialRepay: boolean;
  confirmed: boolean;
  onConfirm: (yes: boolean) => void;
}) {
  const { text, format } = useCopy();
  if (holder === null) {
    return (
      <div data-testid="payer-notice">
        <Notice tone="warn" tier="A">
          {text('payer.holderUnread')}
        </Notice>
      </div>
    );
  }
  const moved = positionMoved(opener, holder);
  return (
    <div data-testid="payer-notice" data-moved={moved === null ? 'unknown' : String(moved)}>
      {moved === false ? (
        <p className="tier-b" data-testid="payer-holder">
          {format('payer.holderNow', { holder })}
        </p>
      ) : (
        <Notice tone="warn" tier="A">
          <span data-testid="payer-moved">{moved ? format('payer.moved', { holder, opener: opener! }) : format('payer.openerUnread', { holder })}</span>
        </Notice>
      )}
      <p className="tier-a" data-testid="payer-returns-to">
        {format('payer.returnsTo', { holder })}
      </p>
      <p className="tier-a" data-testid="payer-part">
        {allowsPartialRepay ? format('payer.partOnlyHolder', { holder }) : text('payer.partNever')}
      </p>
      <p className="tier-a">{text('payer.noRight')}</p>
      {moved !== false && (
        <label className="choice" data-testid="payer-confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} />
          <span>{format('payer.confirm', { holder })}</span>
        </label>
      )}
    </div>
  );
}
