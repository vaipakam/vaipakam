import { Link } from 'react-router-dom';
import { useMode } from '../../app/ModeContext';
import { useCopy } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { holdStanding, readLenderDiscount, type LenderDiscountRead } from '../../shared/positions/lenderDiscount';
import { ReadState } from '../../shared/positions/PositionSections';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { formatBps, formatUtc } from '../../shared/ui/format';
import { Fact } from './Facts';

type Hex = `0x${string}`;

/**
 * LN-18 (#3586) — the holding discount on the protocol's share of this
 * loan's interest, for the wallet that holds the lender side, as the
 * protocol states it (`lenderHoldDiscountView`, #3562): the figure that
 * applies, and why. Since #3562 it is the lower of the lender's discount when
 * they took the position and their discount at each settlement, so a page
 * that showed only the discount now would promise a figure this loan may not
 * pay. Where the entry figure caps it, the page says so; where the protocol
 * recorded no entry for this wallet, it says no holding discount applies;
 * where the network's contracts do not report the view yet, it says that,
 * never a zero.
 *
 * The fee-discount setting gates the holding discount, so its state is stated
 * here too. Advanced adds the two figures the discount is taken from, how the
 * deployment delivers it, and whether a Full fee tariff adds to it.
 */
export function LenderDiscount({ loanId, diamond, lender }: { loanId: bigint; diamond: Hex; lender: Hex }) {
  const read = useOwnRead(['lender-discount', diamond, loanId.toString(), lender], (c) => readLenderDiscount(c, diamond, loanId, lender));
  const { text } = useCopy();
  return (
    <section className="home-section position-facts" aria-labelledby="position-discount" data-testid="position-discount">
      <h2 id="position-discount">{text('position.discountTitle')}</h2>
      <ReadState read={read}>{(r) => <DiscountFacts r={r} lender={lender} />}</ReadState>
    </section>
  );
}

function DiscountFacts({ r, lender }: { r: LenderDiscountRead; lender: Hex }) {
  const { text, format } = useCopy();
  const { isAdvanced } = useMode();
  const unknown = text('receipt.unknown');
  const pct = (bps: number) => formatBps(BigInt(bps));
  const standing = r.hold === 'absent' ? null : holdStanding(r.hold, lender);

  const applies =
    r.hold === 'absent'
      ? text('position.discountAbsent')
      : standing!.kind === 'unrecorded'
        ? text('position.discountUnrecorded')
        : standing!.bps === 0
          ? text('position.discountNone')
          : format('position.discountApplies', { rate: pct(standing!.bps) });

  const notes = (
    <div className="discount-notes" data-testid="position-discount-notes" data-standing={standing?.kind ?? 'absent'}>
      {r.hold === 'absent' && <p className="tier-b">{text('position.discountAbsentNote')}</p>}
      {standing?.kind === 'capped' && <p className="tier-a">{text('position.discountCapped')}</p>}
      {standing?.kind === 'follows' && standing.bps > 0 && <p className="tier-b">{text('position.discountFollows')}</p>}
      {r.consent === false && (
        <p className="tier-a" data-testid="position-discount-consent" data-consent="off">
          {text('position.discountConsentOff')} <Link to="/rewards">{text('position.discountSetting')}</Link>
        </p>
      )}
      {r.consent === null && (
        <p className="tier-a" data-testid="position-discount-consent" data-consent="unread">
          {text('position.discountConsentUnread')}
        </p>
      )}
    </div>
  );

  return (
    <>
      <WhyLink summaryKey="position.discountSummary" detailKey="position.discountWhy" />
      <dl className="facts">
        <Fact label={text('position.rowDiscount')} value={applies} unknown={unknown} binding />
        {isAdvanced && standing !== null && standing.kind !== 'unrecorded' && (
          <Fact
            label={text('position.rowDiscountEntry')}
            value={format('position.discountEntry', { tier: String(standing.entryTier), rate: pct(standing.entryBps), time: formatUtc(standing.enteredAt) })}
            unknown={unknown}
          />
        )}
        {isAdvanced && standing !== null && (
          <Fact
            label={text('position.rowDiscountNow')}
            value={format('position.discountNow', { tier: String(standing.nowTier), rate: pct(standing.nowBps) })}
            unknown={unknown}
          />
        )}
        {isAdvanced && (
          <Fact
            label={text('position.rowDiscountDelivery')}
            value={r.mode === null ? null : text(r.mode === 'vpfi' ? 'consent.lendVpfi' : 'consent.lendDirect')}
            unknown={unknown}
          />
        )}
        {isAdvanced && (
          <Fact
            label={text('position.rowDiscountTariff')}
            value={r.fullTariff === null ? null : text(r.fullTariff ? 'position.discountTariffOn' : 'position.discountTariffOff')}
            unknown={unknown}
          />
        )}
      </dl>
      {notes}
    </>
  );
}
