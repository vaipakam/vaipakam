// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { addPending, bookSnapshot, dropPending, parseBook, provePending, readBook, removeEntry, saveEntry, subscribeBook } from './book';
import { newChallenge } from './proof';

type Hex = `0x${string}`;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const DEST = '0x00000000000000000000000000000000000000a1' as Hex;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;

describe('the saved-address book', () => {
  it('drops entries of the wrong shape', () => {
    const b = parseBook({
      entries: [
        { address: DEST, label: 'Cold', kind: 'wallet', proof: { at: 1, purpose: 'destination' }, exchange: null, savedAt: 1 },
        // A wallet with no proof is not a saved wallet.
        { address: DEST, label: 'Cold', kind: 'wallet', proof: null, exchange: null, savedAt: 1 },
        // An exchange address must carry the exchange's name.
        { address: DEST, label: 'Ex', kind: 'exchange', proof: null, exchange: '  ', savedAt: 1 },
        { address: 'nope', label: 'x', kind: 'exchange', proof: null, exchange: 'X', savedAt: 1 },
      ],
      pending: [{ challenge: { bad: true }, label: 'x' }],
    });
    expect(b.entries).toHaveLength(1);
    expect(b.pending).toHaveLength(0);
  });

  it('saves, replaces and removes entries per network and wallet, and a save ends the request waiting on it', () => {
    const off = subscribeBook(() => undefined);
    const challenge = newChallenge({ chainId: 84532, diamond: DIAMOND, account: ME, destination: DEST, purpose: 'destination' }, 1);
    addPending(84532, ME, { challenge, label: 'Cold' });
    expect(bookSnapshot(84532, ME).pending).toHaveLength(1);
    saveEntry(84532, ME, { address: DEST, label: 'Cold', kind: 'wallet', proof: { at: 2, purpose: 'destination' }, exchange: null, savedAt: 2 });
    expect(bookSnapshot(84532, ME)).toMatchObject({ entries: [{ label: 'Cold' }], pending: [] });
    saveEntry(84532, ME, { address: DEST, label: 'Cold 2', kind: 'wallet', proof: { at: 3, purpose: 'destination' }, exchange: null, savedAt: 3 });
    expect(readBook(84532, ME).entries.map((e) => e.label)).toEqual(['Cold 2']);
    expect(readBook(421614, ME).entries).toHaveLength(0);
    removeEntry(84532, ME, DEST);
    expect(readBook(84532, ME).entries).toHaveLength(0);
    off();
  });

  it('saves a proven wallet only while that exact request is still waiting', () => {
    const entry = { address: DEST, label: 'Cold', kind: 'wallet' as const, proof: { at: 2, purpose: 'destination' as const }, exchange: null, savedAt: 2 };
    const ask = () => ({
      challenge: newChallenge({ chainId: 10, diamond: DIAMOND, account: ME, destination: DEST, purpose: 'destination' }, 1),
      label: 'Cold',
    });
    const first = ask();
    addPending(10, ME, first);
    dropPending(10, ME, DEST);
    expect(provePending(10, ME, first, entry)).toBe(false);
    addPending(10, ME, first);
    const second = ask();
    addPending(10, ME, second);
    expect(provePending(10, ME, first, entry)).toBe(false);
    expect(readBook(10, ME).entries).toHaveLength(0);
    expect(provePending(10, ME, second, entry)).toBe(true);
    expect(readBook(10, ME)).toMatchObject({ entries: [{ label: 'Cold' }], pending: [] });
  });
});
