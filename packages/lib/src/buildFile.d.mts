export declare function buildFileBody(opts?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  git?: (args: string[]) => string;
}): string;

export declare function buildFilePlugin(opts?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  git?: (args: string[]) => string;
}): {
  name: string;
  apply: 'build';
  generateBundle(this: { environment?: { name: string }; emitFile(f: { type: 'asset'; fileName: string; source: string }): string }): void;
};
