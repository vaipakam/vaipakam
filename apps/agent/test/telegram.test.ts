import { describe, it, expect } from 'vitest';
import { extractLinkCode, type TelegramUpdate } from '../src/telegram';

function update(text: string): TelegramUpdate {
  return { message: { chat: { id: 42 }, text } };
}

describe('extractLinkCode', () => {
  it('accepts a bare six-digit code (copy-the-code flow)', () => {
    expect(extractLinkCode(update('731741'))).toEqual({
      chatId: '42',
      code: '731741',
    });
  });

  it('accepts the /start deep-link payload (#1056 round 6)', () => {
    // https://t.me/<bot>?start=<code> delivers "/start <code>" when
    // the user presses Start — the advertised one-tap flow.
    expect(extractLinkCode(update('/start 731741'))).toEqual({
      chatId: '42',
      code: '731741',
    });
  });

  it('accepts the bot-mention /start variant', () => {
    expect(extractLinkCode(update('/start@VaipakamBot 731741'))).toEqual({
      chatId: '42',
      code: '731741',
    });
  });

  it('ignores regular chat and malformed payloads', () => {
    for (const text of [
      'hello',
      '/start',
      '/start abcdef',
      '12345',
      '1234567',
      '/help 731741 extra',
    ]) {
      expect(extractLinkCode(update(text))).toBeNull();
    }
  });

  it('ignores updates without a chat id', () => {
    expect(extractLinkCode({ message: { text: '731741' } })).toBeNull();
  });
});
