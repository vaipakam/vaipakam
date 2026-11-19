/**
 * EIP-7702 delegation watch (#3434 part 2).
 *
 * A vault is only as safe as its owner's wallet. One "upgrade your account"
 * signature — an EIP-7702 authorization — makes the wallet run another
 * contract's code with the wallet's own authority, so whoever controls that
 * code can do everything the owner can, including on the owner's vault.
 *
 * This pass reads, for each owner who linked an alert channel
 * (`user_thresholds`), the wallet's code on each chain, and tells the owner
 * when it CHANGES: a delegation appears, moves to another contract, or is
 * removed. The first reading of a wallet already delegated is told once
 * too, since the owner may not know. It never blocks anything, on chain or
 * in the app (issue #3434's recommendation: warn, never block).
 *
 * What it reads with, and what it does not promise:
 *
 *   - **Code from a verified endpoint.** Each chain's RPC is asked which
 *     chain it serves before its answers are believed, and every wallet's
 *     code in a tick goes in ONE batched JSON-RPC request. A wallet whose
 *     code could not be read keeps its last reading and is asked again.
 *   - **Rotation, not a sweep.** At most {@link WALLETS_PER_CHAIN} wallets a
 *     chain per tick, the least recently checked first, so a change is
 *     noticed within one lap of the watched set, not at once.
 *   - **At most once.** The new reading is stored whatever the rails
 *     answered; a failed send is logged and not retried. English only.
 */
import { createPublicClient, http, type Address } from 'viem';
import { delegationKey, readDelegation } from '@vaipakam/lib/delegation7702';
import { isRpcIdentityVerified, verifyRpcChainIdentity } from '@vaipakam/lib/rpcIdentity';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { sendPush } from '@vaipakam/push';
import type { Env } from './env';
import { getChainConfigs } from './env';
import { pushRailConfigOf } from './pushRail';
import { sendMessage } from './telegram';
import { stateStub } from './telegramState/object';
import type { ChatRoute } from './telegramState/store';
import { withAlertPhrase } from '@vaipakam/lib/alertPhrase';

/** Outbound requests this pass may make in one tick, across every chain. */
export const MAX_SUBREQUESTS_PER_TICK = 10;

/** Wallets whose code one chain reads per tick (one batched request). */
export const WALLETS_PER_CHAIN = 50;

/** One watched wallet: its Push opt-in and its last stored reading (null
 *  when it was never read). */
export interface WatchedWallet {
  wallet: string;
  push: boolean;
  stored: string | null;
}

/** What to tell the owner when the stored reading `from` becomes `to`, or
 *  null when the change is nothing to tell (no change, or contract code,
 *  which is not a delegated wallet). */
export function delegationNotice(
  wallet: string,
  chainName: string,
  from: string | null,
  to: string,
): { title: string; body: string } | null {
  if (from === to) return null;
  if (to === 'contract') return null;
  if (to === '') {
    // Removed: worth saying only when there was a delegation before.
    if (from === null || from === '' || from === 'contract') return null;
    return {
      title: 'Your wallet delegation was removed',
      body: `The EIP-7702 delegation of your wallet ${wallet} on ${chainName} was removed. It is a plain wallet again.`,
    };
  }
  return {
    title: 'Your wallet now runs another contract’s code',
    body:
      `Your wallet ${wallet} on ${chainName} is delegated (EIP-7702) to the contract ${to}. ` +
      `That contract can act as your wallet, including on your Vaipakam vault. ` +
      `If you did not set this up, treat the wallet as compromised and turn on protected mode in the app, so payouts from your vault wait before they leave.`,
  };
}

export interface DelegationDeps {
  db: D1Database;
  /** Each wallet's code in one request; null when the read failed. A wallet
   *  absent from the map could not be read. */
  readCodes: (wallets: Address[]) => Promise<Map<string, `0x${string}` | undefined> | null>;
  readCostsAProbe: () => boolean;
  /** The chat and alert phrase (#3346) of each pair, or null. */
  routesOf: (pairs: { wallet: string; chainId: number }[]) => Promise<(ChatRoute | null)[]>;
  sendTelegram: ((chat: string, text: string) => Promise<string>) | null;
  sendPush: ((wallet: string, title: string, body: string, link: string) => Promise<'accepted' | 'failed' | 'not-requested'>) | null;
  link: string;
}

/** One chain's step. Returns the number of owners told. */
export async function runDelegationWatchChain(
  deps: DelegationDeps,
  chain: { id: number; name: string },
  budget: { remaining: number },
  nowSec: number,
): Promise<number> {
  // The read, the code batch (and maybe its probe), the chats, the write.
  const opening = 4 + (deps.readCostsAProbe() ? 1 : 0);
  if (budget.remaining < opening) return 0;
  budget.remaining -= 1;
  const res = await deps.db
    .prepare(
      `SELECT t.wallet AS wallet, t.push_channel AS push_channel, d.delegation AS delegation
         FROM user_thresholds t
         LEFT JOIN owner_delegation d ON d.chain_id = t.chain_id AND d.wallet = t.wallet
        WHERE t.chain_id = ?
        ORDER BY COALESCE(d.checked_at, 0), t.wallet
        LIMIT ?`,
    )
    .bind(chain.id, WALLETS_PER_CHAIN)
    .all<{ wallet: string; push_channel: string | null; delegation: string | null }>();
  const watched: WatchedWallet[] = (res.results ?? []).map((r) => ({
    wallet: r.wallet.toLowerCase(),
    push: Boolean(r.push_channel),
    stored: r.delegation,
  }));
  if (watched.length === 0) return 0;

  budget.remaining -= deps.readCostsAProbe() ? 2 : 1;
  const codes = await deps.readCodes(watched.map((w) => w.wallet as Address));
  if (!codes) return 0; // nothing read: every wallet keeps its reading

  const read = watched.flatMap((w) => {
    if (!codes.has(w.wallet)) return [];
    return [{ ...w, now: delegationKey(readDelegation(codes.get(w.wallet))) }];
  });
  const notices = read.flatMap((w) => {
    const n = delegationNotice(w.wallet, chain.name, w.stored, w.now);
    return n ? [{ w, n }] : [];
  });

  let told = 0;
  if (notices.length > 0) {
    let chats: (ChatRoute | null)[] = notices.map(() => null);
    if (deps.sendTelegram) {
      budget.remaining -= 1;
      try {
        chats = await deps.routesOf(notices.map(({ w }) => ({ wallet: w.wallet, chainId: chain.id })));
      } catch (err) {
        console.error(`[delegationWatch] chain=${chain.name}: the chat lookup failed (${describeFailure(err)}); no Telegram this tick`);
      }
    }
    for (let i = 0; i < notices.length; i++) {
      const { w, n } = notices[i]!;
      const chat = chats[i] ?? null;
      const cost = (chat && deps.sendTelegram ? 1 : 0) + (w.push && deps.sendPush ? 1 : 0);
      // One request stays for the write. A notice the allowance cannot carry
      // leaves that wallet's reading unwritten, so the next lap tells it.
      if (budget.remaining - 1 < cost) {
        read.splice(read.indexOf(w as never), 1);
        continue;
      }
      let accepted = false;
      if (chat && deps.sendTelegram) {
        budget.remaining -= 1;
        const text = withAlertPhrase(`${n.title}\n${n.body}\n${deps.link}`, chat.phrase);
        accepted = (await deps.sendTelegram(chat.chat, text).catch(() => 'failed')) === 'accepted' || accepted;
      }
      if (w.push && deps.sendPush) {
        const out = await deps.sendPush(w.wallet, n.title, n.body, deps.link).catch(() => 'failed' as const);
        if (out !== 'not-requested') budget.remaining -= 1;
        accepted = out === 'accepted' || accepted;
      }
      if (accepted) told += 1;
      else console.warn(`[delegationWatch] chain=${chain.name}: a delegation notice reached no channel; it is not retried`);
    }
  }

  if (read.length > 0) {
    budget.remaining -= 1;
    await deps.db.batch(
      read.map((w) =>
        deps.db
          .prepare(
            `INSERT INTO owner_delegation (chain_id, wallet, delegation, checked_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(chain_id, wallet) DO UPDATE SET delegation = excluded.delegation, checked_at = excluded.checked_at`,
          )
          .bind(chain.id, w.wallet, w.now, nowSec),
      ),
    );
  }
  return told;
}

/** The Worker's wiring. */
export async function runDelegationWatch(env: Env): Promise<void> {
  const chains = getChainConfigs(env);
  if (chains.length === 0) return;
  const budget = { remaining: MAX_SUBREQUESTS_PER_TICK };
  const nowSec = Math.floor(Date.now() / 1000);
  const link = env.FRONTEND_ORIGIN.split(',')[0]!.trim();
  const token = env.TG_BOT_TOKEN;
  const pushSigner = env.PUSH_CHANNEL_PK;
  const pushRail = pushRailConfigOf(env);
  for (const chain of chains) {
    // Batched: every getCode of the tick travels in one HTTP request.
    const client = createPublicClient({
      transport: http(chain.rpc, { retryCount: 0, timeout: 8_000, batch: { batchSize: WALLETS_PER_CHAIN, wait: 0 } }),
    });
    const deps: DelegationDeps = {
      db: env.DB,
      readCostsAProbe: () => !isRpcIdentityVerified(chain.id, chain.rpc),
      readCodes: async (wallets) => {
        const identity = await verifyRpcChainIdentity(client, chain.id, chain.rpc, 'delegationWatch');
        if (!identity.ok) return null;
        const answers = await Promise.allSettled(wallets.map((address) => client.getCode({ address })));
        const out = new Map<string, `0x${string}` | undefined>();
        answers.forEach((a, i) => {
          if (a.status === 'fulfilled') out.set(wallets[i]!.toLowerCase(), a.value);
        });
        return out.size === 0 ? null : out;
      },
      routesOf: (pairs) => stateStub(env).routesOf(pairs),
      sendTelegram: token ? (chat, text) => sendMessage(token, chat, text) : null,
      sendPush: pushSigner
        ? (subscriber, title, body, deepLinkUrl) =>
            sendPush({ ...pushRail, channelPk: pushSigner }, { subscriber, title, body, deepLinkUrl })
        : null,
      link,
    };
    try {
      await runDelegationWatchChain(deps, chain, budget, nowSec);
    } catch (err) {
      console.error(`[delegationWatch] chain=${chain.name} failed: ${describeFailure(err)}`);
    }
  }
}
