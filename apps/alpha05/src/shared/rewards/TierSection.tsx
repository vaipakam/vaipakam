import { useMode } from '../../app/ModeContext';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { readVpfiToken } from '../claims/rewards';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { useChainRead } from '../reads/chainRead';
import { tokenAmount, useTokenMeta } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { OwnStamp } from '../ui/OwnStamp';
import { discountPercent, readTierCard, readTierTable, tierRows, tierState, type TierRow } from './tiers';

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * RW-08, RW-09, RW-10 — the wallet's fee-discount tier and the table of
 * tiers, on the Rewards page, on a network with VPFI set up.
 *
 * The card states the tier the protocol applies to a fee now, never one
 * worked out here: zero while the fee discount is off; on VPFI's home
 * network, with one line when the holding rules hold it below what the
 * counted VPFI alone would give (which rule is not said: the protocol does
 * not report it); elsewhere, the copy sent from the home network. Advanced
 * adds that the holding rules' settings are not readable here.
 *
 * The table is shown on the home network only, where tiers are set: each
 * tier's VPFI band with the protocol's exact boundaries, its discount
 * after the 50% cap, and the loan initiation fee and the fee on interest
 * with that discount, computed from this network's live settings. Nothing
 * here prices VPFI or pays for holding it (RL-6).
 */
export function TierSection({ chain, own }: { chain: SupportedChain; own: OwnStateClient }) {
  const { text, format } = useCopy();
  const { mode } = useMode();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const tokenRead = useChainRead(['vpfiToken', diamond], (c) => readVpfiToken(c, diamond), { immutable: true });
  const token = tokenRead.data && tokenRead.data.toLowerCase() !== ZERO ? tokenRead.data : null;
  const card = useOwnRead(['rewards', 'tierCard', diamond], (c) => readTierCard(c, diamond, account), { enabled: token !== null, perBlock: true });
  const home = card.data?.home ?? null;
  const table = useOwnRead(['rewards', 'tierTable', diamond], (c) => readTierTable(c, diamond), { enabled: token !== null && home === true, perBlock: true });
  const meta = useTokenMeta(token ? [token] : []).data ?? null;
  if (token === null) return null;

  const state = card.data ? tierState(card.data) : null;
  // Boundaries are stated exactly, every digit (RW-09).
  const vpfi = (v: bigint) => tokenAmount(v, token, meta, format, true);
  const band = (r: TierRow) =>
    r.to === null
      ? format('rewardsTier.bandAbove', { from: vpfi(r.from) })
      : r.tier === 0
        ? format('rewardsTier.bandBelow', { to: vpfi(r.to) })
        : format(r.toIncluded ? 'rewardsTier.bandUpTo' : 'rewardsTier.bandBefore', { from: vpfi(r.from), to: vpfi(r.to) });
  const rows = table.data ? tierRows(table.data) : null;

  return (
    <section className="home-section" aria-labelledby="rewards-tier-title" data-testid="rewards-tier">
      <h2 id="rewards-tier-title">{text('rewardsTier.title')}</h2>
      <WhyLink summaryKey="rewardsTier.lead" detailKey="rewardsTier.why" />
      {card.state === 'failed' && card.data === null && (
        <p className="tier-a" data-testid="rewards-tier-failed">
          {format('rewardsTier.failed', { reason: card.error ?? 'no answer' })}
        </p>
      )}
      {card.data === null && card.state !== 'failed' && <p className="tier-b">{text('rewardsTier.reading')}</p>}
      {state !== null && (
        <div data-testid="rewards-tier-now" data-state={state.kind} data-tier={'tier' in state ? state.tier : ''}>
          {state.kind === 'unread' && <p className="tier-a">{text('rewardsTier.unread')}</p>}
          {state.kind === 'consent-off' && <p className="tier-a">{text('rewardsTier.consentOff')}</p>}
          {state.kind === 'copy' &&
            (state.tier === 0 ? (
              <p className="tier-a">{text('rewardsTier.copyNone')}</p>
            ) : (
              <p className="tier-a">{format('rewardsTier.copy', { tier: String(state.tier), discount: discountPercent(state.bps) })}</p>
            ))}
          {(state.kind === 'applies' || state.kind === 'held-down') &&
            (state.tier === 0 ? (
              <p className="tier-b">{text('rewardsTier.zero')}</p>
            ) : (
              <p className="tier-b">{format('rewardsTier.applies', { tier: String(state.tier), discount: discountPercent(state.bps) })}</p>
            ))}
          {state.kind === 'held-down' && (
            <p className="tier-a" data-testid="rewards-tier-held">
              {format('rewardsTier.heldDown', { counted: String(state.counted), tier: String(state.tier) })}
            </p>
          )}
          {state.kind === 'held-down' && mode === 'advanced' && <p className="tier-b">{text('rewardsTier.rulesUnread')}</p>}
        </div>
      )}
      <OwnStamp reads={[card]} />

      <h3 id="rewards-tier-table-title">{text('rewardsTier.tableTitle')}</h3>
      {home === false && (
        <p className="tier-b" data-testid="rewards-tier-table-away">
          {text('rewardsTier.tableAway')}
        </p>
      )}
      {home === null && card.data !== null && <p className="tier-b">{text('rewardsTier.tableHomeUnread')}</p>}
      {home === true && (
        <>
          <WhyLink summaryKey="rewardsTier.tableLead" detailKey="rewardsTier.tableWhy" />
          {table.state === 'failed' && table.data === null && (
            <p className="tier-a" data-testid="rewards-tier-table-failed">
              {format('rewardsTier.tableFailed', { reason: table.error ?? 'no answer' })}
            </p>
          )}
          {table.data === null && table.state !== 'failed' && <p className="tier-b">{text('rewardsTier.reading')}</p>}
          {rows !== null && (
            <ul className="rows" aria-labelledby="rewards-tier-table-title" data-testid="rewards-tier-table">
              {rows.map((r) => (
                <li key={r.tier} className="card" data-testid="rewards-tier-row" data-tier={r.tier}>
                  <p className="row-head">{format('rewardsTier.rowTitle', { tier: String(r.tier) })}</p>
                  <dl className="facts">
                    <dt className="tier-b">{text('rewardsTier.colVpfi')}</dt>
                    <dd className="value-amount">{band(r)}</dd>
                    <dt className="tier-b">{text('rewardsTier.colDiscount')}</dt>
                    <dd className="value-amount">{r.capped ? format('rewardsTier.discountCapped', { discount: r.discount }) : `${r.discount}%`}</dd>
                    <dt className="tier-b">{text('rewardsTier.colLif')}</dt>
                    <dd className="value-amount">{`${r.lif}%`}</dd>
                    <dt className="tier-b">{text('rewardsTier.colYield')}</dt>
                    <dd className="value-amount">{`${r.yieldFee}%`}</dd>
                  </dl>
                </li>
              ))}
            </ul>
          )}
          <OwnStamp reads={[table]} />
        </>
      )}
    </section>
  );
}
