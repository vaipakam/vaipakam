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
 *
 * Push goes out through the shared rail, `@vaipakam/push` (#2248), the same
 * implementation the agent sends with, so a correction to the rail lands
 * once. That rail answers every send (`PushAttempt`) and stays silent when it
 * cannot send at all, since an unset or malformed signer fails identically
 * for every subscriber. So one delivery is made per PASS: it counts the
 * answers and `disclose` reports them in one line, with the reason the rail
 * gave. The keeper's own copy logged a "skipping" line per subscriber
 * instead, and logged nothing when a send failed except the error itself.
 */
import { publishedRailRow, pushRailStatus, sendPush, type PushRailConfig } from '@vaipakam/push';
import { publishPushRailStatus } from './db';
import type { Env } from './env';
import { assertEpochsHold } from './epochFence';
import { sendMessage as sendTelegramMessage } from './telegram';
import { redactedError } from '@vaipakam/lib/errorDescription';

export interface Alert {
  /** The subscriber's Telegram chat, when they linked one. */
  readonly tgChatId?: string | null;
  /** The subscriber's wallet, for Push, when they subscribed to the channel. */
  readonly pushSubscriber?: string | null;
  readonly text: string;
  readonly pushTitle: string;
  readonly deepLinkUrl: string;
}

type AlertEnv = Pick<Env, 'TG_BOT_TOKEN' | 'PUSH_CHANNEL_PK' | 'PUSH_CHANNEL_ADDRESS'>;


/** This keeper's Push rail configuration, read from its env in ONE place. */
export function pushRailConfigOf(env: Pick<Env, 'PUSH_CHANNEL_PK' | 'PUSH_CHANNEL_ADDRESS'>): PushRailConfig {
  return { channelPk: env.PUSH_CHANNEL_PK, channelAddress: env.PUSH_CHANNEL_ADDRESS };
}

/**
 * Publish this keeper's rail status for the agent (#2667), read from the same
 * configuration the sends use. Contained: a failed write (the table not yet
 * migrated, a D1 outage) is logged and the pass carries on; the agent then
 * finds the row stale and says it does not know, rather than trusting it.
 */
export async function publishRailStatus(
  env: Pick<Env, 'DB' | 'PUSH_CHANNEL_PK' | 'PUSH_CHANNEL_ADDRESS'>,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  try {
    await publishPushRailStatus(env.DB, publishedRailRow(pushRailStatus(pushRailConfigOf(env)), nowSec));
  } catch (err) {
    console.warn(`[keeper] Push rail status not published this run: ${redactedError(err, { stack: false }).slice(0, 200)}`);
  }
}

/** One pass's alerts: deliver each, then `disclose` once. */
export class AlertDelivery {
  private readonly push: PushRailConfig;
  private notRequested = 0;
  private failed = 0;

  constructor(private readonly env: AlertEnv) {
    this.push = pushRailConfigOf(env);
  }

  /** Deliver `alert` on every channel the subscriber has; the fence first. */
  async deliver(alert: Alert): Promise<void> {
    await assertEpochsHold();
    if (alert.tgChatId && this.env.TG_BOT_TOKEN) {
      await sendTelegramMessage(this.env.TG_BOT_TOKEN, alert.tgChatId, alert.text);
    }
    if (alert.pushSubscriber) {
      const attempt = await sendPush(this.push, {
        subscriber: alert.pushSubscriber,
        title: alert.pushTitle,
        body: alert.text,
        deepLinkUrl: alert.deepLinkUrl,
      });
      if (attempt === 'not-requested') this.notRequested += 1;
      else if (attempt === 'failed') this.failed += 1;
    }
  }

  /**
   * Say, once, what Push did not do this pass. Nothing is printed when every
   * Push alert was accepted, or there were none. An alert the rail could not
   * send is counted with the rail's reason (the signer unset, malformed or
   * unable to sign as the SDK needs, or the channel address malformed); a
   * failed send is counted separately, because a request may have gone and
   * nobody can say it arrived. The subscriber is not named: the rail logs its
   * own failures, with the address, as they happen.
   */
  disclose(pass: string): void {
    if (this.notRequested > 0) {
      const rail = pushRailStatus(this.push);
      const reason = rail.usable ? 'became usable during the pass' : rail.reason;
      console.warn(
        `[${pass}] Push rail unavailable (${reason}): ${this.notRequested} alert(s) not sent by Push this pass`,
      );
    }
    if (this.failed > 0) {
      console.warn(`[${pass}] ${this.failed} Push send(s) failed this pass; not counted as delivered`);
    }
  }
}
