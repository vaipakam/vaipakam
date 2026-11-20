// apps/keeper/src/ownerAlertSend.ts
//
// One owner alert to one wallet's channels, as the protected-account alert
// steps send it (#3346, #3756): Telegram always (only the agent knows whether
// the wallet linked a chat, and it answers `off` when not), Push only to a
// subscriber. The message names the account it is about (`wallet`) and, when
// another wallet receives it (a manager, a signer), that wallet (`to`).

import type { Address } from 'viem';
import { renderTelegramAlert, type AddressedAlert, type TelegramAlert } from '@vaipakam/lib/telegramAlerts/message';
import { delivered, worthRetrying, type Alert, type DeliveryOutcome } from './alertDelivery';
import { PastRunDeadline } from './batchRead';
import { EpochFenceRefusal } from './epochFence';

export interface OwnerAlertSendDeps {
  chainId: number;
  diamond: Address;
  subscriber: (wallet: Address) => Promise<{ push: boolean; locale: string | null } | null>;
  notify: (alert: Alert) => Promise<DeliveryOutcome>;
  appOrigin: string;
}

/** How a send ended: a channel took it; none did but one may on another try;
 *  or nobody can be told (no chat, no Push, or every channel refused for good). */
export type SendResult = 'sent' | 'retry' | 'nobody';

export async function sendOwnerAlert(d: OwnerAlertSendDeps, account: Address, to: Address, alert: TelegramAlert): Promise<SendResult> {
  const sub = await d.subscriber(to);
  const message: AddressedAlert = { chainId: d.chainId, wallet: account, ...(to !== account ? { to } : {}), alert };
  const rendered = renderTelegramAlert(message, { locale: sub?.locale ?? null, chainName: String(d.chainId), appOrigin: d.appOrigin });
  let outcome: DeliveryOutcome;
  try {
    outcome = await d.notify({
      telegram: { diamond: d.diamond, message },
      pushSubscriber: sub?.push ? to : null,
      text: rendered.text,
      pushTitle: rendered.title,
      deepLinkUrl: d.appOrigin,
    });
  } catch (err) {
    if (err instanceof PastRunDeadline || err instanceof EpochFenceRefusal) throw err;
    // A send that threw (the network) may go on another try.
    outcome = { telegram: 'retry', push: 'off' };
  }
  if (delivered(outcome)) return 'sent';
  return worthRetrying(outcome) ? 'retry' : 'nobody';
}
