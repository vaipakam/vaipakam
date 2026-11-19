/**
 * #3346 — setting the alert phrase: the field rule, the change notices, and
 * that a change is told with the OLD phrase to each linked chat once.
 */
import { describe, expect, it } from 'vitest';
import { applyAlertPhrase, parsePhraseField, phraseChangeNotice } from '../src/alertPhraseRoute';
import { TelegramStateStore } from '../src/telegramState/store';
import { sqliteDo } from './helpers/sqliteDo';

const W = '0xAbC0000000000000000000000000000000000001';

describe('parsePhraseField', () => {
  it('takes null as a removal and refuses an unacceptable phrase', () => {
    expect(parsePhraseField(null)).toEqual({ ok: true, phrase: null });
    expect(parsePhraseField('  blue  heron ')).toEqual({ ok: true, phrase: 'blue heron' });
    expect(parsePhraseField('https://x.example')).toEqual({ ok: false });
    expect(parsePhraseField(undefined)).toEqual({ ok: false });
  });
});

describe('phraseChangeNotice', () => {
  it('a first phrase shows the new one; a change or removal shows the old one', () => {
    expect(phraseChangeNotice(null, 'blue heron')).toMatch(/^Your Vaipakam phrase: blue heron\n/);
    expect(phraseChangeNotice('blue heron', 'red kite')).toMatch(/^Your Vaipakam phrase: blue heron\n\nYour alert phrase was changed/);
    expect(phraseChangeNotice('blue heron', null)).toMatch(/^Your Vaipakam phrase: blue heron\n\nYour alert phrase was removed/);
    expect(phraseChangeNotice('same', 'same')).toBeNull();
    expect(phraseChangeNotice('red kite', 'blue heron')).not.toContain('Your Vaipakam phrase: blue heron');
  });
});

describe('applyAlertPhrase', () => {
  it('stores on every chain and tells a chat linked on several chains once', async () => {
    const h = sqliteDo();
    const store = new TelegramStateStore(h.sql, h.tx);
    store.commit(W, 1, [], [{ op: 'link', chainId: 1, chatId: '7' }], 1);
    store.commit(W, 2, [], [{ op: 'link', chainId: 2, chatId: '7' }], 1);
    const sent: { chat: string; text: string }[] = [];
    const deps = {
      setPhrase: async (w: string, ids: number[], p: string | null, at: number) => store.setPhrase(w, ids, p, at),
      send: async (chat: string, text: string) => {
        sent.push({ chat, text });
        return 'accepted';
      },
    };
    expect(await applyAlertPhrase(deps, W, [1, 2, 3], 'blue heron', 10)).toEqual({ told: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Your Vaipakam phrase: blue heron');
    sent.length = 0;
    expect(await applyAlertPhrase(deps, W, [1, 2, 3], 'red kite', 11)).toEqual({ told: 1 });
    expect(sent[0]!.text).toMatch(/^Your Vaipakam phrase: blue heron\n/);
    expect(sent[0]!.text).not.toContain('red kite');
    sent.length = 0;
    expect(await applyAlertPhrase(deps, W, [1, 2, 3], 'red kite', 12)).toEqual({ told: 0 });
    expect(await applyAlertPhrase({ ...deps, send: null }, W, [1], null, 13)).toEqual({ told: 0 });
    expect(store.phrasesOf([{ wallet: W, chainId: 1 }])).toEqual([null]);
  });
});
