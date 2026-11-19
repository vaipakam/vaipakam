/**
 * #3346 — the owner's anti-phishing phrase: `PUT /alerts/phrase`.
 *
 * The owner signs a message naming the phrase (or its removal); the phrase
 * is kept in the agent's private Telegram state, never in the shared
 * database, and every Telegram alert to the owner then starts with it
 * (`withAlertPhrase`). Push notifications never carry it: they are not
 * private to the owner.
 *
 * Scope follows the signer's authority, as unlinking does (#2013): a plain
 * wallet signature sets the phrase on every chain this deployment serves; a
 * smart account's approval, verified on the signed chain only, sets it on
 * that chain alone.
 *
 * Every change is told to the chats linked where it applied. A change or a
 * removal carries the OLD phrase, which a phisher cannot know, so the owner
 * can trust the notice; a first phrase carries the new one, so the owner sees
 * how every later alert will look.
 */
import { normaliseAlertPhrase, withAlertPhrase } from '@vaipakam/lib/alertPhrase';
import type { PhraseChange } from './telegramState/store';

/** The parsed phrase field: a normalised phrase, null to remove, or a
 *  refusal. */
export function parsePhraseField(raw: unknown): { ok: true; phrase: string | null } | { ok: false } {
  if (raw === null) return { ok: true, phrase: null };
  const phrase = normaliseAlertPhrase(raw);
  return phrase === null ? { ok: false } : { ok: true, phrase };
}

/** The notice a chat is sent when the phrase on its chain changes from
 *  `oldPhrase` to `newPhrase`, or null when nothing changed. */
export function phraseChangeNotice(oldPhrase: string | null, newPhrase: string | null): string | null {
  if (oldPhrase === newPhrase) return null;
  if (oldPhrase === null) {
    return withAlertPhrase(
      'Your alert phrase is set. Every Telegram alert from Vaipakam now starts with it. A message without it did not come from us.',
      newPhrase,
    );
  }
  const what = newPhrase === null ? 'was removed' : 'was changed';
  return withAlertPhrase(
    `Your alert phrase ${what}. This notice starts with your previous phrase, so you know it came from us. ` +
      'If you did not make this change, someone controls your wallet: turn on protected mode in the app, so payouts from your vault wait before they leave.',
    oldPhrase,
  );
}

export interface PhraseDeps {
  setPhrase: (wallet: string, chainIds: number[], phrase: string | null, now: number) => Promise<PhraseChange[]>;
  /** Null when no bot is configured: the change is stored and nobody is told. */
  send: ((chat: string, text: string) => Promise<string>) | null;
}

/** Store the phrase on `chainIds` and tell each linked chat once. Returns
 *  how many notices Telegram accepted. A chat linked on several chains with
 *  the same previous phrase is told once. */
export async function applyAlertPhrase(
  deps: PhraseDeps,
  wallet: string,
  chainIds: number[],
  phrase: string | null,
  now: number,
): Promise<{ told: number }> {
  const changes = await deps.setPhrase(wallet, chainIds, phrase, now);
  if (!deps.send) return { told: 0 };
  const seen = new Set<string>();
  let told = 0;
  for (const c of changes) {
    if (c.chatId === null) continue;
    const text = phraseChangeNotice(c.oldPhrase, phrase);
    if (text === null) continue;
    const key = `${c.chatId}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const out = await deps.send(c.chatId, text).catch(() => 'failed');
    if (out === 'accepted') told += 1;
  }
  return { told };
}
