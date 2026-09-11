/**
 * The file suffixes the deploy-invocation sweep yields, in one importable
 * place.
 *
 * WHY THIS IS A MODULE (#2132 r7). These two arrays used to sit inside
 * `check-deploy-invocations.mjs`, and the test that pins the fixture table
 * against them had to go and FIND them in the source: first a regex over
 * quoted strings, then comment-stripping, then evaluating the initialiser.
 * Each version was wrong about membership in a new way — line-start comments,
 * trailing comments, double quotes, backticks, and finally a commented-out
 * `export const EXTENSIONS = [...]` shadowing the live one, which the evaluator
 * happily evaluated instead.
 *
 * Six corners is not a nearly-finished pattern match; it is the wrong
 * instrument. Exporting the values ends the family outright: the test now
 * imports exactly what the scanner uses, so "the list the test checks" and
 * "the list the scanner reads" are the same object rather than two readings
 * of one file.
 *
 * Kept side-effect free ON PURPOSE — the scanner itself cannot be imported,
 * because it scans and calls `process.exit` at module load. This file must
 * stay that way or the test goes back to guessing.
 */
export const SHELL_EXTENSIONS = ['.sh', '.bash', '.zsh', '.ksh'];
export const EXTENSIONS = [
  ...SHELL_EXTENSIONS,
  '.md',
  // `.mdx` is handled everywhere `.md` is — the markdown branch tests for it —
  // but `walk` never yielded the file, so that handling was unreachable and an
  // MDX runbook was not opened at all (#1995 r16).
  '.mdx',
  '.ts',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.js',
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
  // Windows deployment helpers. `walk` never yielded these, so a
  // `deploy.ps1` beside a protected worker was not opened at all — even
  // though workflow BODIES under pwsh/cmd were already modelled (#1995 r17).
  // A standalone `.py` helper can carry an argv deploy that `ARGV_DEPLOY_RE`
  // already recognises — the detector existed, the walk simply never yielded
  // the file (#1995 r22).
  '.py',
  // `makefileBlocks` has always matched `*.mk`, and the walk never yielded one
  // — so that branch was unreachable and an included deploy fragment was read
  // as prose, while the identical content named `Makefile` was rejected
  // (#1995 r23). The third time a handled extension was not a WALKED one, after
  // `.mdx` and `.py`.
  '.mk',
  '.ps1',
  '.cmd',
  '.bat',
];
