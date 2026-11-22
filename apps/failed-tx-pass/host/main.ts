/**
 * The failed transaction pass on the keeper machine (#3919): one run over
 * every configured network, then exit. A systemd timer starts it every five
 * minutes (deploy/vaipakam-failed-tx.timer); it holds no signing key and no
 * database binding, and writes only through the indexer's
 * `/internal/failed-tx` route under its own token.
 *
 * Configuration is the environment (deploy/failed-tx.env.example):
 *   INDEXER_ORIGIN            the indexer's origin
 *   FAILED_TX_WRITER_TOKEN    the writer token (also a secret on the indexer)
 *   FAILED_TX_CHAINS          chain ids to run, comma separated
 *   RPC_<SLUG>                each network's node endpoint (RPC_BASE_SEPOLIA, ...)
 *   EXPLORER_API_KEY          one Etherscan v2 key, for list-and-audit networks
 *   EXPLORER_API_BASE         optional, default https://api.etherscan.io/v2/api
 *   CAPABILITY_RESULTS_DIR    the node capability check's results (#3913)
 *   TG_OPS_BOT_TOKEN, TG_OPS_CHAT_ID   optional: the operator chat for alerts
 *   STATE_DIRECTORY           set by systemd: where alert repeats are remembered
 *
 * No endpoint, key or token is ever printed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { codeNamesFromDeployment } from '@vaipakam/lib/txExplainer';
import { planFor, type CapabilityResult } from '../src/chains';
import { txlistExplorer } from '../src/explorer';
import { indexerClient } from '../src/indexer';
import { defaultSettings, runChain, type Finding, type RunResult } from '../src/pass';
import { jsonRpc } from '../src/rpc';

const env = (k: string): string | undefined => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};
const need = (k: string): string => {
  const v = env(k);
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

/** An alert is sent again only after this long, while its condition lasts. */
const REPEAT_SECONDS = 6 * 3600;

async function sendAlerts(findings: Finding[], now: number): Promise<void> {
  const alerts = findings.filter((f) => f.level === 'alert');
  const token = env('TG_OPS_BOT_TOKEN');
  const chat = env('TG_OPS_CHAT_ID');
  const dir = env('STATE_DIRECTORY');
  const file = dir ? join(dir, 'alerts-sent.json') : undefined;
  let sent: Record<string, number> = {};
  if (file && existsSync(file)) {
    try {
      sent = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>;
    } catch {
      sent = {};
    }
  }
  const due = alerts.filter((a) => now - (sent[`${a.chainId}:${a.key}`] ?? 0) >= REPEAT_SECONDS);
  for (const a of alerts) process.stdout.write(`ALERT ${a.text}\n`);
  if (due.length && token && chat) {
    const text = ['Failed transaction pass', ...due.map((a) => `• ${a.text}`)].join('\n').slice(0, 4000);
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) for (const a of due) sent[`${a.chainId}:${a.key}`] = now;
      else process.stdout.write(`the operator chat refused the alert (HTTP ${res.status})\n`);
    } catch (e) {
      process.stdout.write(`the operator chat did not answer (${e instanceof Error ? e.name : 'error'})\n`);
    }
  }
  if (file) {
    // Forget conditions that have cleared, so a recurrence alerts at once.
    const live = new Set(alerts.map((a) => `${a.chainId}:${a.key}`));
    for (const k of Object.keys(sent)) if (!live.has(k)) delete sent[k];
    mkdirSync(dir!, { recursive: true });
    writeFileSync(file, JSON.stringify(sent));
  }
}

function summary(r: RunResult): string {
  const parts = [`chain ${r.chainId} (${r.mode})`];
  if (r.scanned) parts.push(`scanned ${r.scanned.from}-${r.scanned.to}`);
  parts.push(`${r.records} record(s)`);
  if (r.audited) parts.push(`audit ${r.audited.from}-${r.audited.to}: ${r.audited.found} found, ${r.audited.missed} missed`);
  if (r.held) parts.push(`HELD: ${r.held}`);
  return parts.join('; ');
}

async function main(): Promise<number> {
  const indexer = indexerClient({ origin: need('INDEXER_ORIGIN'), token: need('FAILED_TX_WRITER_TOKEN') });
  const resultsDir = need('CAPABILITY_RESULTS_DIR');
  const apiKey = env('EXPLORER_API_KEY');
  const apiBase = env('EXPLORER_API_BASE') ?? 'https://api.etherscan.io/v2/api';
  const chains = need('FAILED_TX_CHAINS')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!chains.length) throw new Error('FAILED_TX_CHAINS names no chain');

  const now = () => Math.floor(Date.now() / 1000);
  const findings: Finding[] = [];
  let failed = 0;
  // Networks run concurrently and independently: one network's failure never stops another's.
  const runs = await Promise.allSettled(
    chains.map(async (chainId) => {
      const dep = getDeployment(chainId);
      if (!dep) throw new Error(`chain ${chainId} has no deployment record`);
      const slug = String((dep as unknown as { chainSlug?: string }).chainSlug ?? chainId);
      const cap = JSON.parse(readFileSync(join(resultsDir, `${slug}.json`), 'utf8')) as CapabilityResult;
      if (cap.chainId !== chainId) throw new Error(`${slug}.json is for chain ${cap.chainId}, not ${chainId}`);
      const plan = planFor(cap, apiKey !== undefined);
      const rpcVar = `RPC_${slug.toUpperCase().replace(/-/g, '_')}`;
      const rpc = jsonRpc(need(rpcVar));
      const explorer = plan.mode === 'list-and-audit' && apiKey ? txlistExplorer({ apiBase, apiKey, chainId }) : undefined;
      return runChain({
        plan,
        rpc,
        ...(explorer ? { explorer } : {}),
        indexer,
        nameOf: codeNamesFromDeployment(dep as unknown as Parameters<typeof codeNamesFromDeployment>[0]),
        settings: defaultSettings(plan),
        now,
        random: () => randomInt(0, 1_000_000) / 1_000_000,
      });
    }),
  );
  runs.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      process.stdout.write(`${summary(r.value)}\n`);
      for (const f of r.value.findings) if (f.level === 'note') process.stdout.write(`note: ${f.text}\n`);
      findings.push(...r.value.findings);
    } else {
      failed++;
      const msg = r.reason instanceof Error ? r.reason.message : 'unknown failure';
      process.stdout.write(`chain ${chains[i]}: FAILED: ${msg}\n`);
      findings.push({ chainId: chains[i]!, level: 'alert', key: 'run-failed', text: `Chain ${chains[i]}: the failed transaction pass failed (${msg}).` });
    }
  });
  await sendAlerts(findings, now());
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`failed-tx-pass: ${e instanceof Error ? e.message : 'unknown failure'}\n`);
    process.exit(1);
  },
);
