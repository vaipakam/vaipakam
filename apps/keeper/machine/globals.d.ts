/**
 * The Node globals the machine runner uses — declared here, scoped to
 * machine/, for the reason bench/globals.d.ts gives: the keeper's src/ is
 * Workers-typed, and an accidental `process` in src/** must keep failing its
 * typecheck. machine/ is its own `tsc` program (machine/tsconfig.json).
 */
declare const process: {
  readonly env: Record<string, string | undefined>;
  readonly argv: readonly string[];
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  exit(code: number): never;
};
