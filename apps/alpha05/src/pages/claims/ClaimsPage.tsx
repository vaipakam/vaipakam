import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { useOwnStateClient, type OwnStateClient } from '../../chain/ownRail';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import { LoanClaim, useLoanClaimHeld } from '../../shared/claims/LoanClaim';
import { readLoanClaimRows, type LoanClaimRow } from '../../shared/claims/loanClaimRows';
import { laneLabel } from '../../shared/claims/loanClaimReceipt';
import { RewardsWidget } from '../../shared/claims/RewardsWidget';
import { ASSET_ERC20 } from '../../shared/claims/loanClaim';
import { useCopy } from '../../shared/copy/useCopy';
import { claimVerdict } from '../../shared/eligibility/claim';
import { WhyLink } from '../../shared/help/WhyLink';
import { assetAmount } from '../../shared/positions/assetAmount';
import { usePositionBook } from '../../shared/positions/usePositionBook';
import { useTokenMeta, type TokenMetaMap } from '../../shared/reads/tokens';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { OwnStamp } from '../../shared/ui/OwnStamp';
import { useNow } from '../../shared/ui/useNow';

type Hex = `0x${string}`;

/**
 * Claims (RB-CLAIM; LN-48, LN-49, LN-50, RW-71): the canonical list of what
 * the connected wallet can collect on its chain, each through the same flow
 * the loan page and Home open. Loan payouts come first, found by the position
 * the wallet holds (a bought position pays its new holder), each row read
 * from the chain as its claim reads it, with every payout named and the
 * claim's rule deciding whether it is offered (RB-ELIG). Rewards follow, the
 * same section Home shows.
 *
 * "Nothing to collect" is said only when every walk completed and its latest
 * read succeeded; a row whose claim could not be read stays, said so. Seller
 * interest, frozen proceeds, queued payouts, extension reserves and "Claim
 * everything" come in later slices (#3191); until then the page names them
 * and links the current app, so a payout it cannot collect is never implied
 * absent.
 */
export function ClaimsPage() {
  const { text, format } = useCopy();
  const { status, chainId } = useAccount();
  const connected = status === 'connected';
  const served = connected && getSupportedChain(chainId) !== null;
  const own = useOwnStateClient();
  const book = usePositionBook();
  const payouts = book.payouts.data;
  const ids = payouts ? [...payouts.rows, ...payouts.unlisted].map((p) => `${p.side}:${p.loanId}`).join(',') : '';
  const claims = useOwnRead(['claims', 'loans', book.diamond, ids], (c) => readLoanClaimRows(c, book.diamond, payouts!), { enabled: book.chain !== null && payouts !== null });
  const rows = claims.data?.rows ?? [];
  // A collected payout leaves the list on the next read (its position token
  // is burnt), but its finish card must stay until the reader closes it, so
  // every row shown once is remembered and kept while its flow is held.
  // Remembered per Diamond and wallet, so a switch starts afresh.
  const scope = `${book.diamond}:${own?.account ?? ''}`;
  const [seen, setSeen] = useState<{ scope: string; from: unknown; rows: ReadonlyMap<string, LoanClaimRow> }>({ scope, from: null, rows: new Map() });
  if (claims.data !== seen.from || scope !== seen.scope) {
    const next = new Map(scope === seen.scope ? seen.rows : []);
    for (const r of rows) next.set(`${r.side}:${r.loanId}`, r);
    setSeen({ scope, from: claims.data, rows: next });
  }
  const live = new Set(rows.map((r) => `${r.side}:${r.loanId}`));
  const gone = [...seen.rows.entries()].filter(([k]) => !live.has(k)).map(([, r]) => r);
  const assets: Hex[] = rows.flatMap((r) => [...r.lanes.map((l) => l.asset), ...(r.loan ? [r.loan.principalAsset, r.loan.collateralAsset] : [])]);
  const meta = useTokenMeta(assets).data;
  const settled = book.read.error === null && claims.error === null && claims.data !== null && claims.data.complete;

  return (
    <main className="page claims" aria-labelledby="claims-title">
      <h1 id="claims-title">{text('claims.title')}</h1>
      {!connected && <p className="tier-b">{text('claims.connectPrompt')}</p>}
      {connected && !served && <p className="tier-b">{text('positions.unsupportedChain')}</p>}
      {served && book.chain && own && (
        <>
          <section className="home-section" aria-labelledby="claims-loans">
            <h2 id="claims-loans">{text('claims.loansTitle')}</h2>
            <OwnStamp reads={[book.read, claims]} />
            {claims.data === null && claims.state !== 'failed' && book.read.state !== 'failed' && <p className="tier-b">{text('claims.reading')}</p>}
            {(claims.state === 'failed' || book.read.state === 'failed') && claims.data === null && (
              <p className="tier-a" data-testid="claims-failed">
                {format('claims.failed', { reason: claims.error ?? book.read.error ?? '' })}
              </p>
            )}
            {claims.data !== null && rows.length === 0 && settled && gone.length === 0 && (
              <p className="tier-b home-empty" data-testid="claims-empty">
                {format('claims.empty', { chain: book.chain.name })}
              </p>
            )}
            {rows.length + gone.length > 0 && (
              <ul className="rows" data-testid="claims-loan-rows">
                {rows.map((r) => (
                  <ClaimCard key={`${r.side}:${r.loanId}`} row={r} paused={claims.data?.paused ?? null} own={own} chain={book.chain!} meta={meta} />
                ))}
                {gone.map((r) => (
                  <ClaimCard key={`${r.side}:${r.loanId}`} row={r} paused={claims.data?.paused ?? null} own={own} chain={book.chain!} meta={meta} gone />
                ))}
              </ul>
            )}
            {claims.data !== null && !claims.data.complete && <p className="tier-b">{text('claims.incomplete')}</p>}
            <WhyLink summaryKey="claims.howSummary" detailKey="loanClaim.why" />
            <p className="tier-a" data-testid="claims-not-yet">
              {text('claims.notYet')}{' '}
              <a href="https://app.vaipakam.com/claims" target="_blank" rel="noreferrer">
                {text('claims.notYetLink')}
              </a>
            </p>
          </section>
          <RewardsWidget />
        </>
      )}
    </main>
  );
}

/** One loan payout: what it pays, and its claim, offered by its rule. A row
 *  the latest read no longer lists (`gone`) is drawn only while its claim
 *  flow is held, so a finish card outlives the payout it collected. */
function ClaimCard({
  row: r,
  paused,
  own,
  chain,
  meta,
  gone = false,
}: {
  row: LoanClaimRow;
  paused: boolean | null;
  own: OwnStateClient;
  chain: SupportedChain;
  meta: TokenMetaMap | null;
  gone?: boolean;
}) {
  const copy = useCopy();
  const { text, format } = copy;
  const nowMs = useNow();
  const flow = useLoanClaimHeld(r.loanId, r.side);
  const verdict = r.loan
    ? claimVerdict({ side: r.side, status: Number(r.loan.status), loanAssetType: Number(r.loan.assetType), paused, holder: r.holder, claim: r.claim }, own.account, copy, nowMs)
    : null;
  const payouts = r.lanes.map((l) => ({
    label: laneLabel(l.kind, r.side, copy),
    value:
      l.assetType === ASSET_ERC20
        ? assetAmount({ asset: l.asset, assetType: l.assetType, amount: l.amount, tokenId: 0n, quantity: 0n }, meta, format)
        : assetAmount({ asset: l.asset, assetType: l.assetType, amount: 0n, tokenId: l.tokenId, quantity: l.amount }, meta, format),
  }));
  if (gone && !flow.held) return null;
  return (
    <li className="card" data-claim={`${r.side}:${r.loanId}`}>
      <p className="row-head">
        <Link to={`/positions/${r.loanId.toString()}`}>
          {format('positions.payoutRow', { id: r.loanId.toString(), side: text(r.side === 'lender' ? 'positions.sideLender' : 'positions.sideBorrower') })}
        </Link>
      </p>
      {r.claim === null ? (
        <p className="tier-a">{text('claims.rowUnread')}</p>
      ) : payouts.length === 0 ? (
        <p className="tier-b">{text('loanClaim.zeroClaim')}</p>
      ) : (
        <dl className="facts">
          {payouts.map((p) => (
            <Fragment key={p.label}>
              <dt className="tier-b">{p.label}</dt>
              <dd>{p.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {flow.held ? (
        <LoanClaim loanId={r.loanId} side={r.side} chain={chain} own={own} meta={meta} onClose={() => flow.setOpen(null)} />
      ) : verdict?.state === 'open' ? (
        <button type="button" className="btn btn-primary" onClick={() => flow.setOpen(true)} data-testid={`claims-open-${r.side}-${r.loanId}`}>
          {text('claims.collect')}
        </button>
      ) : verdict ? (
        <p className={verdict.state === 'unknown' ? 'tier-a' : 'tier-b'} data-code={verdict.refusals[0]?.code}>
          {verdict.state === 'unknown' ? text('loanClaim.unknown') : verdict.refusals[0]?.reason}
        </p>
      ) : null}
    </li>
  );
}
