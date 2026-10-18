/**
 * The one seam through which a pass reaches a subscriber (#2569 r4): a
 * Telegram message, a Push notification, or both, for one alert.
 *
 * Both watchers used to call the two senders themselves. Routing every alert
 * through here is what lets the epoch fence (`epochFence.ts`) hold for
 * alerts the way it holds for transactions and database writes: the fence
 * is asserted once per alert, before either channel is touched, so a pass
 * still running after the indexer moved to a new Diamond cannot tell a
 * subscriber about a loan id that now belongs to another borrower.
 */
import type { Env } from './env';
import { assertEpochsHold } from './epochFence';
import { sendPush } from './push';
import { sendMessage as sendTelegramMessage } from './telegram';

export interface Alert {
  /** The subscriber's Telegram chat, when they linked one. */
  readonly tgChatId?: string | null;
  /** The subscriber's wallet, for Push, when they subscribed to the channel. */
  readonly pushSubscriber?: string | null;
  readonly text: string;
  readonly pushTitle: string;
  readonly deepLinkUrl: string;
}

/** Deliver `alert` on every channel the subscriber has; the fence first. */
export async function deliverAlert(
  env: Pick<Env, 'TG_BOT_TOKEN' | 'PUSH_CHANNEL_PK'>,
  alert: Alert,
): Promise<void> {
  await assertEpochsHold();
  if (alert.tgChatId && env.TG_BOT_TOKEN) {
    await sendTelegramMessage(env.TG_BOT_TOKEN, alert.tgChatId, alert.text);
  }
  if (alert.pushSubscriber) {
    await sendPush(env.PUSH_CHANNEL_PK, {
      subscriber: alert.pushSubscriber,
      title: alert.pushTitle,
      body: alert.text,
      deepLinkUrl: alert.deepLinkUrl,
    });
  }
}
