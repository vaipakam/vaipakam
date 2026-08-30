/**
 * The four alert-family message formats are FROZEN (#2014, following
 * the erasure family's #2002 discipline): every signature ever
 * collected was made over these exact bytes, and the agent Worker
 * reconstructs each message verbatim to recover the signer — a
 * drifted character rejects every affected request. Pinned verbatim
 * so any edit to a builder fails here first, and pinned as MUTUALLY
 * DISTINCT so no signature can ever cross actions.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDueDateOptOutMessage,
  buildTelegramLinkMessage,
  buildTelegramTestMessage,
  buildTelegramUnlinkMessage,
} from './alertsMessage';

const WALLET = '0x1DAefA360ED370285f003Fa2d92DB75628088282';
const LOWER = '0x1daefa360ed370285f003fa2d92db75628088282';

describe('buildTelegramLinkMessage', () => {
  it('produces the frozen byte sequence, verbatim', () => {
    expect(buildTelegramLinkMessage(WALLET, 84532, 1747000000)).toBe(
      'Vaipakam — Link Telegram alerts\n' +
        '\n' +
        'I authorise Telegram alert delivery for the wallet below to the\n' +
        'chat that completes this link code. Signing this message proves\n' +
        'ownership of the wallet. It is not a transaction and costs no gas.\n' +
        '\n' +
        `Wallet: ${LOWER}\n` +
        'Chain id: 84532\n' +
        'Issued at (unix): 1747000000',
    );
  });
});

describe('buildTelegramUnlinkMessage', () => {
  it('produces the frozen byte sequence, verbatim', () => {
    expect(buildTelegramUnlinkMessage(WALLET, 84532, 1747000000)).toBe(
      'Vaipakam — Unlink Telegram alerts\n' +
        '\n' +
        'I request that Telegram alert delivery for the wallet below be\n' +
        'disconnected. Signing this message proves ownership of the\n' +
        'wallet. It is not a transaction and costs no gas.\n' +
        '\n' +
        `Wallet: ${LOWER}\n` +
        'Chain id: 84532\n' +
        'Issued at (unix): 1747000000',
    );
  });

  it('claims no scope beyond the chain it names (#2013 round 4 P1)', () => {
    // The effect's scope follows the signer's authority — an ECDSA
    // key clears the wallet everywhere, a smart account's
    // chain-verified approval clears only this chain — so the signed
    // text must promise neither. A reintroduced "everywhere" would
    // make the chain-scoped outcome a false confirmation.
    expect(buildTelegramUnlinkMessage(WALLET, 84532, 1)).not.toContain('everywhere');
  });
});

describe('buildDueDateOptOutMessage', () => {
  it('produces the frozen byte sequence, verbatim', () => {
    expect(buildDueDateOptOutMessage(WALLET, 84532, 1747000000)).toBe(
      'Vaipakam — Mute due-date payment reminders\n' +
        '\n' +
        'I request that payment due-date reminders for the wallet below\n' +
        'be switched off. Signing this message proves ownership of the\n' +
        'wallet. It is not a transaction and costs no gas.\n' +
        '\n' +
        `Wallet: ${LOWER}\n` +
        'Chain id: 84532\n' +
        'Issued at (unix): 1747000000',
    );
  });
});

describe('buildTelegramTestMessage', () => {
  it('produces the frozen byte sequence, verbatim', () => {
    expect(buildTelegramTestMessage(WALLET, 84532, 1747000000)).toBe(
      'Vaipakam — Send a test alert\n' +
        '\n' +
        'I request one test alert be sent to the Telegram chat linked to\n' +
        'the wallet below, to confirm delivery works. Signing this message\n' +
        'proves ownership of the wallet. It is not a transaction and costs\n' +
        'no gas.\n' +
        '\n' +
        `Wallet: ${LOWER}\n` +
        'Chain id: 84532\n' +
        'Issued at (unix): 1747000000',
    );
  });
});

describe('the four messages as a family', () => {
  const builders = [
    buildTelegramLinkMessage,
    buildTelegramUnlinkMessage,
    buildDueDateOptOutMessage,
    buildTelegramTestMessage,
  ];

  it('are mutually distinct — no signature can cross actions', () => {
    // Same wallet, same chain, same timestamp: only the wording
    // separates them, which is exactly what the agent's per-action
    // verification relies on.
    const msgs = builders.map((b) => b(WALLET, 84532, 1));
    expect(new Set(msgs).size).toBe(builders.length);
  });

  it('lower-case the wallet so checksummed and lowercase spellings sign identically', () => {
    for (const build of builders) {
      expect(build(WALLET, 84532, 1)).toBe(build(LOWER, 84532, 1));
    }
  });

  it('bind the chain id — a signature for one chain is not one for another', () => {
    for (const build of builders) {
      expect(build(WALLET, 84532, 1)).not.toBe(build(WALLET, 421614, 1));
    }
  });
});
