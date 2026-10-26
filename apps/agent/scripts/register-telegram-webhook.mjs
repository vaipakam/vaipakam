#!/usr/bin/env node
/**
 * Register the agent's Telegram webhook WITH its secret (#2753).
 *
 * The agent refuses every `/tg/webhook` request that does not carry the
 * `X-Telegram-Bot-Api-Secret-Token` header Telegram sends when the webhook
 * was registered with a `secret_token`. The secret is derived from the bot
 * token (HMAC-SHA256 keyed by the token over a fixed label, in hex —
 * `webhookSecret` in `src/telegram.ts`), so this script computes it from the
 * token and registers both in one call. Run it after creating the bot, after
 * every token rotation, and once after the agent first ships the check:
 * until then Telegram's deliveries carry no secret and are refused.
 *
 * The token is never an argument: it is prompted for with the echo off, or
 * read from standard input when that is not a terminal
 * (`pass show tg-bot | node scripts/register-telegram-webhook.mjs`). It goes
 * into the request URL inside this process only, so it reaches neither shell
 * history nor the process list.
 *
 * Usage: node scripts/register-telegram-webhook.mjs [--url <webhook url>]
 * The URL defaults to the production agent.
 */
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** Keep equal to `WEBHOOK_SECRET_LABEL` in src/telegram.ts; the agent test
 *  `webhookSecret.test.ts` pins the two derivations to one value. */
export const WEBHOOK_SECRET_LABEL = 'vaipakam-telegram-webhook-v1';

export const DEFAULT_WEBHOOK_URL = 'https://agent.vaipakam.com/tg/webhook';

export function webhookSecretFor(botToken) {
  return createHmac('sha256', botToken).update(WEBHOOK_SECRET_LABEL).digest('hex');
}

async function readToken() {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  stderr.write('Bot token (input hidden): ');
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stderr.write('\n');
          resolve(value.trim());
          return;
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('cancelled'));
          return;
        }
        if (c === '\u007f') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function telegram(token, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok !== true) {
    // Telegram's description never echoes the token; the URL is not printed.
    throw new Error(`${method} failed: ${res.status} ${body.description ?? ''}`.trim());
  }
  return body.result;
}

async function main() {
  const args = process.argv.slice(2);
  let url = DEFAULT_WEBHOOK_URL;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) url = args[++i];
    else throw new Error(`unknown argument: ${args[i]} (the token is never an argument)`);
  }
  if (!url.startsWith('https://')) throw new Error('the webhook URL must be https');

  const token = await readToken();
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new Error('that does not look like a bot token (expected <id>:<secret>)');
  }

  await telegram(token, 'setWebhook', { url, secret_token: webhookSecretFor(token) });
  const info = await telegram(token, 'getWebhookInfo');
  process.stdout.write(
    `Webhook registered with its secret.\n  url: ${info.url}\n  pending updates: ${info.pending_update_count}\n` +
      (info.last_error_message ? `  last delivery error: ${info.last_error_message}\n` : ''),
  );
  if (info.url !== url) throw new Error(`Telegram reports ${info.url}, not ${url}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
