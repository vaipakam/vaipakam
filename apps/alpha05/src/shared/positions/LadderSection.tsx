import { useCopy } from '../copy/useCopy';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import type { OwnRead } from '../reads/useOwnRead';
import { lendingLadder } from './ladder';
import type { LiveLoans } from './reads';

/**
 * #3770 — the lending ladder on Positions: what the account has lent, by the
 * month it falls due, per token. Read from the same live positions as the
 * list below it, whose section states the read's own state; it signs
 * nothing. A shared account reads its whole book here at a glance.
 */
export function LadderSection({ read, meta }: { read: OwnRead<LiveLoans>; meta: TokenMetaMap | null }) {
  const { text, format } = useCopy();
  const data = read.data;
  if (data === null) return null;
  const l = lendingLadder(data.rows, data.deadlines, data.complete);
  if (l.rungs.length === 0 && l.undated.length === 0) return null;
  const amount = (v: bigint, asset: `0x${string}`) => (l.complete ? tokenAmount(v, asset, meta, format) : format('positions.ladderAtLeast', { amount: tokenAmount(v, asset, meta, format) }));
  return (
    <section className="home-section" aria-labelledby="positions-ladder" data-testid="positions-ladder">
      <h2 id="positions-ladder">{text('positions.ladderTitle')}</h2>
      <p className="tier-b">{text('positions.ladderLead')}</p>
      {!l.complete && <p className="tier-a">{text('positions.ladderPartial')}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{text('positions.ladderMonth')}</th>
              <th scope="col">{text('positions.ladderAmount')}</th>
              <th scope="col">{text('positions.ladderLoans')}</th>
            </tr>
          </thead>
          <tbody>
            {l.rungs.map((r) => (
              <tr key={`${r.month}:${r.asset}`} data-month={r.month}>
                <td>{r.month}</td>
                <td>{amount(r.principal, r.asset)}</td>
                <td>{r.loans}</td>
              </tr>
            ))}
            {l.undated.map((u) => (
              <tr key={`undated:${u.asset}`} data-month="unread">
                <td>{text('positions.ladderUndated')}</td>
                <td>{amount(u.principal, u.asset)}</td>
                <td>{u.loans}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
