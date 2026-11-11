/**
 * The one seam through which a pass reaches a subscriber (#2569 r4): a
 * Telegram message, a Push notification, or both, for one alert.
 *
 * TELEGRAM GOES THROUGH THE AGENT (#1722). The keeper holds neither the bot
 * token nor any chat id. An alert's Telegram half is DATA (a
 * `TelegramAlert`), posted to the agent's keeper route, which sends it to the
 * chat the owner linked, in the protocol's own wording, or answers `off` when
 * no chat is linked. Push still goes out from here, with the text the pass
 * rendered from the same shared catalogue.
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
import { redactedError } from '@vaipakam/lib/errorDescription';
import type { AddressedAlert } from '@vaipakam/lib/telegramAlerts/message';
import { agentClientOf, AgentDiamondMismatch, AgentRequestFailed, agentUnconfiguredReason, type AgentClient } from './agentClient';

/** An alert's Telegram half: the message as data, and the Diamond the keeper
 *  serves on its chain (the agent refuses any other). */
export interface TelegramPart {
  readonly diamond: string;
  readonly message: AddressedAlert;
}

export interface Alert {
  /** The alert for the owner's Telegram chat, sent by the agent to the chat
   *  linked to `message.to ?? message.wallet`, if any. */
  readonly telegram?: TelegramPart | null;
  /** The subscriber's wallet, for Push, when they subscribed to the channel. */
  readonly pushSubscriber?: string | null;
  /** The Push body (the same wording the agent renders for Telegram). */
  readonly text: string;
  readonly pushTitle: string;
  readonly deepLinkUrl: string;
}

type AlertEnv = Pick<Env, 'AGENT_ORIGIN' | 'KEEPER_AGENT_TOKEN' | 'PUSH_CHANNEL_PK' | 'PUSH_CHANNEL_ADDRESS'>;


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

/**
 * What one channel did with an alert: `sent` (accepted), `retry` (refused for
 * now, or a send that may not have gone), `refused` (refused for good, or a
 * channel that cannot send at all), or `off` (the subscriber has no such
 * channel: no chat linked, not subscribed to Push, or no agent configured).
 */
export type ChannelResult = 'sent' | 'retry' | 'refused' | 'off';

/** What `deliver` did on each channel. */
export interface DeliveryOutcome {
  telegram: ChannelResult;
  push: ChannelResult;
}

/** At least one channel accepted the alert. */
export function delivered(o: DeliveryOutcome): boolean {
  return o.telegram === 'sent' || o.push === 'sent';
}

/** No channel accepted it, and one may on another try. */
export function worthRetrying(o: DeliveryOutcome): boolean {
  return !delivered(o) && (o.telegram === 'retry' || o.push === 'retry');
}

/** One pass's alerts: deliver each, then `disclose` once. */
export class AlertDelivery {
  private readonly push: PushRailConfig;
  private readonly agent: AgentClient | null;
  private notRequested = 0;
  private failed = 0;
  /** Telegram halves not sent because no agent is configured. */
  private agentUnset = 0;
  /** Telegram halves the agent did not answer usably. */
  private agentFailed = 0;
  private agentFailure = '';

  /** `agent` overrides the one configured from `env` (tests). */
  constructor(private readonly env: AlertEnv, agent?: AgentClient | null) {
    this.push = pushRailConfigOf(env);
    this.agent = agent === undefined ? agentClientOf(env) : agent;
  }

  /** Deliver `alert` on every channel the subscriber has; the fence first.
   *  Says what each channel did, for a caller that must know whether the
   *  alert arrived (most callers ignore it). */
  async deliver(alert: Alert): Promise<DeliveryOutcome> {
    await assertEpochsHold();
    const outcome: DeliveryOutcome = { telegram: 'off', push: 'off' };
    if (alert.telegram) outcome.telegram = await this.sendTelegram(alert.telegram);
    if (alert.pushSubscriber) {
      const attempt = await sendPush(this.push, {
        subscriber: alert.pushSubscriber,
        title: alert.pushTitle,
        body: alert.text,
        deepLinkUrl: alert.deepLinkUrl,
      });
      if (attempt === 'not-requested') this.notRequested += 1;
      else if (attempt === 'failed') this.failed += 1;
      outcome.push = attempt === 'accepted' ? 'sent' : attempt === 'failed' ? 'retry' : 'refused';
    }
    return outcome;
  }

  /** The Telegram half, through the agent. A Diamond mismatch throws, like
   *  the epoch fence's refusal: the keeper's build and the agent's disagree on
   *  the chain's Diamond, and no alert may go out about either. */
  private async sendTelegram(t: TelegramPart): Promise<ChannelResult> {
    if (this.agent === null) {
      this.agentUnset += 1;
      return 'off';
    }
    try {
      const [result] = await this.agent.sendAlerts(t.message.chainId, t.diamond, [t.message]);
      return result ?? 'retry';
    } catch (err) {
      if (err instanceof AgentDiamondMismatch) throw err;
      this.agentFailed += 1;
      this.agentFailure = redactedError(err, { stack: false }).slice(0, 160);
      return err instanceof AgentRequestFailed && err.permanent ? 'refused' : 'retry';
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
    if (this.agentUnset > 0) {
      console.warn(
        `[${pass}] Telegram unavailable (${agentUnconfiguredReason(this.env) ?? 'no agent'}): ${this.agentUnset} alert(s) not sent by Telegram this pass`,
      );
    }
    if (this.agentFailed > 0) {
      console.warn(`[${pass}] ${this.agentFailed} Telegram alert(s) not taken by the agent this pass (last: ${this.agentFailure})`);
    }
  }
}
