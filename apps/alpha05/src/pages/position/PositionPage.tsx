import { Link, useParams } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import { useOwnStateClient, type OwnStateClient } from '../../chain/ownRail';
import { useCopy, type CopyKey } from '../../shared/copy/useCopy';
import { CADENCE_NAME, isCadence } from '../../shared/offers/cadence';
import { ASSET_ERC20, LOAN_STATUS_ACTIVE, LOAN_STATUS_FALLBACK_PENDING, isLiveStatus, loanObligations, loanStatusName } from '../../shared/positions/model';
import { assetAmount } from '../../shared/positions/assetAmount';
import { InterestLine, ReadState, StageLine } from '../../shared/positions/PositionSections';
import { ILLIQUID, readLoanView, recordedInitFeeBps, roleOf, treasuryShareBps, type DefaultRefusal, type LoanView, type Role } from '../../shared/positions/loanView';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { tokenAmount, useTokenMeta, type TokenMetaMap } from '../../shared/reads/tokens';
import { formatBps, formatScaled, formatSpan, formatUtc, shortAddress } from '../../shared/ui/format';
import { OwnStamp } from '../../shared/ui/OwnStamp';
import { useNow } from '../../shared/ui/useNow';
import { WhyLink } from '../../shared/help/WhyLink';
import { Notice } from '../../shared/ui/Notice';
import { FrozenNotice, useFrozenState } from '../../shared/sanctions/FrozenNotice';
import { LoanActions } from './LoanActions';
import { LoanClaims } from './LoanClaims';
import { Fact, Facts } from './Facts';
import { InterestSchedule } from './InterestSchedule';

/** What the page says when the timing allows a default but another gate
 *  of `triggerDefault` refuses it. */
const DEFAULT_REFUSAL_KEY: Readonly<Record<DefaultRefusal, CopyKey>> = {
  paused: 'position.defaultRefusedPaused',
  sequencer: 'position.defaultRefusedSequencer',
  admission: 'position.defaultRefused',
};

type Hex = `0x${string}`;

/** A loan id as the address writes it: a positive whole number. */
function parseLoanId(raw: string | undefined): bigint | null {
  if (!raw || !/^[1-9][0-9]{0,77}$/.test(raw)) return null;
  return BigInt(raw);
}

/**
 * Position (rulebook §4; LN-04, LN-07, LN-08, LN-09, LN-10, LN-11, LN-12,
 * LN-13): one loan, its status first, then the reader's role (the positions
 * their wallet holds now), any deadline that needs them, its dates with the
 * pause credit, its terms as the loan fixed them, its health, and where its
 * collateral is held. Every figure is read, and one that could not be read is
 * said to be unknown. A running loan's actions follow its status (LN-21:
 * repaying in full); the actions still to come are said to be coming.
 */
export function PositionPage() {
  const { text, format } = useCopy();
  const params = useParams();
  const loanId = parseLoanId(params.id);
  const own = useOwnStateClient();
  // Connection and network are read on their own, as Home and Positions do:
  // a wallet on a network this app does not serve is told to switch, not to
  // connect.
  const { status, chainId } = useAccount();
  const connected = status === 'connected';
  const chain = getSupportedChain(own?.chainId ?? chainId);
  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const view = useOwnRead(['position', diamond, loanId?.toString() ?? ''], (c) => readLoanView(c, diamond, loanId!), { enabled: chain !== null && loanId !== null });
  const meta = useTokenMeta(view.data?.view ? [view.data.view.loan.principalAsset, view.data.view.loan.collateralAsset, view.data.view.loan.prepayAsset] : []).data;

  return (
    <main className="page position" aria-labelledby="position-title">
      <p className="tier-b">
        <Link to="/positions">{text('position.back')}</Link>
      </p>
      <h1 id="position-title">{format('position.title', { id: params.id ?? '' })}</h1>
      {loanId === null ? (
        <p className="tier-a">{text('position.badId')}</p>
      ) : !connected ? (
        <p className="tier-b">{text('position.connectPrompt')}</p>
      ) : !chain ? (
        <p className="tier-b">{text('position.unsupportedChain')}</p>
      ) : !own ? (
        <p className="tier-b">{text('position.connectPrompt')}</p>
      ) : (
        <>
          <OwnStamp reads={[view]} />
          <ReadState read={view}>
            {({ view: v }) =>
              v === null ? (
                <p className="tier-a">{format('position.notFound', { id: loanId.toString(), chain: chain.name })}</p>
              ) : (
                <LoanBody loanId={loanId} view={v} own={own} chain={chain} meta={meta} />
              )
            }
          </ReadState>
        </>
      )}
    </main>
  );
}

function LoanBody({ loanId, view: v, own, chain, meta }: { loanId: bigint; view: LoanView; own: OwnStateClient; chain: SupportedChain; meta: TokenMetaMap | null }) {
  const { text, format } = useCopy();
  const account = own.account;
  const nowSec = Math.floor(useNow() / 1000);
  const l = v.loan;
  const role = roleOf(v.holders, account);
  const live = isLiveStatus(l.status);
  const erc20 = l.assetType === ASSET_ERC20;
  const share = treasuryShareBps(l);
  const initFee = recordedInitFeeBps(l);
  // A loan with an illiquid leg has no price-based risk math: the protocol
  // refuses the health and LTV reads for it, so a refused read here is "none",
  // not "unknown". On a loan with both legs priced, every successful read is
  // a figure, zero included (a collateral value that rounds to nothing).
  const noRiskMath = l.principalLiquidity === ILLIQUID || l.collateralLiquidity === ILLIQUID;
  const amountOf = (asset: Hex, assetType: number, amount: bigint, tokenId: bigint, quantity: bigint) => assetAmount({ asset, assetType, amount, tokenId, quantity }, meta, format);
  // Deadline wording follows the side the reader holds; a viewer who holds
  // neither reads the lender's (no "you must repay").
  const borrowerSide = role?.borrower === true && role.lender !== true;
  const obligations = live ? loanObligations({ loan: l, borrowerSide, healthFactor: v.healthFactor ?? 0n }, v.deadlines, nowSec) : null;
  const unknown = text('receipt.unknown');
  // RB-FROZEN — the reader's own standing, said only to a holder of a side.
  const frozen = useFrozenState(chain.diamondAddress, role ? account : null);
  // What a running loan already paid that waits for the lender's claim, in
  // the loan's payment token (the principal token, or a rental's prepay
  // token).
  const held = l.status === LOAN_STATUS_ACTIVE && v.heldForLender !== null && v.heldForLender > 0n ? v.heldForLender : null;
  // A surplus still held for the borrower is one payout a repaid loan waits
  // on before it settles (LN-53): said, so the loan's status reads true. The
  // lender's side may be open too, so the note never promises that collecting
  // the surplus alone settles it.
  const surplusOpen = loanStatusName(l.status) === 'repaid' && v.claims.borrower !== null && v.claims.borrower.surplus !== null;

  return (
    <>
      <StatusLine status={l.status} />
      <RoleLine role={role} />
      {role && <FrozenNotice state={frozen} />}
      {obligations && (
        <div className="position-now">
          <StageLine stage={obligations.stage} borrowerSide={borrowerSide} rental={!erc20} defaultable={v.defaultable} />
          {obligations.interest && <InterestLine stage={obligations.interest} borrowerSide={borrowerSide} amountOf={(x) => tokenAmount(x, l.principalAsset, meta, format)} />}
          {v.deadlines?.periodic && !v.deadlines.periodic.enforced && (
            <p className="tier-b" data-testid="position-checkpoints-off">
              {text('positions.interestCheckpointsOff')}
            </p>
          )}
          {v.defaultable === true && <p className="tier-a">{text('position.defaultable')}</p>}
          {v.defaultRefusal !== null && (
            <p className="tier-a" data-testid="position-default-refused" data-reason={v.defaultRefusal}>
              {text(DEFAULT_REFUSAL_KEY[v.defaultRefusal])}
            </p>
          )}
        </div>
      )}
      {/* An NFT rental has no collateral leg (its collateral liquidity is
          recorded as illiquid regardless), so it states its own default
          consequence instead of the in-kind hand-over. */}
      {erc20 && l.collateralLiquidity === ILLIQUID && live && (
        <div data-testid="position-in-kind">
          <Notice tone="warn" tier="A">
            {text('position.inKind')}
          </Notice>
        </div>
      )}
      {!erc20 && live && (
        <div data-testid="position-rental-default">
          <Notice tone="warn" tier="A">
            {text('position.rentalDefault')}
          </Notice>
        </div>
      )}

      <LoanActions loanId={loanId} view={v} role={role} own={own} chain={chain} meta={meta} />
      <LoanClaims loanId={loanId} view={v} own={own} chain={chain} meta={meta} frozen={frozen} />
      {held !== null && (
        <div data-testid="position-held-for-lender">
          <Notice tone="info" tier="A">
            {format('frozen.reservedRunning', { amount: tokenAmount(held, erc20 ? l.principalAsset : l.prepayAsset, meta, format) })}
          </Notice>
        </div>
      )}
      {surplusOpen && (
        <p className="tier-a" data-testid="position-surplus-open">
          {text('frozen.openForSurplus')}
        </p>
      )}

      {live && (
        <Facts title={text('position.datesTitle')} id="position-dates" lead={v.deadlines === null ? <p className="tier-a">{text('position.datesUnknown')}</p> : null}>
          <Fact label={text('position.rowOriginalDue')} value={v.originalMaturity === null ? null : formatUtc(Number(v.originalMaturity))} unknown={unknown} />
          <Fact
            label={text('position.rowPauseCredit')}
            value={
              v.deadlines === null
                ? null
                : v.deadlines.pauseCredit === 0n
                  ? text('position.pauseNone')
                  : format('position.pauseCredit', { span: formatSpan(Number(v.deadlines.pauseCredit)) })
            }
            unknown={unknown}
          />
          <Fact label={text('position.rowDue')} value={v.deadlines === null ? null : formatUtc(Number(v.deadlines.maturity))} unknown={unknown} binding />
          <Fact label={text('position.rowGraceEnd')} value={v.deadlines === null ? null : formatUtc(Number(v.deadlines.graceEnd))} unknown={unknown} binding />
        </Facts>
      )}

      {l.status === LOAN_STATUS_ACTIVE && erc20 && l.periodicInterestCadence !== 0 && <InterestSchedule view={v} meta={meta} />}

      <Facts title={text('position.termsTitle')} id="position-terms" lead={<p className="tier-b">{text(erc20 ? 'position.termsNow' : 'position.termsNowRental')}</p>}>
        <Fact
          label={text(erc20 ? (live ? 'position.rowPrincipal' : 'position.rowPrincipalEnded') : 'position.rowRented')}
          value={
            erc20 && !live && l.principal === 0n
              ? text(loanStatusName(l.status) === 'matched' ? 'position.principalMatched' : 'position.principalNoneEnded')
              : amountOf(l.principalAsset, l.assetType, l.principal, l.tokenId, l.quantity)
          }
          unknown={unknown}
        />
        {erc20 && <Fact label={text('position.rowRate')} value={format('position.rate', { rate: formatBps(l.interestRateBps) })} unknown={unknown} />}
        {!erc20 && <Fact label={text('position.rowRentPerDay')} value={tokenAmount(l.principal, l.prepayAsset, meta, format)} unknown={unknown} binding />}
        {!erc20 && (
          <Fact label={text('position.rowRentEarly')} value={text(l.useFullTermInterest ? 'position.rentEarlyFull' : 'position.rentEarlyUsed')} unknown={unknown} binding />
        )}
        <Fact label={text('position.rowTerm')} value={format('position.term', { days: l.durationDays.toString() })} unknown={unknown} />
        {erc20 && <Fact label={text('position.rowInterest')} value={text(l.useFullTermInterest ? 'position.interestFull' : 'position.interestProRata')} unknown={unknown} />}
        {erc20 && (
          <Fact
            label={text('position.rowSchedule')}
            value={
              l.periodicInterestCadence === 0
                ? text('accept.scheduleNone')
                : format('accept.scheduleEvery', {
                    cadence: text(isCadence(l.periodicInterestCadence) && l.periodicInterestCadence !== 0 ? CADENCE_NAME[l.periodicInterestCadence] : 'receipt.unknown'),
                  })
            }
            unknown={unknown}
          />
        )}
        {erc20 && <Fact label={text('position.rowPartial')} value={text(l.allowsPartialRepay ? 'position.allowed' : 'position.notAllowed')} unknown={unknown} />}
        {erc20 && <Fact label={text('position.rowListing')} value={text(l.allowsPrepayListing ? 'position.allowed' : 'position.notAllowed')} unknown={unknown} />}
        {erc20 && (
          <Fact
            label={text('position.rowShare')}
            value={format(share.legacy ? 'position.shareLegacy' : 'position.share', { rate: formatBps(BigInt(share.bps)) })}
            unknown={unknown}
          />
        )}
        {erc20 && (
          <Fact
            label={text('position.rowInitFee')}
            value={
              v.saleVehicle === null
                ? null
                : v.saleVehicle
                  ? text('position.initFeeNone')
                  : initFee === null
                    ? text('position.initFeeUnrecorded')
                    : format('position.initFee', { rate: formatBps(BigInt(initFee)) })
            }
            unknown={unknown}
          />
        )}
        <Fact
          label={text('position.rowCollateral')}
          value={amountOf(l.collateralAsset, l.collateralAssetType, l.collateralAmount, l.collateralTokenId, l.collateralQuantity)}
          unknown={unknown}
        />
      </Facts>

      {live && erc20 && (
        <Facts title={text('position.healthTitle')} id="position-health" lead={<WhyLink summaryKey="position.healthSummary" detailKey="position.healthWhy" />}>
          <Fact
            label={text('position.rowHf')}
            value={noRiskMath ? text('position.hfNone') : v.healthFactor === null ? null : formatScaled(v.healthFactor)}
            unknown={unknown}
            binding
          />
          <Fact
            label={text('position.rowLtv')}
            value={noRiskMath ? text('position.ltvNone') : v.ltvBps === null ? null : format('position.ltv', { rate: formatBps(v.ltvBps) })}
            unknown={unknown}
          />
          <Fact label={text('position.rowLiqLtv')} value={format('position.liqLtv', { rate: formatBps(BigInt(l.liquidationLtvBpsAtInit)) })} unknown={unknown} />
          {!noRiskMath && (
            <Fact
              label={text('position.rowMatchWindow')}
              value={
                v.matchWindow === null
                  ? null
                  : !v.matchWindow.enabled
                    ? text('position.matchWindowOff')
                    : v.matchWindow.windowBps === 0n
                      ? text('position.matchWindowNone')
                      : format('position.matchWindow', {
                          from: formatBps(BigInt(l.liquidationLtvBpsAtInit)),
                          to: formatBps(BigInt(l.liquidationLtvBpsAtInit) + v.matchWindow.windowBps),
                        })
              }
              unknown={unknown}
            />
          )}
        </Facts>
      )}

      <Facts title={text('position.collateralTitle')} id="position-collateral">
        {v.lien === null ? (
          <Fact label={text('position.rowLienState')} value={null} unknown={unknown} />
        ) : v.lien.released ? (
          // A release zeroes the lien's amount, so it is checked before a
          // zero amount is read as "no collateral".
          <Fact label={text('position.rowLienState')} value={text('position.lienReleased')} unknown={unknown} />
        ) : v.lien.amount === 0n && v.lien.assetType === ASSET_ERC20 ? (
          <Fact label={text('position.rowLienState')} value={text('position.lienNone')} unknown={unknown} />
        ) : (
          <>
            <Fact label={text('position.rowLienAmount')} value={amountOf(v.lien.asset, v.lien.assetType, v.lien.amount, v.lien.tokenId, v.lien.amount)} unknown={unknown} />
            <Fact
              label={text('position.rowLienState')}
              value={format(live ? 'position.lienHeld' : 'position.lienHeldEnded', { vault: shortAddress(v.lien.user) })}
              unknown={unknown}
              binding
            />
          </>
        )}
      </Facts>

      {!live && (
        <p className="tier-b" data-testid="position-actions-later">
          {text('position.actionsLater')}
        </p>
      )}
    </>
  );
}

function StatusLine({ status }: { status: number }) {
  const { text, format } = useCopy();
  const name = loanStatusName(status);
  const KEYS: Record<string, CopyKey> = {
    active: 'position.statusActive',
    fallback: 'position.statusFallback',
    repaid: 'positions.statusRepaid',
    defaulted: 'positions.statusDefaulted',
    settled: 'positions.statusSettled',
    matched: 'position.statusMatchedOpen',
  };
  const adverse = status === LOAN_STATUS_FALLBACK_PENDING || name === 'defaulted';
  const key = KEYS[name];
  return (
    <p className={adverse ? 'tier-a stage' : 'tier-b'} data-status={name} data-testid="position-status">
      {key ? text(key) : format('positions.statusUnknown', { number: String(status) })}
    </p>
  );
}

function RoleLine({ role }: { role: Role | null }) {
  const key: CopyKey =
    role === null
      ? 'position.roleConfirming'
      : role.lender && role.borrower
        ? 'position.roleBoth'
        : role.lender
          ? 'position.roleLender'
          : role.borrower
            ? 'position.roleBorrower'
            : 'position.roleNone';
  return (
    <div
      data-testid="position-role"
      data-role={role === null ? 'confirming' : role.lender && role.borrower ? 'both' : role.lender ? 'lender' : role.borrower ? 'borrower' : 'none'}
    >
      <WhyLink summaryKey={key} detailKey="position.roleWhy" />
    </div>
  );
}
