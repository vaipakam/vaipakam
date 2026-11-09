import { Link } from 'react-router-dom';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { readVpfiToken } from '../claims/rewards';
import { readPaused } from '../claims/sellerClaim';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { useChainRead } from '../reads/chainRead';
import { tokenAmount, useTokenMeta } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { useFrozenState } from '../sanctions/FrozenNotice';
import { TermsPrompt } from '../terms/TermsPrompt';
import { useTerms } from '../terms/useTerms';
import { useTermsGate } from '../terms/useTermsGate';
import { Notice } from '../ui/Notice';
import { OwnStamp } from '../ui/OwnStamp';
import { DepositVault, useDepositHeld } from '../vault/DepositVault';
import { useWithdrawHeld, WithdrawVault } from '../vault/WithdrawVault';
import { readVpfiBalances, vpfiFigures, withdrawClosed } from './vpfiBalances';

const ZERO = '0x0000000000000000000000000000000000000000';

/** The store keys the Rewards page's VPFI deposit and withdrawal keep their
 *  state under, apart from the Vault page's. */
export const VPFI_DEPOSIT_KEY = 'rewards.vpfiDeposit';
export const VPFI_WITHDRAW_KEY = 'rewards.vpfiWithdraw';

/**
 * RW-01, RW-02, RW-04, RW-05, RW-06 — VPFI in the wallet's own vault, on the
 * Rewards page. Availability first: on a network with no VPFI token set,
 * the panel says so and offers no deposit or withdrawal. Otherwise the
 * wallet's VPFI, read at one block: in the wallet, counted in the vault
 * (what the tier reads), free to withdraw, held (counted but not free), and
 * what sits in the vault uncounted (sent there directly, which never raises
 * the tier, with the way to adopt it). VPFI in the vault is not collateral.
 * Deposit VPFI and Withdraw VPFI open the vault's own deposit and
 * withdrawal for this one token (ACC-22 / ACC-23), whose receipts add the
 * tier's side (`vpfiNotes`); a deposit is behind the Terms gate, as every
 * deposit is, and a withdrawal never is. Nothing here buys, sells, stakes
 * or prices VPFI (RL-6).
 */
export function VpfiVault({ chain, own }: { chain: SupportedChain; own: OwnStateClient }) {
  const { text, format } = useCopy();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const tokenRead = useChainRead(['vpfiToken', diamond], (c) => readVpfiToken(c, diamond), { immutable: true });
  const token = tokenRead.data && tokenRead.data.toLowerCase() !== ZERO ? tokenRead.data : null;
  const balances = useOwnRead(['rewards', 'vpfiBalances', diamond, token], (c) => readVpfiBalances(c, diamond, account, token!), {
    enabled: token !== null,
    perBlock: true,
  });
  const meta = useTokenMeta(token ? [token] : []).data ?? null;
  const paused = useOwnRead(['rewards', 'paused', diamond], (c) => readPaused(c, diamond), { perBlock: true });
  const frozen = useFrozenState(diamond, account);
  const deposit = useDepositHeld(VPFI_DEPOSIT_KEY);
  const withdraw = useWithdrawHeld(VPFI_WITHDRAW_KEY);
  const terms = useTerms();
  const termsGate = useTermsGate(`${VPFI_DEPOSIT_KEY}.terms`, chain, own);

  const head = (
    <>
      <h2 id="rewards-vpfi-title">{text('rewardsVault.title')}</h2>
      <WhyLink summaryKey="rewardsVault.lead" detailKey="rewardsVault.why" />
    </>
  );
  if (tokenRead.data === null && tokenRead.state !== 'failed')
    return (
      <section className="home-section" aria-labelledby="rewards-vpfi-title" data-testid="rewards-vpfi">
        {head}
        <p className="tier-b">{text('rewardsVault.reading')}</p>
      </section>
    );
  if (token === null)
    return (
      <section className="home-section" aria-labelledby="rewards-vpfi-title" data-testid="rewards-vpfi" data-vpfi="unavailable">
        {head}
        <p className="tier-a" data-testid="rewards-vpfi-unavailable">
          {tokenRead.data ? text('rewardsVault.unset') : format('rewardsVault.tokenFailed', { reason: tokenRead.error ?? 'no answer' })}
        </p>
      </section>
    );

  const amount = (v: bigint | null) => (v === null ? text('rewardsVault.unread') : tokenAmount(v, token, meta, format));
  const b = balances.data;
  const fig = b ? vpfiFigures(b) : null;
  const closed = b ? withdrawClosed(b) : null;
  const termsDue = terms.data?.kind === 'needed';
  const openDeposit = () => {
    if (terms.data?.kind === 'needed') {
      termsGate.start(terms.data);
      return;
    }
    withdraw.open(null);
    deposit.setOpen(true);
  };
  const openWithdraw = () => {
    deposit.setOpen(null);
    withdraw.open({ standard: 'erc20', asset: token, tokenId: 0n });
  };
  const busy = deposit.held || withdraw.subject !== null || termsGate.session !== null;

  return (
    <section className="home-section" aria-labelledby="rewards-vpfi-title" data-testid="rewards-vpfi" data-vpfi="available">
      {head}
      {balances.state === 'failed' && b === null && (
        <p className="tier-a" data-testid="rewards-vpfi-failed">
          {format('rewardsVault.failed', { reason: balances.error ?? 'no answer' })}
        </p>
      )}
      {b === null && balances.state !== 'failed' && <p className="tier-b">{text('rewardsVault.reading')}</p>}
      {b !== null && fig !== null && (
        <>
          <dl className="facts" data-testid="rewards-vpfi-balances">
            <dt className="tier-b">{text('rewardsVault.rowWallet')}</dt>
            <dd data-testid="rewards-vpfi-wallet">{amount(b.wallet)}</dd>
            <dt className="tier-b">{text('rewardsVault.rowCounted')}</dt>
            <dd data-testid="rewards-vpfi-counted">{amount(b.counted)}</dd>
            <dt className="tier-b">{text('rewardsVault.rowFree')}</dt>
            <dd data-testid="rewards-vpfi-free">{amount(b.free)}</dd>
            <dt className="tier-b">{text('rewardsVault.rowHeld')}</dt>
            <dd data-testid="rewards-vpfi-held">{amount(fig.held)}</dd>
          </dl>
          {b.home === false && (
            <p className="tier-a" data-testid="rewards-vpfi-away">
              {text('rewardsVault.away')}
            </p>
          )}
          {b.home === null && <p className="tier-a">{text('rewardsVault.homeUnread')}</p>}
          {b.vault === null && <p className="tier-b">{text('rewardsVault.noVault')}</p>}
          {fig.uncounted !== null && fig.uncounted > 0n && (
            <p className="tier-a" data-testid="rewards-vpfi-uncounted">
              {format('rewardsVault.uncounted', { amount: amount(fig.uncounted) })} <Link to="/vault">{text('rewardsVault.adopt')}</Link>
            </p>
          )}
        </>
      )}
      <p className="tier-b">{text('rewardsVault.notCollateral')}</p>
      <p className="tier-b">{text('rewardsVault.noPrice')}</p>
      <OwnStamp reads={[balances]} />
      {terms.state === 'failed' && (
        <Notice tone="warn" tier="A">
          {format('consent.termsUnknown', { chain: chain.name, reason: terms.error ?? 'no answer' })}{' '}
          <button type="button" className="btn" onClick={terms.refetch}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {termsGate.session ? (
        <TermsPrompt
          asker={text('rewardsVault.asker')}
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
        <div data-testid="rewards-vpfi-terms-due">
          <Notice tone="warn" tier="A">
            {text('vaultDeposit.termsDue')}
          </Notice>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={openDeposit}>
              {text('vaultDeposit.termsAccept')}
            </button>
            <button type="button" className="btn" onClick={() => deposit.setOpen(null)}>
              {text('flow.cancel')}
            </button>
          </div>
        </div>
      ) : deposit.held ? (
        <DepositVault
          chain={chain}
          own={own}
          flowKey={VPFI_DEPOSIT_KEY}
          asset={token}
          title={text('rewardsVault.depositTitle')}
          onClose={() => deposit.setOpen(null)}
          onTermsDue={terms.refetch}
        />
      ) : withdraw.subject !== null ? (
        <WithdrawVault chain={chain} own={own} flowKey={VPFI_WITHDRAW_KEY} subject={withdraw.subject} onClose={() => withdraw.open(null)} />
      ) : null}
      {!busy && (
        <>
          {paused.data === true && (
            <p className="tier-a" data-testid="rewards-vpfi-paused">
              {text('rewardsVault.paused')}
            </p>
          )}
          {frozen === 'flagged' && <p className="tier-a">{text('rewardsVault.flagged')}</p>}
          {closed !== null && closed !== 'unread' && (
            <p className="tier-b" data-testid="rewards-vpfi-withdraw-closed">
              {text(closed === 'no-vault' ? 'rewardsVault.closedNoVault' : closed === 'none' ? 'rewardsVault.closedNone' : 'rewardsVault.closedHeld')}
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={openDeposit}
              disabled={terms.state !== 'ready' || paused.data === true || frozen === 'flagged'}
              data-testid="rewards-vpfi-deposit"
            >
              {text('rewardsVault.deposit')}
            </button>
            <button type="button" className="btn" onClick={openWithdraw} disabled={closed !== null} data-testid="rewards-vpfi-withdraw">
              {text('rewardsVault.withdraw')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
