import type { SpawnSyncReturns, StdioOptions } from 'node:child_process';

export declare const DEPLOY_TAG: RegExp;

export type DeployStamp = { commit: string; dirty: boolean; tag: string; message: string } | { reason: string };

export declare function deployStamp(opts?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  git?: (args: string[]) => string;
}): DeployStamp;

export declare function deployStampArgs(stamp: DeployStamp): string[];

/** The JavaScript entry of the wrangler the package at `cwd` declares (its `bin.wrangler`). */
export declare function wranglerEntry(cwd: string): string;

export declare function deployMode(env?: Record<string, string | undefined>): { mode: 'live' | 'upload' } | { reason: string };

export declare function wranglerRun(
  subcommand: string[],
  args: string[],
  opts?: { cwd?: string; stamp?: DeployStamp; stdio?: StdioOptions },
): SpawnSyncReturns<Buffer>;

export declare function wranglerDeploy(
  args: string[],
  opts?: { cwd?: string; stamp?: DeployStamp; stdio?: StdioOptions },
): SpawnSyncReturns<Buffer>;
