/**
 * ACC-34 — what a keeper change says before the signature: what it sets,
 * for whom, that it moves no funds, and what a keeper can and cannot do.
 */
import type { CopyAccess } from '../copy/useCopy';
import type { Receipt } from '../receipt/types';
import { shortAddress } from '../ui/format';
import { ACCOUNT_ACTIONS, actionsIn, type KeeperChange, type KeeperSettings } from './keepers';

type Copy = Pick<CopyAccess, 'text' | 'format'>;

/** A keeper's name in a sentence: this app's keeper on the network, or its
 *  short address. */
export function keeperName(keeper: string, network: string | null, chain: string, copy: Copy): string {
  return network !== null && network.toLowerCase() === keeper.toLowerCase()
    ? copy.format('keepers.networkKeeper', { chain, address: shortAddress(keeper) })
    : shortAddress(keeper);
}

/** A mask's actions as one line. */
export function actionsLine(mask: number, copy: Copy): string {
  const list = actionsIn(mask);
  return list.length === 0 ? copy.text('keepers.noActions') : list.map((a) => copy.text(a.key)).join(' · ');
}

const TITLES = { accessOn: 'keepers.titleAccessOn', accessOff: 'keepers.titleAccessOff', approve: 'keepers.titleApprove', actions: 'keepers.titleActions', revoke: 'keepers.titleRevoke' } as const;

export function keeperReceipt(c: KeeperChange, s: KeeperSettings, copy: Copy, opts: { chain: string; network: string | null; readAt: number }): Receipt {
  const { text, format } = copy;
  const where = { label: text('keepers.rowWhere'), value: { kind: 'text' as const, text: format('keepers.where', { chain: opts.chain }) }, binding: true };
  const moves = { label: text('risk.rowMoves'), value: { kind: 'text' as const, text: text('keepers.movesNone') }, binding: true };
  if (c.kind === 'access') {
    return {
      title: text(c.on ? TITLES.accessOn : TITLES.accessOff),
      rows: [{ label: text('keepers.rowAccess'), value: { kind: 'text', text: text(c.on ? 'keepers.on' : 'keepers.off') }, binding: true }, where, moves],
      consequences: c.on ? [text('keepers.inertAlone'), text('keepers.neverFunds')] : [text('keepers.offStops')],
      prompts: 1,
      readAt: opts.readAt,
    };
  }
  const name = { label: text('keepers.rowKeeper'), value: { kind: 'text' as const, text: keeperName(c.keeper, opts.network, opts.chain, copy), exact: c.keeper }, binding: true };
  if (c.kind === 'revoke') {
    return { title: text(TITLES.revoke), rows: [name, where, moves], consequences: [text('keepers.revokeStops')], prompts: 1, readAt: opts.readAt };
  }
  const held = s.keepers.find((k) => k.keeper.toLowerCase() === c.keeper.toLowerCase())?.actions ?? 0;
  const rows: Receipt['rows'] =
    c.kind === 'approve'
      ? [name, { label: text('keepers.rowActions'), value: { kind: 'text', text: actionsLine(c.actions, copy) }, binding: true }, where, moves]
      : [
          name,
          { label: text('keepers.rowBefore'), value: { kind: 'text', text: actionsLine(held, copy) }, binding: true },
          { label: text('keepers.rowAfter'), value: { kind: 'text', text: actionsLine(c.actions, copy) }, binding: true },
          where,
          moves,
        ];
  const consequences = [text('keepers.inertAlone'), text('keepers.neverFunds')];
  if ((c.actions & ACCOUNT_ACTIONS & ~(c.kind === 'actions' ? held : 0)) !== 0) consequences.push(text('keepers.accountWideNote'));
  if (!s.access) consequences.push(text('keepers.accessOffNote'));
  return { title: text(c.kind === 'approve' ? TITLES.approve : TITLES.actions), rows, consequences, prompts: 1, readAt: opts.readAt };
}
