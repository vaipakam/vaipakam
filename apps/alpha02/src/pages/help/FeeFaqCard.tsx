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
import { useProtocolFees, bpsToPercentText } from '../../data/fees';
import { copy } from '../../content/copy';

export default function FeeFaqCard() {
  const fees = useProtocolFees();
  return (
    <section className="card">
      <h3>{copy.fees.faqQuestion}</h3>
      <p style={{ margin: 0 }}>
        {copy.fees.faqAnswer(
          bpsToPercentText(fees.loanInitiationFeeBps),
          bpsToPercentText(fees.treasuryFeeBps),
        )}
      </p>
    </section>
  );
}
