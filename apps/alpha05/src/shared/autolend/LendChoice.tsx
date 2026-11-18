import { useId } from 'react';
import { Link } from 'react-router-dom';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { pageHandoff } from '../../routes/pageMap';
import { autoLendOption, type LendChoiceFacts } from './lendChoice';

interface LendChoiceProps {
  runs: 'once' | 'keep';
  onRuns: (r: 'once' | 'keep') => void;
  /** null while read, or when the read failed (`failed`). */
  facts: LendChoiceFacts | null;
  failed: boolean;
  disabled: boolean;
  /** Opens the chosen form. */
  onOpen: (chosen: 'once' | 'keep') => void;
}

/**
 * #3624 (Item D) — one Lend flow, one choice: "keep lending when repaid"
 * sets up Auto-lend, otherwise the lender posts a one-time offer. The
 * Auto-lend option is closed, with the reason stated, when the protocol is
 * paused or matching or Auto-lend is switched off on this network, and when
 * the wallet already has an Auto-lend on the pair (shown on Positions). An
 * unread switch leaves it open and says so: the review reads it again.
 */
export function LendChoice({ runs, onRuns, facts, failed, disabled, onOpen }: LendChoiceProps) {
  const { text, format } = useCopy();
  const name = useId();
  const option = autoLendOption(facts);
  const keepClosed = option !== 'open';
  const chosen = keepClosed && runs === 'keep' ? 'once' : runs;
  const positions = pageHandoff('/positions');
  return (
    <div className="lend-choice" data-testid="lend-choice" data-autolend={option}>
      <fieldset>
        <legend>{text('autoLend.choiceLegend')}</legend>
        <label>
          <input type="radio" name={name} checked={chosen === 'once'} onChange={() => onRuns('once')} data-testid="lend-choice-once" />
          <span>{text('autoLend.choiceOnce')}</span>
        </label>
        <label>
          <input type="radio" name={name} checked={chosen === 'keep'} disabled={keepClosed} onChange={() => onRuns('keep')} data-testid="lend-choice-keep" />
          <span>{text('autoLend.choiceKeep')}</span>
        </label>
      </fieldset>
      <WhyLink summaryKey="autoLend.choiceSummary" detailKey="autoLend.choiceWhy" />
      {(option === 'halted' || option === 'off') && (
        <p className="tier-a" data-testid="lend-choice-off">
          {format('autoLend.choiceOff', { why: text(option === 'halted' ? 'autoLend.whyHalted' : 'autoLend.whyOff') })}
        </p>
      )}
      {option === 'has' && (
        <p className="tier-a" data-testid="lend-choice-has">
          {text('autoLend.choiceHas')} {positions.kind === 'here' && <Link to={positions.to}>{text('autoLend.openPositions')}</Link>}
        </p>
      )}
      {(failed || facts?.posture === 'unknown') && <p className="tier-b">{text('autoLend.choiceUnknown')}</p>}
      <p className="actions">
        <button
          type="button"
          className="btn"
          disabled={disabled}
          onClick={() => {
            if (chosen !== runs) onRuns(chosen);
            onOpen(chosen);
          }}
          data-testid="lend-offer-open"
        >
          {text(chosen === 'keep' ? 'autoLend.formTitle' : 'lend.postOpen')}
        </button>
      </p>
    </div>
  );
}
