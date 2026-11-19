import { useCopy } from '../copy/useCopy';
import { actionsIn } from '../keepers/keepers';
import { instantOff, regainKey, type InstantOff, type LendPreset, type PresetFacts } from './preset';

interface PresetChoicesProps {
  preset: LendPreset;
  /** null while read. */
  facts: PresetFacts | null;
  failed: boolean;
  /** The keeper list the lender confirmed (`regainKey`), or null. */
  confirmed: string | null;
  onPreset: (next: LendPreset) => void;
  onConfirm: (key: string | null) => void;
}

/**
 * #3761 — the Lend form's pre-selected choices (`DefaultPathsDesign.md` §3):
 * re-lending repayments through the platform's keeper, interest by time and
 * the instant market's three consents, each its own switch. A switch the
 * contracts would refuse is off and greyed with the reason; nothing here is
 * set until the lender reviews and signs the one batch. Below them, the ways
 * to lend that stay off unless chosen on purpose.
 */
export function PresetChoices({ preset, facts, failed, confirmed, onPreset, onConfirm }: PresetChoicesProps) {
  const { text, format } = useCopy();
  const set = (patch: Partial<LendPreset>) => onPreset({ ...preset, ...patch });
  const relend = facts?.relend ?? null;
  const off: InstantOff | 'reading' | null = facts === null ? (failed ? 'unknown' : 'reading') : instantOff(preset.proRata, facts.instant);
  const offText = (o: InstantOff | 'reading'): string => {
    switch (o) {
      case 'reading':
        return text('autoLend.instantReading');
      case 'market-off':
        return text('autoLend.instantMarketOff');
      case 'pair-not-eligible':
        return text('autoLend.instantPairOff');
      case 'needs-pro-rata':
        return text('autoLend.instantNeedsProRata');
      default:
        return text('autoLend.instantUnknown');
    }
  };

  // The re-lend line: open only where the batch can give it.
  const relendOpen = relend !== null && (relend.kind === 'grant' || relend.kind === 'given');
  const relendChecked = relendOpen && preset.relend;
  let relendHint: string;
  if (relend === null) relendHint = failed ? text('autoLend.relendHintUnknown') : text('autoLend.instantReading');
  else if (relend.kind === 'given') relendHint = text('autoLend.relendHintGiven');
  else if (relend.kind === 'vpfi') relendHint = text('autoLend.relendHintVpfi');
  else if (relend.kind === 'full') relendHint = text('autoLend.relendHintFull');
  else if (relend.kind === 'unknown') relendHint = text('autoLend.relendHintUnknown');
  else if (relend.kind === 'no-keeper') relendHint = text('autoLend.relendHintNoKeeper');
  else if (!preset.relend) relendHint = text('autoLend.relendHintOff');
  else relendHint = relend.regain.length > 0 ? text('autoLend.relendRegainLead') : format('autoLend.relendHint', { keeper: facts?.keeper ?? '' });
  const regain = relend !== null && relend.kind === 'grant' && preset.relend ? relend.regain : [];
  const listKey = regain.length > 0 ? regainKey(regain) : null;

  const instantSwitch = (key: 'fills' | 'renewal' | 'takeover', label: string, hint: string) => (
    <div className="field field-check">
      <label>
        <input type="checkbox" checked={off === null && preset[key]} disabled={off !== null} onChange={(e) => set({ [key]: e.target.checked })} data-testid={`autolend-${key}`} />
        <span>{label}</span>
      </label>
      <p className="tier-a field-hint" data-testid={`autolend-${key}-hint`}>
        {off === null ? hint : offText(off)}
      </p>
    </div>
  );

  return (
    <>
      <fieldset className="autolend-preset" data-testid="autolend-preset">
        <legend>{text('autoLend.presetTitle')}</legend>
        <div className="field field-check">
          <label>
            <input type="checkbox" checked={relendChecked} disabled={!relendOpen} onChange={(e) => set({ relend: e.target.checked })} data-testid="autolend-relend" />
            <span>{text('autoLend.relendLabel')}</span>
          </label>
          <p className="tier-a field-hint" data-testid="autolend-relend-hint">
            {relendHint}
          </p>
          {listKey !== null && (
            <>
              <ul className="autolend-regain" data-testid="autolend-regain">
                {regain.map((g) => (
                  <li key={g.keeper}>
                    {format('autoLend.regainLine', {
                      keeper: g.keeper,
                      actions:
                        actionsIn(g.actions).length > 0
                          ? actionsIn(g.actions)
                              .map((a) => text(a.key))
                              .join(', ')
                          : text('autoLend.regainNone'),
                    })}
                  </li>
                ))}
              </ul>
              <label>
                <input type="checkbox" checked={confirmed === listKey} onChange={(e) => onConfirm(e.target.checked ? listKey : null)} data-testid="autolend-regain-confirm" />
                <span>{text('autoLend.relendRegainConfirm')}</span>
              </label>
            </>
          )}
        </div>
        <div className="field field-check">
          <label>
            <input type="checkbox" checked={preset.proRata} onChange={(e) => set({ proRata: e.target.checked })} data-testid="autolend-prorata" />
            <span>{text('autoLend.proRataLabel')}</span>
          </label>
          <p className="tier-a field-hint">
            {text('autoLend.proRataHint')} {text('autoLend.proRataNeeded')}
          </p>
        </div>
        {instantSwitch('fills', text('autoLend.fillsLabel'), text('autoLend.fillsHint'))}
        {instantSwitch('renewal', text('autoLend.renewalLabel'), text('autoLend.renewalHint'))}
        {instantSwitch('takeover', text('autoLend.takeoverLabel'), text('autoLend.takeoverHint'))}
      </fieldset>
      <fieldset className="autolend-more" data-testid="autolend-more">
        <legend>{text('autoLend.moreTitle')}</legend>
        <p className="tier-b">{text('autoLend.moreLead')}</p>
        {(['moreAuction', 'moreAdvance', 'moreBuy'] as const).map((k) => (
          <div className="field field-check" key={k}>
            <label>
              <input type="checkbox" checked={false} disabled data-testid={`autolend-${k}`} />
              <span>{text(`autoLend.${k}`)}</span>
            </label>
            <p className="tier-b field-hint">{text('autoLend.moreNotYet')}</p>
          </div>
        ))}
      </fieldset>
    </>
  );
}
