/**
 * The Node globals the machine runtime uses, and nothing more.
 *
 * The keeper is Workers-typed and carries no `@types/node`; declaring the
 * handful of members `host/` touches keeps this program typechecked without
 * a Node type package, the same choice `bench/globals.d.ts` makes.
 */
declare const process: {
  readonly env: Record<string, string | undefined>;
  readonly pid: number;
  readonly argv: readonly string[];
  exitCode: number | undefined;
  exit(code?: number): never;
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
};
