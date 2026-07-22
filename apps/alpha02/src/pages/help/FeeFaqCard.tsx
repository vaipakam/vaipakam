/**
 * Help's fee FAQ, split into its own lazy chunk (UX2-008). It is Help's
 * ONLY Diamond-ABI dependency: `useProtocolFees` → `data/fees` →
 * `DIAMOND_ABI_VIEM`. Keeping it out of Help's own chunk means a direct
 * `/help` visit (a marketing-ish route) paints without pulling the
 * ~761 kB ABI; Help renders this behind a `Suspense` whose fallback
 * shows the same card with the compile-time default fee values, so the
 * answer is never blank and the live governance-tuned values hydrate in
 * when the read resolves.
 */
import { useProtocolFees } from '../../data/fees';
import { formatBpsAsPercent } from '../../lib/format';
import { copy } from '../../content/copy';

export default function FeeFaqCard() {
  const fees = useProtocolFees();
  // Until the on-chain read confirms (or if it fails), `useProtocolFees`
  // returns the deploy DEFAULTS with `ready=false` — rendering those as
  // the exact percentages would reintroduce the stale-rate copy this
  // whole path avoids (Codex #1200 r3). Show the non-committal text
  // until the live values are confirmed, then the exact percentages.
  const answer = fees.ready
    ? copy.fees.faqAnswer(
        formatBpsAsPercent(fees.loanInitiationFeeBps),
        formatBpsAsPercent(fees.treasuryFeeBps),
      )
    : copy.fees.faqAnswerGeneric;
  return (
    <section className="card">
      <h3>{copy.fees.faqQuestion}</h3>
      <p style={{ margin: 0 }}>{answer}</p>
    </section>
  );
}
