import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { pageHandoff, PAGES, currentAppHref } from '../../routes/pageMap';
import { readVpfiToken } from '../../shared/claims/rewards';
import { readPaused } from '../../shared/claims/sellerClaim';
import { useCopy } from '../../shared/copy/useCopy';
import type { CopyKey } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { usePositionBook } from '../../shared/positions/usePositionBook';
import { readOpenOffers } from '../../shared/positions/reads';
import { useChainRead } from '../../shared/reads/chainRead';
import { assetName, tokenAmount, useTokenMeta, type TokenMetaMap } from '../../shared/reads/tokens';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { FrozenNotice, useFrozenState } from '../../shared/sanctions/FrozenNotice';
import { OwnStamp } from '../../shared/ui/OwnStamp';
import { holdingFigures, positionAssets, readVaultHoldings, shownRows, type HoldingRow, type HoldingSource } from '../../shared/vault/holdings';
import { CreateVault, useCreateVaultHeld } from '../../shared/vault/CreateVault';
import { DEPOSIT_KEY, DepositVault, useDepositHeld } from '../../shared/vault/DepositVault';
import { TermsPrompt } from '../../shared/terms/TermsPrompt';
import { useTerms } from '../../shared/terms/useTerms';
import { useTermsGate } from '../../shared/terms/useTermsGate';
import { Notice } from '../../shared/ui/Notice';

type Hex = `0x${string}`;

const SOURCE: Record<HoldingSource, CopyKey> = { deposit: 'vault.sourceDeposit', loan: 'vault.sourceLoan', offer: 'vault.sourceOffer', intent: 'vault.sourceIntent' };

/**
 * Vault (ACC-20, ACC-21, ACC-24): the connected wallet's own vault on its
 * chain. Its address and what it is; with none yet, a way to create it. Each
 * asset the page can find, with the protocol's own figures: what the
 * protocol counts as the wallet's there, what may be withdrawn now, and what
 * the wallet's positions keep; an asset that reached the vault outside the
 * protocol is said to be uncounted, with the route to adopt it. Which assets
 * the page could not look for is said, never implied.
 *
 * Deposit and withdraw follow in the next slice; until then the page points
 * to the current app for them.
 */
export function VaultPage() {
  const copy = useCopy();
  const { text, format } = copy;
  const { status, chainId } = useAccount();
  const connected = status === 'connected';
  const served = connected && getSupportedChain(chainId) !== null;
  const own = useOwnStateClient();
  const book = usePositionBook();
  const chain = book.chain;
  const diamond = book.diamond;
  const account = book.account;
  const offers = useOwnRead(['home', 'offers'], (c) => readOpenOffers(c, diamond, account), { enabled: chain !== null });
  // The holdings read waits for the position sources to settle (an answer or
  // a failure), so a slow position read is never mistaken for none.
  const bookSettled = book.read.data !== null || book.read.state === 'failed';
  const offersSettled = offers.data !== null || offers.state === 'failed';
  const loans = [...(book.loans.data?.rows ?? []).map((r) => r.loan), ...(book.ended.data?.rows ?? []).map((r) => r.loan)];
  const offerRows = offers.data?.rows ?? [];
  const positionsComplete =
    book.loans.data !== null && book.ended.data !== null && offers.data !== null && book.loans.data.complete && book.ended.data.complete && offers.data.complete;
  const sources = positionAssets(loans, offerRows, positionsComplete);
  const sig = [
    ...sources.erc20.map((e) => `${e.asset}:${e.source}`),
    ...sources.nfts.map((n) => `${n.asset}:${n.tokenId}:${n.source}`),
    ...sources.loanIds.map((id) => `loan:${id}`),
    String(positionsComplete),
  ].join(',');
  const holdings = useOwnRead(['vault', 'holdings', diamond, sig], (c) => readVaultHoldings(c, diamond, account, sources), {
    enabled: chain !== null && bookSettled && offersSettled,
  });
  const vpfi = useChainRead(['vpfiToken', diamond], (c) => readVpfiToken(c, diamond), { enabled: chain !== null, immutable: true });
  const data = holdings.data;
  const meta = useTokenMeta(data ? [...data.rows.map((r) => r.asset), ...data.collections] : []).data;
  const frozen = useFrozenState(diamond, served && own ? own.account : null);
  const create = useCreateVaultHeld();
  const deposit = useDepositHeld();
  const paused = useOwnRead(['vault', 'paused', diamond], (c) => readPaused(c, diamond), { enabled: chain !== null, perBlock: true });
  const terms = useTerms();
  const termsGate = useTermsGate(`${DEPOSIT_KEY}.terms`, served ? chain : null, own);
  const termsOpen = termsGate.session !== null;
  // ACC-15: a deposit puts new value under the protocol, so an unaccepted
  // Terms version is accepted first; the form opens once that is recorded.
  // The Terms are this wallet's: a switch to a wallet that has not accepted
  // them, or a version published while the form is open, sends an open form
  // or review back through the gate (a transaction already under way is
  // left to finish, and the deposit's last check before signing reads the
  // Terms again either way).
  const termsDue = terms.data?.kind === 'needed';
  const openDeposit = () => {
    if (terms.data?.kind === 'needed') {
      termsGate.start(terms.data);
      return;
    }
    deposit.setOpen(true);
  };
  const [showAll, setShowAll] = useState(false);
  const positionsFailed = book.read.state === 'failed' || offers.state === 'failed';

  const decimals = (a: Hex) => meta?.[a.toLowerCase()]?.decimals ?? null;
  const shown = data ? shownRows(data.rows, decimals, showAll) : { rows: [], hidden: 0 };
  const vaultPage = PAGES.find((p) => p.path === '/vault');
  const currentVault = vaultPage ? currentAppHref(vaultPage, {}) : null;

  return (
    <main className="page vault" aria-labelledby="vault-title">
      <h1 id="vault-title">{text('vault.title')}</h1>
      {!connected && <p className="tier-b">{text('vault.connectPrompt')}</p>}
      {connected && !served && <p className="tier-b">{text('positions.unsupportedChain')}</p>}
      {served && chain && own && (
        <>
          <FrozenNotice state={frozen} />
          <OwnStamp reads={[holdings, book.read, offers]} />
          {data === null && holdings.state !== 'failed' && <p className="tier-b">{text('vault.reading')}</p>}
          {holdings.state === 'failed' && data === null && (
            <p className="tier-a" data-testid="vault-failed">
              {format('vault.failed', { reason: holdings.error ?? '' })}
            </p>
          )}
          {(create.held || (data !== null && data.vault === null)) && (
            <section className="home-section" aria-labelledby="vault-none" data-testid="vault-none">
              {data?.vault === null && (
                <>
                  <h2 id="vault-none">{text('vault.noneTitle')}</h2>
                  <p className="tier-b">{text('vault.noneBody')}</p>
                </>
              )}
              {create.held ? (
                <CreateVault chain={chain} own={own} onClose={() => create.setOpen(null)} />
              ) : frozen === 'flagged' ? (
                <p className="tier-a">{text('vault.createFlagged')}</p>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => create.setOpen(true)} data-testid="vault-create">
                  {text('vault.create')}
                </button>
              )}
            </section>
          )}
          <section className="home-section" aria-labelledby="vault-deposit" data-testid="vault-deposit">
            <h2 id="vault-deposit">{text('vaultDeposit.formTitle')}</h2>
            {terms.state === 'failed' && (
              <Notice tone="warn" tier="A">
                {format('consent.termsUnknown', { chain: chain.name, reason: terms.error ?? 'no answer' })}{' '}
                <button type="button" className="btn" onClick={terms.refetch}>
                  {text('consent.retry')}
                </button>
              </Notice>
            )}
            {termsOpen && termsGate.session ? (
              <TermsPrompt
                asker={text('vaultDeposit.asker')}
                gate={termsGate}
                session={termsGate.session}
                chain={chain}
                own={own}
                onAccepted={() => {
                  termsGate.end();
                  deposit.setOpen(true);
                }}
                onClose={() => termsGate.end()}
              />
            ) : deposit.held && termsDue && !deposit.inFlight ? (
              <div data-testid="vault-deposit-terms-due">
                <Notice tone="warn" tier="A">
                  {text('vaultDeposit.termsDue')}
                </Notice>
                <div className="form-actions">
                  <button type="button" className="btn btn-primary" onClick={openDeposit} data-testid="vault-deposit-terms-accept">
                    {text('vaultDeposit.termsAccept')}
                  </button>
                  <button type="button" className="btn" onClick={() => deposit.setOpen(null)}>
                    {text('flow.cancel')}
                  </button>
                </div>
              </div>
            ) : deposit.held ? (
              <DepositVault chain={chain} own={own} onClose={() => deposit.setOpen(null)} onTermsDue={terms.refetch} />
            ) : paused.data === true ? (
              <p className="tier-a" data-testid="vault-deposit-paused">
                {text('vaultDeposit.paused')}
              </p>
            ) : frozen === 'flagged' ? (
              <p className="tier-a">{text('vaultDeposit.flagged')}</p>
            ) : (
              <>
                <p className="tier-b">{text('vaultDeposit.lead')}</p>
                <button type="button" className="btn btn-primary" onClick={openDeposit} disabled={terms.state !== 'ready'} data-testid="vault-deposit-open">
                  {text('vaultDeposit.open')}
                </button>
              </>
            )}
          </section>
          {data !== null && data.vault !== null && (
            <>
              <section className="home-section" aria-labelledby="vault-address">
                <h2 id="vault-address">{text('vault.address')}</h2>
                <p className="vault-address">
                  <code data-testid="vault-address-value">{data.vault}</code>
                </p>
                <p>
                  <a href={`${chain.blockExplorer}/address/${data.vault}`} target="_blank" rel="noreferrer">
                    {text('vault.explorer')}
                  </a>
                </p>
                <p className="tier-a">{text('vault.ownNote')}</p>
              </section>
              <section className="home-section" aria-labelledby="vault-holdings">
                <h2 id="vault-holdings">{text('vault.holdingsTitle')}</h2>
                {positionsFailed && <p className="tier-a">{format('vault.positionsFailed', { reason: book.read.error ?? offers.error ?? '' })}</p>}
                {!positionsFailed && !data.positionsComplete && <p className="tier-a">{text('vault.positionsIncomplete')}</p>}
                {!data.listComplete && <p className="tier-a">{text('vault.listIncomplete')}</p>}
                {shown.rows.length === 0 && shown.hidden === 0 && (
                  <p className="tier-b home-empty" data-testid="vault-empty">
                    {text('vault.empty')}
                  </p>
                )}
                {shown.rows.length > 0 && (
                  <ul className="rows" data-testid="vault-rows">
                    {shown.rows.map((r) => (
                      <HoldingCard key={`${r.standard}:${r.asset}:${r.tokenId}`} row={r} meta={meta} vpfi={vpfi.data ?? null} />
                    ))}
                  </ul>
                )}
                {shown.hidden > 0 || showAll ? (
                  <button type="button" className="btn" onClick={() => setShowAll((v) => !v)} data-testid="vault-toggle-hidden">
                    {showAll ? text('vault.hideHidden') : format('vault.showHidden', { count: String(shown.hidden) })}
                  </button>
                ) : null}
                {data.collections.length > 0 && (
                  <p className="tier-a" data-testid="vault-collections">
                    {format('vault.collections', { list: data.collections.map((c) => assetName(c, meta)).join(', ') })}
                  </p>
                )}
                <p className="tier-b">{text('vault.discoveryNote')}</p>
                <WhyLink summaryKey="vault.whySummary" detailKey="vault.why" />
              </section>
            </>
          )}
          {currentVault !== null && (
            <p className="tier-b" data-testid="vault-next">
              {text('vault.nextSlices')}{' '}
              <a href={currentVault} target="_blank" rel="noreferrer">
                {text('vault.openCurrent')}
              </a>
            </p>
          )}
        </>
      )}
    </main>
  );
}

/** One asset: the protocol's figures for it, how the page found it, and
 *  what is uncounted or short, each said in words. */
function HoldingCard({ row: r, meta, vpfi }: { row: HoldingRow; meta: TokenMetaMap | null; vpfi: Hex | null }) {
  const { text, format } = useCopy();
  const f = holdingFigures(r);
  const nft = r.standard !== 'erc20';
  const amount = (v: bigint) => (nft ? v.toString() : tokenAmount(v, r.asset, meta, format));
  const figure = (v: bigint | null): ReactNode => (v === null ? <span className="tier-a">{text('vault.unreadFigure')}</span> : amount(v));
  const name = nft ? format('asset.nftToken', { asset: assetName(r.asset, meta), id: r.tokenId.toString() }) : assetName(r.asset, meta);
  const isVpfi = vpfi !== null && !nft && r.asset.toLowerCase() === vpfi.toLowerCase();
  const rewards = pageHandoff('/rewards');
  const recover = pageHandoff('/recover');
  const key = `${r.standard}:${r.asset.toLowerCase()}:${r.tokenId.toString()}`;
  return (
    <li className="card" data-vault-row={key}>
      <p className="row-head">{name}</p>
      <p className="vault-asset-address">
        <code>{r.asset}</code>
      </p>
      <dl className="facts">
        <dt className="tier-b">{text('vault.colCounted')}</dt>
        <dd data-testid={`vault-counted-${key}`}>{figure(f.counted)}</dd>
        <dt className="tier-b">{text('vault.colWithdrawable')}</dt>
        <dd data-testid={`vault-withdrawable-${key}`}>{figure(f.withdrawable)}</dd>
        <dt className="tier-b">{text('vault.colHeld')}</dt>
        <dd data-testid={`vault-held-${key}`}>{figure(f.held)}</dd>
      </dl>
      {f.unread && <p className="tier-a">{text('vault.rowUnread')}</p>}
      {f.allHeld && <p className="tier-b">{text('vault.allHeld')}</p>}
      {f.short && r.inVault !== null && r.tracked !== null && (
        <p className="tier-a" data-testid={`vault-short-${key}`}>
          {format('vault.short', { held: amount(r.inVault), tracked: amount(r.tracked) })}
        </p>
      )}
      {f.untracked !== null && f.untracked > 0n && (
        <p className="tier-a" data-testid={`vault-untracked-${key}`}>
          {format('vault.untracked', { amount: amount(f.untracked) })} <HandoffLink to={recover} label={text('vault.adopt')} />
        </p>
      )}
      {isVpfi && (
        <p className="tier-b" data-testid="vault-vpfi-note">
          {text('vault.vpfiNote')} <HandoffLink to={rewards} label={text('vault.vpfiLink')} />
        </p>
      )}
      <p className="tier-b">{format('vault.sources', { list: r.sources.map((s) => text(SOURCE[s])).join(', ') })}</p>
    </li>
  );
}

/** A link to where a job lives: this app's page when built, otherwise the
 *  current app's (nothing when neither has one). */
function HandoffLink({ to, label }: { to: ReturnType<typeof pageHandoff>; label: string }) {
  if (to.kind === 'here') return <Link to={to.to}>{label}</Link>;
  if (to.kind === 'currentApp')
    return (
      <a href={to.href} target="_blank" rel="noreferrer">
        {label}
      </a>
    );
  return null;
}
