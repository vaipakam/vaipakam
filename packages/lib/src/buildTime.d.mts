export type BuildSourceTime = {
  iso: string;
  source: 'SOURCE_DATE_EPOCH' | 'commit' | 'clock';
  reproducible: boolean;
  reason?: string;
};

export declare function buildSourceTime(opts?: { cwd?: string; env?: Record<string, string | undefined>; git?: (args: string[]) => string; now?: () => Date }): BuildSourceTime;

export declare function buildCommitLabel(opts?: { cwd?: string; git?: (args: string[]) => string }): string;
