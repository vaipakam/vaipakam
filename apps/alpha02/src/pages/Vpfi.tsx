/**
 * VPFI fee discounts — optional utility, never a prerequisite.
 *
 * Availability-first page state (audit F-20260702-003): whether VPFI
 * deposits are possible on the active chain is decided BEFORE any
 * education or controls render, so a user is never invited to deposit
 * on a chain that can't accept it. Deposit/withdraw controls land in
 * a later alpha02 iteration; this page sets the mental model.
 */
import { Coins } from 'lucide-react';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';

const TIERS: Array<{ held: string; discount: string }> = [
  { held: '100 – 999 VPFI', discount: '10%' },
  { held: '1,000 – 4,999 VPFI', discount: '15%' },
  { held: '5,000 – 20,000 VPFI', discount: '20%' },
  { held: 'Over 20,000 VPFI', discount: '24%' },
];

export function Vpfi() {
  const { readChain } = useActiveChain();

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">{copy.vpfi.title}</h1>
        <p className="page-lede">{copy.vpfi.optional}</p>
      </div>

      <div className="banner banner-info">
        <Coins aria-hidden />
        <span className="banner-body">
          {copy.vpfi.notOnThisChain(readChain.name)} Deposit and withdraw
          controls arrive here in an upcoming alpha02 build.
        </span>
      </div>

      <section className="card">
        <h3>How the discount works</h3>
        <p>
          Hold VPFI in your Vaipakam Vault and the protocol fee on eligible
          loans shrinks. The discount uses your average holding over the last
          30 days — topping up today grows your discount gradually, not
          instantly.
        </p>
        <dl className="receipt" style={{ margin: 0 }}>
          {TIERS.map((t) => (
            <div key={t.held} className="receipt-row">
              <dt>{t.held}</dt>
              <dd>{t.discount} off eligible protocol fees</dd>
            </div>
          ))}
        </dl>
        <p className="muted" style={{ marginTop: 12 }}>
          {copy.vpfi.noGasDiscount} {copy.vpfi.withdrawWarning} Vaipakam does
          not sell VPFI and pays no holding yield — you acquire it on the open
          market.
        </p>
      </section>
    </div>
  );
}
