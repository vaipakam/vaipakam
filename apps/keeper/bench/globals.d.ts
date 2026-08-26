/**
 * The two Node globals this harness uses.
 *
 * The keeper's tsconfig is Workers-typed (`types: ["@cloudflare/workers-types"]`,
 * no `@types/node`), and pulling in a whole Node type package for a profiling
 * script is not worth the dependency. Declaring exactly what is used keeps
 * `bench/` inside the SAME `tsc -p .` run as `src/` — which is the point:
 * a harness excluded from typecheck rots silently, and this one already
 * shipped two defects that a reader would have caught.
 */
declare const process: {
  readonly env: Record<string, string | undefined>;
  cpuUsage(previous?: { user: number; system: number }): {
    user: number;
    system: number;
  };
  exit(code: number): never;
};
