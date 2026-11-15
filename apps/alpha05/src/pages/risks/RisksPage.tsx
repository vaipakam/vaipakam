import { useCopy } from '../../shared/copy/useCopy';
import { MORE_RISKS } from '../../shared/risk/keyRisks';
import { KeyRiskList } from '../../shared/risk/KeyRiskList';

/**
 * #3661 — the key risks, always reachable: from the footer, and from the
 * "If things go wrong" line of every loan and rental review. A public page:
 * no wallet, nothing read from the chain. It holds the short list the Terms
 * prompt shows and the further points a user should know.
 */
export function RisksPage() {
  const { text } = useCopy();
  return (
    <section aria-labelledby="risks-title" data-testid="risks-page">
      <h1 id="risks-title">{text('keyRisks.pageTitle')}</h1>
      <p className="tier-b">{text('keyRisks.pageIntro')}</p>
      <KeyRiskList testId="risks-key" />
      <h2>{text('keyRisks.moreTitle')}</h2>
      <ul className="consequences tier-a" data-testid="risks-more">
        {MORE_RISKS.map((k) => (
          <li key={k}>{text(k)}</li>
        ))}
      </ul>
    </section>
  );
}
