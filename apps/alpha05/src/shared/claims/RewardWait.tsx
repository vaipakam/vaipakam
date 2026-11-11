import { useCopy } from '../copy/useCopy';
import { useOwnRead } from '../reads/useOwnRead';
import { readWaitDetail, waitLines } from './rewardWait';

type Hex = `0x${string}`;

/**
 * RW-28 — under a claim that waits on a day, what that day waits on, read at
 * the claim preview's own block: the finalisation's readiness on a home
 * network; on a mirror, the home network's figures or the day's funding (how
 * much of the declared whole has landed, and a conflicted day's disclosure).
 * Ends with the line that later days wait behind it and that no step of the
 * wallet's own clears it. A read that fails is stated, never guessed.
 */
export function RewardWait({
  diamond,
  day,
  why,
  atBlock,
  amount,
}: {
  diamond: Hex;
  day: bigint;
  why: 'global' | 'delivery';
  atBlock: bigint;
  amount: (v: bigint) => string;
}) {
  const { text, format } = useCopy();
  const detail = useOwnRead(['rewardsWait', diamond, day.toString(), why, atBlock.toString()], (c) => readWaitDetail(c, diamond, day, why, atBlock));
  const d = detail.data;
  if (d === null) {
    if (detail.state === 'failed')
      return (
        <p className="tier-b" data-testid="rewards-wait" data-wait="failed">
          {format('rewardsWait.failed', { day: day.toString(), reason: detail.error ?? 'no answer' })}
        </p>
      );
    return null;
  }
  return (
    <div data-testid="rewards-wait" data-wait={d.kind}>
      {waitLines(day, d).map((l) => (
        <p key={l.key} className={l.key === 'rewardsWait.conflict' ? 'tier-a' : 'tier-b'} data-wait-line={l.key.slice('rewardsWait.'.length)}>
          {l.vars || l.amounts
            ? format(l.key, { ...l.vars, ...Object.fromEntries(Object.entries(l.amounts ?? {}).map(([k, v]) => [k, amount(v)])) })
            : text(l.key)}
        </p>
      ))}
    </div>
  );
}
