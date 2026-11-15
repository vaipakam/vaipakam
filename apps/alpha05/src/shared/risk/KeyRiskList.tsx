import { useCopy } from '../copy/useCopy';
import { KEY_RISKS } from './keyRisks';

/** #3661 — the short key-risk list, as the Terms prompt and the risk page
 *  show it: one statement a line, tier A, in a fixed order. */
export function KeyRiskList({ testId }: { testId: string }) {
  const { text } = useCopy();
  return (
    <ul className="consequences tier-a key-risks" data-testid={testId}>
      {KEY_RISKS.map((k) => (
        <li key={k}>{text(k)}</li>
      ))}
    </ul>
  );
}
