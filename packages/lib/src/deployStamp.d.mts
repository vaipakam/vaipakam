export declare const DEPLOY_TAG: RegExp;

export type DeployStamp = { commit: string; dirty: boolean; tag: string; message: string } | { reason: string };

export declare function deployStamp(opts?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  git?: (args: string[]) => string;
}): DeployStamp;

export declare function deployStampArgs(stamp: DeployStamp): string[];
