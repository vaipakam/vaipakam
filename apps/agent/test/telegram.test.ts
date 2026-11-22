import { describe, it, expect } from 'vitest';
import {
  LINK_CODE_ALPHABET,
  LINK_CODE_LENGTH,
  extractLinkCode,
  isTelegramDelivery,
  newLinkCode,
  webhookSecret,
  type TelegramUpdate,
} from '../src/telegram';
// @ts-expect-error — a plain .mjs operator script, no declarations.
import { webhookSecretFor } from '../scripts/register-telegram-webhook.mjs';

function update(text: string): TelegramUpdate {
  return { message: { chat: { id: 42 }, text } };
}

describe('extractLinkCode', () => {
  // A code as `newLinkCode()` issues it (#2753): 24 symbols, no 0/1/I/O.
  const CODE = 'K7MQ2XRTH4NPWZ9DBC3FJ8LV';

  it('accepts a bare code (copy-the-code flow)', () => {
    expect(extractLinkCode(update(CODE))).toEqual({ chatId: '42', code: CODE });
  });

  it('accepts the /start deep-link payload (#1056 round 6)', () => {
    // https://t.me/<bot>?start=<code> delivers "/start <code>" when
    // the user presses Start — the advertised one-tap flow.
    expect(extractLinkCode(update(`/start ${CODE}`))).toEqual({ chatId: '42', code: CODE });
  });

  it('accepts the bot-mention /start variant', () => {
    expect(extractLinkCode(update(`/start@VaipakamBot ${CODE}`))).toEqual({
      chatId: '42',
      code: CODE,
    });
  });

  it('reads a typed code case-blind and returns it as issued', () => {
    expect(extractLinkCode(update(CODE.toLowerCase()))).toEqual({ chatId: '42', code: CODE });
  });

  it('ignores regular chat and malformed payloads', () => {
    for (const text of [
      'hello',
      '/start',
      '731741', // the retired six-digit shape
      CODE.slice(1), // one symbol short
      `${CODE}A`, // one symbol long
      CODE.replace('K', '0'), // a symbol outside the alphabet
      `/help ${CODE}`,
      `/start ${CODE} extra`,
    ]) {
      expect(extractLinkCode(update(text))).toBeNull();
    }
  });

  it('ignores updates without a chat id', () => {
    expect(extractLinkCode({ message: { text: CODE } })).toBeNull();
  });
});

describe('newLinkCode (#2753)', () => {
  it('issues 24 symbols from the alphabet, and the bot reads what it issues', () => {
    for (let i = 0; i < 50; i++) {
      const code = newLinkCode();
      expect(code).toHaveLength(LINK_CODE_LENGTH);
      for (const c of code) expect(LINK_CODE_ALPHABET).toContain(c);
      expect(extractLinkCode({ message: { chat: { id: 1 }, text: code } })?.code).toBe(code);
    }
  });

  it('uses all 32 symbols, five bits each', () => {
    // 120 bits rests on the alphabet being exactly 32 distinct symbols.
    expect(new Set(LINK_CODE_ALPHABET).size).toBe(32);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) for (const c of newLinkCode()) seen.add(c);
    expect(seen.size).toBe(32);
  });
});

describe('Telegram webhook secret (#2753)', () => {
  const TOKEN = '123456:test-token-not-a-real-bot-token-xxxxxxxx';
  const delivery = (secret?: string) =>
    new Request('https://agent.test/tg/webhook', {
      method: 'POST',
      headers: secret === undefined ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret },
    });

  it('accepts only a delivery carrying the derived secret', async () => {
    const secret = await webhookSecret(TOKEN);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await isTelegramDelivery(delivery(secret), TOKEN)).toBe(true);
    expect(await isTelegramDelivery(delivery(), TOKEN)).toBe(false);
    expect(await isTelegramDelivery(delivery(''), TOKEN)).toBe(false);
    expect(await isTelegramDelivery(delivery(secret.slice(0, -1)), TOKEN)).toBe(false);
    const flipped = `${secret.slice(0, -1)}${secret.endsWith('a') ? 'b' : 'a'}`;
    expect(await isTelegramDelivery(delivery(flipped), TOKEN)).toBe(false);
    // A token rotation changes the secret, so an old registration stops.
    expect(await isTelegramDelivery(delivery(secret), `${TOKEN}y`)).toBe(false);
  });

  it('is the value the registration script registers', async () => {
    // The agent checks what the operator script registers; the two
    // derivations must give one value, or every delivery is refused.
    expect(webhookSecretFor(TOKEN)).toBe(await webhookSecret(TOKEN));
  });
});
