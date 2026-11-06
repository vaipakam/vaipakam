import { useId, useRef } from 'react';
import { useCopy, type CopyKey } from '../copy/useCopy';
import { Icon } from '../ui/Icon';
import { useHelp } from './HelpContext';

/**
 * RB-HELP — a one-line summary (tier B) followed by the info button
 * "(i)" (RB-ICONS) that opens the help panel on the full explanation
 * (tier C) of the SAME copy key family. The button shows only the icon,
 * right after the sentence it explains; its accessible name is "Why?"
 * and its description is that sentence, so a screen reader hears both,
 * and its tap area is 44 px whatever the icon's drawn size. Both are keys, so the inline line, the panel and every
 * locale bundle agree. Tooltips are not used (touch screens, screen
 * readers, length).
 */
export function WhyLink({
  summaryKey,
  detailKey,
  vars,
  extra,
}: {
  summaryKey: CopyKey;
  detailKey: CopyKey;
  /** Placeholder values for the summary's `{{name}}`s. */
  vars?: Readonly<Record<string, string>>;
  /** A sentence appended after the summary (already translated). */
  extra?: string;
}) {
  const { entry, text, format } = useCopy();
  const { open } = useHelp();
  const ref = useRef<HTMLButtonElement>(null);
  const summaryId = useId();
  const summary = vars ? { ...entry(summaryKey), text: format(summaryKey, vars) } : entry(summaryKey);
  if (summary.tier === 'C') throw new Error(`WhyLink: "${summaryKey}" is tier C and cannot be inline`);
  if (entry(detailKey).tier !== 'C') throw new Error(`WhyLink: "${detailKey}" must be tier C`);
  return (
    <p className={`why ${summary.tier === 'A' ? 'tier-a' : 'tier-b'}`}>
      <span id={summaryId}>
        {summary.text}
        {extra ? ` ${extra}` : ''}
      </span>{' '}
      <button
        ref={ref}
        type="button"
        className="why-link"
        aria-label={text('help.why')}
        aria-describedby={summaryId}
        onClick={() => open({ summaryKey, detailKey, vars, returnTo: ref.current })}
      >
        <Icon meaning="why" size={18} />
      </button>
    </p>
  );
}
